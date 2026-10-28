import { useCallback, useEffect, useMemo, useState } from 'react';
import { getResourceDef, resourceDescription } from '@kudesi/shared';
import { AppbarHint, useAppbarBare, useHasAppbarSlot } from '../layout/AppbarSlot';
import { PageHint } from './PageHint';
import { ApiError } from '../api/client';
import { resourceApi, type ResourceDto } from './api';
import { loadAll, clearTreeNodes } from './treeNodes';
import { clearRefCache, RecordForm } from './RecordForm';
import { RecordDetail } from './RecordDetail';
import { ReasonDialog } from './TreeManage';
import { LocationPane } from './LocationPane';
import { LocationTree, type QuickAdd } from './LocationTree';
import { buildModel, defaultChildType, searchKeys, type ArchiveRow, type AssetRow, type LocRow } from './locationModel';
import { useResourceCan } from './useResourceCan';

const locDef = getResourceDef('locations')!;
const archiveDef = getResourceDef('archives')!;
const assetDef = getResourceDef('fixed-assets')!;

const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
const toLoc = (r: ResourceDto): LocRow => ({ id: r.id, title: r.title, status: r.status, parentId: num(r.data.parentId), scope: String(r.data.scope ?? 'area'), locationType: String(r.data.locationType ?? ''), fixedAssetId: num(r.data.fixedAssetId), code: String(r.data.code ?? ''), sort: Number(r.data.sort) || 0, description: String(r.data.description ?? '') });
const toAsset = (r: ResourceDto): AssetRow => ({ id: r.id, title: r.title, status: r.status, assetNo: String(r.data.assetNo ?? ''), locationId: num(r.data.locationId), userLabel: r.refLabels.userId ?? '', categoryLabel: r.refLabels.categoryId ?? '' });
const RELATED = ['licenseId', 'storeId', 'bankAccountId', 'fixedAssetId', 'partnerId', 'trademarkId', 'qualificationId', 'taxProfileId'];
const toArchive = (r: ResourceDto): ArchiveRow => ({
  id: r.id, title: r.title, status: r.status, archiveNo: String(r.data.archiveNo ?? ''), archiveType: String(r.data.archiveType ?? ''), locationId: num(r.data.locationId),
  keeperLabel: r.refLabels.keeperUserId ?? '', relatedLabel: RELATED.map((k) => r.refLabels[k]).find(Boolean) ?? '',
});

/**
 * 房间与档案位置的层级工作台：左边是 房间 → 柜子 → 层位/抽屉 的树，右边是选中位置里的内容（下级位置、固定资产、档案）。
 * 新增、改名、排序、停用、删除、档案借出遗失都能直接办；要看全部字段或批量处理，切到“表格”。
 */
