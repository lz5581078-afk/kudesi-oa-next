import { useEffect, useMemo, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { ArchiveList } from './ArchiveList';
import { assetApi, type LocationContentGroup } from './api';
import { pathKeys, subtreeKeys, type ArchiveRow, type AssetRow, type BNode, type Model } from './locationModel';

const assetDef = getResourceDef('fixed-assets');
const assetLabel = (s: string) => assetDef?.statuses.find((x) => x.value === s)?.label ?? s;
const assetTone = (s: string) => assetDef?.statuses.find((x) => x.value === s)?.tone ?? 'muted';

/** 其他资料也把这个位置当存放位置（证照正副本、U 盾、手机号、开户档案…）：旧页面没有，这里补在下面。 */
function OtherUsage({ id }: { id: number }) {
  const [groups, setGroups] = useState<LocationContentGroup[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setGroups(null);
    assetApi.locationContents(id).then((g) => alive && setGroups(g.filter((x) => !['locations', 'archives', 'fixed-assets'].includes(x.type)))).catch((e) => alive && setError(e instanceof ApiError ? e.message : '加载失败'));
    return () => { alive = false; };
  }, [id]);
  if (error || !groups || groups.length === 0) return null;
  return (
    <section className="lb-sec">
      <h3>其他资料也放在这里</h3>
      {groups.map((g) => (
        <p key={g.type} className="lb-other"><strong>{g.typeLabel}（{g.items.length}）</strong>：{g.items.slice(0, 12).map((it) => `${it.title}${it.slots.length && !['存放位置', '位置'].includes(it.slots[0]) ? `（${it.slots.join('、')}）` : ''}`).join('、')}{g.items.length > 12 ? ' 等' : ''}</p>
      ))}
    </section>
  );
}

interface PaneProps {
  model: Model;
  /** null = 没选，显示全部档案 */
  selected: string | null;
  onSelect: (key: string | null) => void;
  archives: ArchiveRow[];
  can: { editLoc: boolean; createLoc: boolean; deleteLoc: boolean; createArchive: boolean; statusArchive: boolean; viewAssets: boolean };
  onOpenLoc: (id: number) => void;
  onOpenAsset: (id: number) => void;
  onOpenArchive: (id: number) => void;
  onQuickAdd: (parentKey: string | null) => void;
  onNewArchive: (locationId: number) => void;
  onToggleInactive: (n: BNode) => void;
  onDelete: (n: BNode) => void;
  onChanged: (message?: string) => void;
}

