import { useEffect, useMemo, useState } from 'react';
import { getResourceDef, hasFeeDefaults, PARTY_SEED_CATEGORIES, resourceTabOptions, treeFilterField, type ResourceDef } from '@kudesi/shared';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useCategoryOptions } from './categoryOptions';
import { useUnitOptions } from './unitOptions';
import { resourceApi, type CategoryTreeResult, type ResourceDto } from './api';
import { ArchiveTypeDialog } from './ArchiveTypeDialog';
import { FeeSnapshotsDialog } from './FeeSnapshotsDialog';
import { ReasonDialog, clearRefCache } from './RecordForm';
import { useResourceCan } from './RecordDetail';
import { PageHint } from './PageHint';
import { resourceDescription } from '@kudesi/shared';

export interface HierEntry { key: string; title: string; subtitle: string; rootId?: number }

const ACCENTS = ['green', 'blue', 'orange', 'purple', 'teal'];
/** 商品档案顶级分类（档案类型）的说明，旧版同款文字 */
const TAB_BLURB: Record<string, string> = {
  raw: '种子、原料、辅料等采购和生产使用的商品资料。',
  self_made: '公司自有生产、加工和包装后的成品商品。',
  purchased: '外部采购后直接销售或组合销售的成品商品。',
  original_purchase: '原装采购后直接销售或组合销售的成品商品。',
  supplier_oem: '供应商按我方包装、品牌加工的 OEM 成品。',
  package: '包装袋、盒、箱、标签等包装类商品资料。',
  shipping_material: '纸箱、胶带、填充物、随货卡等发货环节使用的物料资料。',
  oem_package: '用于管理放在供应商那边的包装资料。',
};
const TAB_CODE: Record<string, string> = { raw: 'YL', self_made: 'ZC', original_purchase: 'WG', supplier_oem: 'WG', package: 'BZ', shipping_material: 'FH', oem_package: 'OEM' };

/** 商品档案的顶级入口：档案类型页签（含外购成品拆成的两个、公司自建的类型） */
export function useHierTabs(def: ResourceDef) {
  const catOptions = useCategoryOptions(def.key);
  const unitOpts = useUnitOptions();
  return useMemo(() => {
    const base = resourceTabOptions(def, catOptions?.filter((o) => !o.hidden));
    const custom = def.tabsBy === 'archiveType' ? (unitOpts.archive_type ?? []).filter((o) => !resourceTabOptions(def).some((b) => b.value === o.value)) : [];
    return [...base, ...custom];
  }, [def, catOptions, unitOpts]);
}