export function LocationBoard() {
  const hasAppbar = useHasAppbarSlot();
  useAppbarBare();
  const canLoc = useResourceCan('locations');
  const canArchive = useResourceCan('archives');
  const canAsset = useResourceCan('fixed-assets');
  const [locs, setLocs] = useState<LocRow[] | null>(null);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [archives, setArchives] = useState<ArchiveRow[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [kw, setKw] = useState('');
  const [manage, setManage] = useState(false);
  const [quick, setQuick] = useState<QuickAdd | null>(null);
  const [detail, setDetail] = useState<{ type: 'locations' | 'archives' | 'fixed-assets'; id: number } | null>(null);
  const [form, setForm] = useState<{ type: 'archives'; initial: Record<string, unknown> } | null>(null);
  const [deleting, setDeleting] = useState<{ key: string; id: number; title: string; kids: number } | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [version, setVersion] = useState(0);

  const reload = useCallback((message?: string) => { if (message) setMsg(message); clearTreeNodes('locations'); clearRefCache('locations'); setVersion((v) => v + 1); }, []);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [l, a, r] = await Promise.all([
        loadAll('locations'),
        canAsset('view') ? loadAll('fixed-assets').catch(() => [] as ResourceDto[]) : Promise.resolve([] as ResourceDto[]),
        canArchive('view') ? loadAll('archives', { showHidden: true }).catch(() => [] as ResourceDto[]) : Promise.resolve([] as ResourceDto[]),
      ]);
      if (!alive) return;
      setLocs(l.map(toLoc)); setAssets(a.map(toAsset)); setArchives(r.map(toArchive)); setError('');
    })().catch((e) => alive && setError(e instanceof ApiError ? e.message : '加载失败'));
    return () => { alive = false; };
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const model = useMemo(() => buildModel(locs ?? [], assets, archives, { showInactive }), [locs, assets, archives, showInactive]);
  const inactiveCount = (locs ?? []).filter((l) => l.status === 'inactive').length;
  const search = useMemo(() => searchKeys(model, kw), [model, kw]);
  useEffect(() => { if (selected && !model.nodes.has(selected)) setSelected(null); }, [model, selected]);

  async function quickSave(q: QuickAdd) {
    const parent = q.parentKey ? model.nodes.get(q.parentKey) ?? null : null;
    const values: Record<string, unknown> = { name: q.name.trim(), locationType: q.type };
    if (parent?.kind === 'asset') Object.assign(values, { scope: 'asset_space', fixedAssetId: parent.id });
    else if (parent?.kind === 'space') Object.assign(values, { scope: 'asset_space', parentId: parent.id, ...(parent.assetId ? { fixedAssetId: parent.assetId } : {}) });
    else if (parent?.kind === 'area') Object.assign(values, { scope: ['asset_slot', 'shelf', 'drawer', 'box'].includes(q.type) ? 'asset_space' : 'area', parentId: parent.id });
    else values.scope = 'area';
    const saved = await resourceApi.create('locations', values);
    setQuick(null);
    reload(`已新增「${saved.title}」`);
    setSelected(`l:${saved.id}`);
  }
  async function rename(key: string, name: string) {
    const n = model.nodes.get(key);
    if (!n || n.kind === 'asset' || n.kind === 'group') return;
    await resourceApi.update('locations', n.id, { name });
    reload();
  }
  async function reorder(key: string, dir: -1 | 1) {
    const n = model.nodes.get(key);
    if (!n) return;
    const sibs = (model.kids.get(n.parentKey) ?? []).map((k) => model.nodes.get(k)!).filter((x) => x.kind === n.kind || x.kind === 'area' || x.kind === 'space');
    const i = sibs.findIndex((x) => x.key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= sibs.length) return;
    const next = [...sibs];
    [next[i], next[j]] = [next[j], next[i]];
    const changes = next.map((x, idx) => ({ x, sort: (idx + 1) * 10 })).filter((c) => (c.x.kind === 'area' || c.x.kind === 'space') && c.x.sort !== c.sort);
    try { for (const c of changes) await resourceApi.update('locations', c.x.id, { sort: c.sort }); reload(); } catch (e) { setMsg(e instanceof ApiError ? e.message : '排序失败'); }
  }
  async function toggleInactive(key: string) {
    const n = model.nodes.get(key);
    if (!n || (n.kind !== 'area' && n.kind !== 'space')) return;
    try { await resourceApi.changeStatus('locations', n.id, n.status === 'inactive' ? 'normal' : 'inactive', n.status === 'inactive' ? undefined : '在位置页停用'); reload(); } catch (e) { setMsg(e instanceof ApiError ? e.message : '操作失败'); }
  }
  const askDelete = (key: string) => {
    const n = model.nodes.get(key);
    if (n && (n.kind === 'area' || n.kind === 'space')) setDeleting({ key, id: n.id, title: n.title, kids: model.kids.get(key)?.length ?? 0 });
  };

  const can = {
    editLoc: canLoc('edit'), createLoc: canLoc('create'), deleteLoc: canLoc('delete'),
    createArchive: canArchive('create'), statusArchive: canArchive('disable'), viewAssets: canAsset('view'),
  };
  const newArchive = (locationId: number) => setForm({ type: 'archives', initial: locationId ? { locationId } : {} });
  const quickStart = (parentKey: string | null) => {
    const parent = parentKey ? model.nodes.get(parentKey) ?? null : null;
    setQuick({ parentKey, name: '', type: defaultChildType(parent) });
    if (parentKey) setSelected(parentKey);
    setManage(true);
  };

  if (error) return <div role="alert" className="notice error m">{error}</div>;
  if (!locs) return <div className="res-loading" role="status"><span className="res-spin" aria-hidden="true" />加载中…</div>;

  const hint = <PageHint text={resourceDescription('locations') ?? ''} />;
  return (
    <div className="lb">
      {hasAppbar && <AppbarHint>{hint}</AppbarHint>}
      <div className="lb-bar">
        {!hasAppbar && hint}
        <span className="lb-bar-sum">{model.nodes.size} 个位置节点 · {archives.length} 份档案{inactiveCount > 0 && !showInactive ? ` · 另有 ${inactiveCount} 个已停用` : ''}</span>
        <span className="res-bar-gap" />
        {inactiveCount > 0 && <button type="button" className="res-btn" aria-pressed={showInactive} onClick={() => setShowInactive((v) => !v)}>{showInactive ? '隐藏停用' : `显示停用 ${inactiveCount}`}</button>}
        {can.createLoc && <button type="button" className="res-btn" onClick={() => quickStart(null)}>＋ 新增一级位置</button>}
        {can.createArchive && <button type="button" className="res-btn primary" onClick={() => newArchive(selected && model.nodes.get(selected)?.kind !== 'asset' ? model.nodes.get(selected)?.id ?? 0 : 0)}>＋ 新增档案</button>}
      </div>
      {msg && <div role="status" className="notice m between"><span>{msg}</span><button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setMsg('')}>✕</button></div>}
      <div className="lb-body">
        <LocationTree
          model={model}
          selected={selected}
          onSelect={(k) => { setSelected(k); setMobileOpen(false); }}
          kw={kw}
          onKw={setKw}
          search={search}
          manage={manage && (can.editLoc || can.createLoc)}
          canManage={can.editLoc || can.createLoc}
          onManage={setManage}
          quick={quick}
          onQuick={setQuick}
          onQuickStart={quickStart}
          onQuickSave={quickSave}
          onRename={rename}
          onReorder={reorder}
          onToggleInactive={toggleInactive}
          onDelete={askDelete}
          mobileOpen={mobileOpen}
          onMobileOpen={setMobileOpen}
        />
        <LocationPane
          model={model}
          selected={selected}
          onSelect={setSelected}
          archives={archives}
          can={can}
          onOpenLoc={(id) => setDetail({ type: 'locations', id })}
          onOpenAsset={(id) => setDetail({ type: 'fixed-assets', id })}
          onOpenArchive={(id) => setDetail({ type: 'archives', id })}
          onQuickAdd={quickStart}
          onNewArchive={newArchive}
          onToggleInactive={(n) => void toggleInactive(n.key)}
          onDelete={(n) => askDelete(n.key)}
          onChanged={reload}
        />
      </div>
      {detail && <RecordDetail def={detail.type === 'locations' ? locDef : detail.type === 'archives' ? archiveDef : assetDef} id={detail.id} onClose={() => setDetail(null)} onChanged={() => reload()} />}
      {form && <RecordForm def={archiveDef} record={null} initial={form.initial} onClose={() => setForm(null)} onSaved={(dto) => { setForm(null); reload(`已新增档案「${dto.title}」`); setDetail({ type: 'archives', id: dto.id }); }} />}
      {deleting && (
        <ReasonDialog
          title={`删除位置「${deleting.title}」`}
          hint={`删除后，放在这里的档案、固定资产和证照等资料的“存放位置”会被清空${deleting.kids ? `；它的 ${deleting.kids} 个下级位置会变成一级位置` : ''}。不想丢掉历史的话，可以改用“停用”。删除要写原因，会留在操作记录里。`}
          confirmLabel="确认删除"
          onClose={() => setDeleting(null)}
          onSubmit={async (reason) => { await resourceApi.remove('locations', deleting.id, reason); setDeleting(null); reload(`已删除「${deleting.title}」`); }}
        />
      )}
    </div>
  );
}