export function LocationPane(p: PaneProps) {
  const { model: m, selected } = p;
  const node = selected ? m.nodes.get(selected) ?? null : null;
  const [deep, setDeep] = useState(true);
  useEffect(() => setDeep(true), [selected]);

  const pathText = (key: string, from?: string) => {
    const keys = pathKeys(m, key);
    const start = from ? Math.max(0, keys.indexOf(from)) : 0;
    return keys.slice(start).map((k) => m.nodes.get(k)?.title ?? '').join(' / ');
  };
  const scope = useMemo(() => (node ? subtreeKeys(m, node.key) : []), [m, node]);
  const archives = useMemo(() => {
    if (!node) return p.archives;
    const keys = deep ? scope : [node.key];
    return keys.flatMap((k) => m.archivesAt.get(k) ?? []);
  }, [m, node, scope, deep, p.archives]);
  const locOfArchive = (a: ArchiveRow) => (a.locationId ? `l:${a.locationId}` : '');
  const where = (a: ArchiveRow) => {
    const k = locOfArchive(a);
    if (!m.nodes.has(k)) return '';
    return node ? pathText(k, node.key) : pathText(k);
  };

  // 全部档案
  if (!node) {
    const lost = p.archives.filter((a) => a.status === 'borrowed' || a.status === 'missing').length;
    return (
      <div className="lb-pane">
        <header className="lb-head">
          <div className="lb-title"><h2>全部档案</h2><span className="muted">共 {p.archives.length} 份{lost ? `，借出或遗失 ${lost} 份` : ''}。点左边的位置，看那里放了什么。</span></div>
        </header>
        <ArchiveList rows={p.archives} where={where} canStatus={p.can.statusArchive} onOpen={p.onOpenArchive} onChanged={p.onChanged} empty="还没有档案。点右上角“新增档案”，登记编号、关联资料和存放位置。" />
      </div>
    );
  }

  const kids = (m.kids.get(node.key) ?? []).map((k) => m.nodes.get(k)!).filter(Boolean);
  const assets: AssetRow[] = node.kind === 'area' ? (m.assetsAt.get(node.key) ?? []) : [];
  const deepArchives = m.deepArchives.get(node.key) ?? 0;
  const alerts = m.deepAlerts.get(node.key) ?? 0;
  const crumbs = pathKeys(m, node.key);
  const isLoc = node.kind === 'area' || node.kind === 'space';
  const canAddArea = node.kind === 'area' && p.can.createLoc;
  const canAddSpace = (node.kind === 'asset' || node.kind === 'space') && p.can.createLoc;

  return (
    <div className="lb-pane">
      <header className="lb-head">
        <div className="lb-title">
          <nav className="lb-crumbs" aria-label="位置路径">
            <button type="button" onClick={() => p.onSelect(null)}>全部</button>
            {crumbs.map((k) => <span key={k}><i aria-hidden="true">/</i><button type="button" onClick={() => p.onSelect(k)} aria-current={k === node.key ? 'true' : undefined}>{m.nodes.get(k)?.title}</button></span>)}
          </nav>
          <h2>{node.title}<span className="lb-tag">{node.kind === 'asset' ? '固定资产（柜子）' : node.tag}</span>{node.code && node.kind !== 'asset' && <span className="lb-tag soft">{node.code}</span>}{node.status === 'inactive' && <span className="pill warn">已停用</span>}</h2>
        </div>
        <div className="lb-acts">
          {node.kind === 'asset' && <button type="button" className="res-btn" onClick={() => p.onOpenAsset(node.id)}>资产详情</button>}
          {isLoc && <button type="button" className="res-btn" onClick={() => p.onOpenLoc(node.id)}>{p.can.editLoc ? '详情 / 编辑' : '详情'}</button>}
          {canAddArea && <button type="button" className="res-btn" onClick={() => p.onQuickAdd(node.key)}>新增下级位置</button>}
          {canAddSpace && <button type="button" className="res-btn" onClick={() => p.onQuickAdd(node.key)}>新增层位 / 抽屉</button>}
          {p.can.createArchive && isLoc && <button type="button" className="res-btn primary" onClick={() => p.onNewArchive(node.id)}>＋ 在这里放档案</button>}
          {isLoc && p.can.editLoc && <button type="button" className="res-btn" onClick={() => p.onToggleInactive(node)}>{node.status === 'inactive' ? '启用' : '停用'}</button>}
          {isLoc && p.can.deleteLoc && <button type="button" className="res-btn danger" onClick={() => p.onDelete(node)}>删除</button>}
        </div>
      </header>

      <div className="lb-stats">
        <div><strong>{kids.length}</strong><span>下级位置</span></div>
        {p.can.viewAssets && <div><strong>{m.deepAssets.get(node.key) ?? 0}</strong><span>固定资产（含下级）</span></div>}
        <div><strong>{deepArchives}</strong><span>档案（含下级）</span></div>
        <div className={alerts ? 'warn' : ''}><strong>{alerts}</strong><span>借出 / 遗失</span></div>
      </div>

      {kids.length > 0 && (
        <section className="lb-sec">
          <h3>{node.kind === 'asset' ? '储物空间' : node.kind === 'space' ? '下级层位 / 抽屉' : '下级位置'}（{kids.length}）</h3>
          <div className="lb-chips">
            {kids.map((c) => (
              <button key={c.key} type="button" className={c.status === 'inactive' ? 'lb-chip stopped' : 'lb-chip'} onClick={() => p.onSelect(c.key)}>
                <span>{c.title}</span><small>{c.kind === 'asset' ? c.tag : `${m.deepArchives.get(c.key) ?? 0} 份档案`}</small>
              </button>
            ))}
          </div>
        </section>
      )}
      {kids.length === 0 && (node.kind === 'asset' || node.kind === 'space') && (
        <p className="muted lb-empty">{node.kind === 'asset' ? '这项固定资产还没有储物空间。' : '这里没有下级了。'}{p.can.createLoc ? <> <button type="button" className="link-button" onClick={() => p.onQuickAdd(node.key)}>{node.kind === 'asset' ? '建立第一层 / 第一个抽屉' : '新增下级'}</button></> : null}</p>
      )}

      {p.can.viewAssets && node.kind === 'area' && (
        <section className="lb-sec">
          <h3>放在这里的固定资产（{assets.length}）</h3>
          {assets.length === 0 ? <p className="muted lb-empty">这个位置上没有直接放固定资产。</p> : (
            <div className="lb-table-wrap">
              <table className="lb-table">
                <thead><tr><th>资产</th><th>分类</th><th>使用人</th><th>状态</th><th>储物空间</th></tr></thead>
                <tbody>
                  {assets.map((a) => {
                    const own = m.kids.get(`a:${a.id}`)?.length ?? 0;
                    return (
                      <tr key={a.id} tabIndex={0} onClick={() => p.onOpenAsset(a.id)} onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === 'Enter') p.onOpenAsset(a.id); }}>
                        <td data-label="资产"><strong>{a.title}</strong><small className="muted"> {a.assetNo}</small></td>
                        <td data-label="分类">{a.categoryLabel || '—'}</td>
                        <td data-label="使用人">{a.userLabel || '—'}</td>
                        <td data-label="状态"><span className={`pill ${assetTone(a.status) === 'muted' ? 'warn' : assetTone(a.status)}`}>{assetLabel(a.status)}</span></td>
                        <td data-label="储物空间" onClick={(e) => e.stopPropagation()}>
                          {own ? <button type="button" className="link-button" onClick={() => p.onSelect(`a:${a.id}`)}>{own} 个，查看</button>
                            : p.can.createLoc ? <button type="button" className="link-button" onClick={() => p.onQuickAdd(`a:${a.id}`)}>建立</button> : <span className="muted">无</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="lb-sec">
        <h3>
          档案（{archives.length}）
          {scope.length > 1 && <label className="lb-deep"><input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} /> 含下级</label>}
        </h3>
        <ArchiveList rows={archives} where={where} canStatus={p.can.statusArchive} onOpen={p.onOpenArchive} onChanged={p.onChanged} searchable={archives.length > 6} empty={isLoc ? '这里还没有放档案。' : '这里的储物空间里还没有档案。'} />
      </section>
      {isLoc && <OtherUsage id={node.id} />}
    </div>
  );
}