/** 顶级分类卡片页：每张卡片 = 一个顶级分类 + 数量 + 说明，点进去才是“左侧分类树 + 右侧列表”。 */
export function ArchiveHome({ type, onEnter }: { type: string; onEnter: (e: HierEntry) => void }) {
  const def = getResourceDef(type)!;
  const cfg = def.hierarchy!;
  const can = useResourceCan(type);
  const catType = cfg.categoryType ?? '';
  const catCan = useResourceCan(catType || type);
  const { user: me } = useAuth();
  const tabs = useHierTabs(def);
  const treeField = useMemo(() => treeFilterField(def), [def]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState<number | null>(null);
  const [tree, setTree] = useState<CategoryTreeResult | null>(null);
  const [cats, setCats] = useState<ResourceDto[]>([]);
  const [managing, setManaging] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const [snapshots, setSnapshots] = useState(false);
  const [draft, setDraft] = useState<{ id?: number; name: string; subtitle: string } | null>(null);
  const [deleting, setDeleting] = useState<ResourceDto | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const refresh = () => setReload((n) => n + 1);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await resourceApi.list(type, { pageSize: 1 });
        if (!alive) return;
        setCounts(r.tabCounts ?? {}); setTotal(r.total);
        if (cfg.kind === 'category' && treeField) {
          const [t, c] = await Promise.all([
            resourceApi.categoryTree(type, { field: treeField.key }),
            resourceApi.list(catType, { pageSize: 200, showHidden: false }),
          ]);
          if (!alive) return;
          setTree(t); setCats(c.items);
        }
        setError('');
      } catch (e) { if (alive) setError(e instanceof ApiError ? e.message : '加载失败'); }
    })();
    return () => { alive = false; };
  }, [type, cfg.kind, catType, treeField, reload]);

  const roots = useMemo(() => {
    if (cfg.kind !== 'category' || !tree) return [];
    const byId = new Map(cats.map((c) => [c.id, c]));
    return tree.nodes.filter((n) => n.parentId === 0).map((n) => ({ node: n, rec: byId.get(n.id) }));
  }, [cfg.kind, tree, cats]);

  // 供应商/客户的默认一级分类（旧程序自带）：空库首次进入自动建好，不用手点“导入默认分类”。每家公司每种档案只自动导入一次。
  useEffect(() => {
    if (cfg.kind !== 'category' || type === 'finance-fee-items' || !tree || !PARTY_SEED_CATEGORIES[catType as 'finance-supplier-categories']) return;
    if (roots.length > 0 || !catCan('create')) return;
    const flag = `kudesi.hier.autoseed.${me?.companyName ?? ""}.${catType}`;
    try { if (localStorage.getItem(flag)) return; localStorage.setItem(flag, '1'); } catch { /* 无本地存储时只做一次内存级尝试 */ }
    void seed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, roots.length]);

  const canManageRoots = cfg.kind === 'category' && catCan('edit');
  const move = async (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= roots.length) return;
    const next = [...roots]; [next[idx], next[j]] = [next[j], next[idx]];
    setBusy(true);
    try { for (let i = 0; i < next.length; i++) if (next[i].node.sort !== (i + 1) * 10) await resourceApi.update(catType, next[i].node.id, { sort: (i + 1) * 10 }); clearRefCache(catType); refresh(); }
    catch (e) { setError(e instanceof ApiError ? e.message : '排序失败'); }
    setBusy(false);
  };
  async function saveDraft(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || !draft.name.trim()) return;
    setBusy(true); setError('');
    try {
      const values = { name: draft.name.trim(), subtitle: draft.subtitle.trim() };
      if (draft.id) await resourceApi.update(catType, draft.id, values); else await resourceApi.create(catType, values);
      clearRefCache(catType); setDraft(null); refresh();
    } catch (er) { setError(er instanceof ApiError ? er.message : '保存失败'); }
    setBusy(false);
  }
  async function seed() {
    setBusy(true); setError('');
    try {
      if (type === 'finance-fee-items') {
        if (!window.confirm('把旧程序里的费用类别树和费用项目（约 380 项）导入进来？已经有的编号不会重复，也不会被覆盖。')) { setBusy(false); return; }
        const r = await api<{ categoriesCreated: number; itemsCreated: number }>('/finance/fee-archive/seed', { method: 'POST', body: {} });
        setMsg(`导入完成：新增费用类别 ${r.categoriesCreated} 个、费用项目 ${r.itemsCreated} 个。`);
      } else {
        const have = new Set((await resourceApi.list(catType, { pageSize: 200, showHidden: true })).items.map((i) => i.title));
        let n = 0;
        for (const [name, subtitle] of PARTY_SEED_CATEGORIES[catType as 'finance-supplier-categories']) if (!have.has(name)) { await resourceApi.create(catType, { name, subtitle }); n++; }
        setMsg(n ? `已导入 ${n} 个默认分类` : '默认分类都已经有了');
      }
      clearRefCache(catType); refresh();
    } catch (er) { setError(er instanceof ApiError ? er.message : '导入失败'); }
    setBusy(false);
  }

  const desc = resourceDescription(type);
  const seedable = cfg.kind === 'category' && can('create') && (type === 'finance-fee-items' ? hasFeeDefaults(me?.companyName) : Boolean(PARTY_SEED_CATEGORIES[catType as 'finance-supplier-categories']));
  const cards: Array<{ key: string; title: string; subtitle: string; count: number; foot: string; rootId?: number; rec?: ResourceDto; idx: number }> = cfg.kind === 'tab'
    ? tabs.map((t, i) => ({ key: t.value, title: t.label, subtitle: TAB_BLURB[t.value] ?? '公司自定义的档案类型。', count: counts[t.value] ?? 0, foot: `标识 ${TAB_CODE[t.value] ?? t.value}`, idx: i }))
    : roots.map((r, i) => ({ key: String(r.node.id), title: r.node.title, subtitle: String(r.rec?.data.subtitle ?? '') || `${def.label}分类维护。`, count: r.node.count, foot: '', rootId: r.node.id, rec: r.rec, idx: i }));

  return (
    <div className="res-page hier-home">
      <header className="hier-home-head">
        <div>
          <h1>{def.label}</h1>
        </div>
        <div className="hier-home-actions">
          {desc && <PageHint text={desc} />}
          {type === 'finance-fee-items' && <button type="button" className="res-btn" onClick={() => setSnapshots(true)}>费用存档表</button>}
          {cfg.kind === 'category' && <button type="button" className="res-btn" onClick={() => onEnter({ key: 'all', title: `全部${def.label.replace('档案', '')}`, subtitle: cfg.subtitle })}>查看全部{total !== null ? `（${total}）` : ''}</button>}
          {cfg.kind === 'tab' && can('edit') && <button type="button" className="res-btn" onClick={() => setTypesOpen(true)}>管理顶级分类</button>}
          {canManageRoots && <button type="button" className={managing ? 'res-btn on' : 'res-btn'} aria-pressed={managing} onClick={() => { setManaging(!managing); setDraft(null); }}>{managing ? '完成管理' : '管理顶级分类'}</button>}
          {managing && catCan('create') && <button type="button" className="res-btn primary" onClick={() => setDraft({ name: '', subtitle: '' })}>＋ 新增顶级分类</button>}
        </div>
      </header>
      {error && <div role="alert" className="notice error m">{error}</div>}
      {msg && <div role="status" className="notice m between"><span>{msg}</span><button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setMsg('')}>✕</button></div>}
      {draft && (
        <form className="hier-draft card" onSubmit={saveDraft}>
          <strong>{draft.id ? '编辑顶级分类' : '新增顶级分类'}</strong>
          <input autoFocus aria-label="分类名称" placeholder="分类名称（必填）" maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input aria-label="分类说明" placeholder={`分类说明，如“${cfg.kind === 'category' ? '该类' + def.label.replace('档案', '') + '的用途' : ''}”`} maxLength={200} value={draft.subtitle} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} />
          <button type="submit" className="res-btn primary" disabled={busy || !draft.name.trim()}>保存分类</button>
          <button type="button" className="res-btn" onClick={() => setDraft(null)}>取消</button>
        </form>
      )}
      <div className="hier-grid">
        {cards.map((c) => (
          <article key={c.key} className={`hier-card ${ACCENTS[c.idx % ACCENTS.length]}`} role="button" tabIndex={0}
            onClick={() => onEnter({ key: c.key, title: c.title, subtitle: c.subtitle, rootId: c.rootId })}
            onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onEnter({ key: c.key, title: c.title, subtitle: c.subtitle, rootId: c.rootId }); } }}>
            <span className="hier-card-name">{c.title}</span>
            <strong>{c.count}</strong>
            <small>{c.subtitle}</small>
            <em>{c.count} {cfg.unit}{c.foot ? ` · ${c.foot}` : ''}</em>
            {managing && c.rec && (
              <div className="hier-card-acts" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="res-btn sm" disabled={busy || c.idx === 0} aria-label={`前移：${c.title}`} onClick={() => void move(c.idx, -1)}>←</button>
                <button type="button" className="res-btn sm" disabled={busy || c.idx === cards.length - 1} aria-label={`后移：${c.title}`} onClick={() => void move(c.idx, 1)}>→</button>
                <button type="button" className="res-btn sm" onClick={() => setDraft({ id: c.rec!.id, name: c.rec!.title, subtitle: String(c.rec!.data.subtitle ?? '') })}>编辑</button>
                {catCan('delete') && <button type="button" className="res-btn sm danger-text" onClick={() => setDeleting(c.rec!)}>删除</button>}
              </div>
            )}
          </article>
        ))}
      </div>
      {cards.length === 0 && (
        <div className="res-empty">
          <p>暂无{def.hierarchy?.kind === 'tab' ? '档案类型' : `${def.label.replace('档案', '')}分类`}。{can('create') ? '可以先新增顶级分类，再逐级建立。' : ''}</p>
          {seedable && <button type="button" className="res-btn" disabled={busy} onClick={() => void seed()}>{type === 'finance-fee-items' ? '导入默认费用档案' : '导入默认分类'}</button>}
        </div>
      )}
      {typesOpen && <ArchiveTypeDialog counts={counts} onClose={() => setTypesOpen(false)} onChanged={refresh} />}
      {snapshots && <FeeSnapshotsDialog canWrite={can('create')} canDelete={can('delete')} onClose={() => setSnapshots(false)} onRestored={refresh} />}
      {deleting && (
        <ReasonDialog
          title={`删除「${deleting.title}」`}
          hint="下面还有下级分类或资料的顶级分类不能删除（会提示原因）。删除要写原因，会留在操作记录里。"
          confirmLabel="确认删除" danger
          onClose={() => setDeleting(null)}
          onConfirm={async (reason) => { await resourceApi.remove(catType, deleting.id, reason); clearRefCache(catType); setDeleting(null); refresh(); }}
        />
      )}
    </div>
  );
}
