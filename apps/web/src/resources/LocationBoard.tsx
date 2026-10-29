import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getResourceDef, resourceDescription } from '@kudesi/shared';
import { AppbarHint, useAppbarBare, useHasAppbarSlot } from '../layout/AppbarSlot';
import { PageHint } from './PageHint';
import { ApiError } from '../api/client';
import { resourceApi, type ResourceDto } from './api';
import { loadAll, loadTreeNodes, clearTreeNodes, type TreeNode } from './treeNodes';
import { clearRefCache, RecordForm } from './RecordForm';
import { RecordDetail } from './RecordDetail';
import { ReasonDialog } from './TreeManage';
import { LevelColumns, LevelCrumbs, type ColumnOps } from './LevelColumns';
import { StoragePicker } from './StoragePicker';
import { LocationArchives } from './LocationArchives';
import { buildColumns, buildIndex, defaultChildType, locationPathText, pathRows, type ArchiveRow, type AssetRow, type LocRow } from './locationColumns';
import { useResourceCan } from './useResourceCan';

const locDef = getResourceDef('locations')!;
const archiveDef = getResourceDef('archives')!;
const assetDef = getResourceDef('fixed-assets')!;

const AREA_TYPES = ['building', 'floor', 'room', 'cabinet'] as const;
const SPACE_TYPES = ['asset_slot', 'shelf', 'drawer', 'box'] as const;

const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
const toLoc = (r: ResourceDto): LocRow => ({ id: r.id, title: r.title, status: r.status, parentId: num(r.data.parentId), scope: String(r.data.scope ?? 'area'), locationType: String(r.data.locationType ?? ''), fixedAssetId: num(r.data.fixedAssetId), code: String(r.data.code ?? ''), sort: Number(r.data.sort) || 0 });
const toAsset = (r: ResourceDto): AssetRow => ({ id: r.id, title: r.title, status: r.status, assetNo: String(r.data.assetNo ?? ''), categoryId: num(r.data.categoryId), locationId: num(r.data.locationId), categoryLabel: r.refLabels.categoryId ?? '', locationLabel: r.refLabels.locationId ?? '' });
const RELATED = ['licenseId', 'storeId', 'bankAccountId', 'fixedAssetId', 'partnerId', 'trademarkId', 'qualificationId', 'taxProfileId'];
const toArchive = (r: ResourceDto): ArchiveRow => ({
  id: r.id, title: r.title, status: r.status, archiveNo: String(r.data.archiveNo ?? ''), archiveType: String(r.data.archiveType ?? ''), locationId: num(r.data.locationId),
  keeperLabel: r.refLabels.keeperUserId ?? '', relatedLabel: RELATED.map((k) => r.refLabels[k]).find(Boolean) ?? '',
});

type Mode = 'area' | 'storage';

/**
 * 房间与档案位置：纵向三块。
 * 上面“区域位置”按 办公楼 → 楼层 → 房间 一级级往右点开；中间“固定资产储物空间”先选固定资产，再逐级点开它里面的柜层、抽屉；
 * 下面是档案，跟着选中的位置过滤，行内办理借出/遗失/在库。要看全部字段或批量处理，切到“表格”。
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
  const [cats, setCats] = useState<TreeNode[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [mode, setMode] = useState<Mode>('area');
  const [areaId, setAreaId] = useState(0);
  const [catId, setCatId] = useState(0);
  const [assetId, setAssetId] = useState(0);
  const [spaceId, setSpaceId] = useState(0);
  const [manageArea, setManageArea] = useState(false);
  const [manageSpace, setManageSpace] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [deep, setDeep] = useState(true);
  const [detail, setDetail] = useState<{ type: 'locations' | 'archives' | 'fixed-assets'; id: number } | null>(null);
  const [form, setForm] = useState<{ type: 'archives' | 'locations'; initial: Record<string, unknown>; select?: Mode } | null>(null);
  const [deleting, setDeleting] = useState<LocRow | null>(null);
  const [version, setVersion] = useState(0);
  const storageRef = useRef<HTMLElement>(null);
  /** 刚新增的位置：等列表重新加载回来再选中它 */
  const pending = useRef<{ mode: Mode; id: number } | null>(null);

  const reload = useCallback((message?: string) => { if (message) setMsg(message); clearTreeNodes('locations'); clearRefCache('locations'); setVersion((v) => v + 1); }, []);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [l, a, r, c] = await Promise.all([
        loadAll('locations'),
        canAsset('view') ? loadAll('fixed-assets').catch(() => [] as ResourceDto[]) : Promise.resolve([] as ResourceDto[]),
        canArchive('view') ? loadAll('archives', { showHidden: true }).catch(() => [] as ResourceDto[]) : Promise.resolve([] as ResourceDto[]),
        loadTreeNodes('asset-categories').catch(() => [] as TreeNode[]),
      ]);
      if (!alive) return;
      setLocs(l.map(toLoc)); setAssets(a.map(toAsset)); setArchives(r.map(toArchive)); setCats(c); setError('');
      const want = pending.current;
      if (want) { pending.current = null; if (want.mode === 'storage') { setSpaceId(want.id); setMode('storage'); } else { setAreaId(want.id); setMode('area'); } }
    })().catch((e) => alive && setError(e instanceof ApiError ? e.message : '加载失败'));
    return () => { alive = false; };
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const idx = useMemo(() => buildIndex(locs ?? [], assets, archives, { showInactive }), [locs, assets, archives, showInactive]);
  const inactiveCount = (locs ?? []).filter((l) => l.status === 'inactive').length;
  const spaces = useMemo(() => (assetId ? idx.spacesOf(assetId) : []), [idx, assetId]);
  const areaCols = useMemo(() => buildColumns(idx.areas, areaId, '区域'), [idx, areaId]);
  const spaceCols = useMemo(() => buildColumns(spaces, spaceId, '空间'), [spaces, spaceId]);
  const areaPath = useMemo(() => pathRows(idx.areas, areaId), [idx, areaId]);
  const spacePath = useMemo(() => pathRows(spaces, spaceId), [spaces, spaceId]);

  // 选中的位置被删了、停用藏起来了，就退回上一级
  useEffect(() => {
    if (areaId && !idx.areas.some((l) => l.id === areaId)) setAreaId(0);
    if (assetId && !assets.some((a) => a.id === assetId)) { setAssetId(0); setSpaceId(0); }
    if (spaceId && !spaces.some((l) => l.id === spaceId)) setSpaceId(0);
  }, [idx, assets, spaces, areaId, assetId, spaceId]);

  const picked = mode === 'area' ? areaId : spaceId; // 当前选中的位置（0 = 没选具体位置）
  const rows = useMemo(() => {
    let ids: number[] | null = null;
    if (mode === 'area') { if (areaId) ids = deep ? idx.subtree(areaId) : [areaId]; }
    else if (spaceId) ids = deep ? idx.subtree(spaceId) : [spaceId];
    else if (assetId) ids = idx.assetSpaceIds(assetId);
    else ids = [];
    return ids === null ? archives : ids.flatMap((k) => idx.archivesAt.get(k) ?? []);
  }, [mode, areaId, spaceId, assetId, deep, idx, archives]);
  const counts = useMemo(() => {
    if (picked) return idx.deep(picked);
    if (mode === 'storage' && assetId) return idx.assetCounts(assetId);
    return { archives: archives.length, assets: assets.length, alerts: archives.filter((a) => a.status === 'borrowed' || a.status === 'missing').length };
  }, [idx, picked, mode, assetId, archives, assets]);
  const allLocs = locs ?? [];
  const where = useCallback((a: ArchiveRow) => (a.locationId ? locationPathText(allLocs, a.locationId, assets) : ''), [allLocs, assets]);
  const assetTitle = assets.find((a) => a.id === assetId)?.title ?? '';
  const scopeText = mode === 'area'
    ? (areaId ? areaPath.map((l) => l.title).join(' / ') : '全部档案')
    : assetId ? [assetTitle, ...spacePath.map((l) => l.title)].join(' / ') : '请先选固定资产';

  const can = {
    editLoc: canLoc('edit'), createLoc: canLoc('create'), deleteLoc: canLoc('delete'),
    createArchive: canArchive('create'), statusArchive: canArchive('disable'), viewAssets: canAsset('view'),
  };

  // 新增 / 改名 / 排序 / 停用 / 删除
  async function create(space: boolean, v: { parentId: number; name: string; type: string }) {
    const values: Record<string, unknown> = { name: v.name, locationType: v.type, scope: space ? 'asset_space' : 'area' };
    if (v.parentId) values.parentId = v.parentId;
    if (space) values.fixedAssetId = assetId;
    const saved = await resourceApi.create('locations', values);
    pending.current = { mode: space ? 'storage' : 'area', id: saved.id };
    reload(`已新增「${saved.title}」`);
  }
  async function rename(row: LocRow, name: string) { await resourceApi.update('locations', row.id, { name }); reload(); }
  async function reorder(ids: number[]) {
    const byId = new Map(allLocs.map((l) => [l.id, l]));
    const changes = ids.map((id, i) => ({ id, sort: (i + 1) * 10 })).filter((c) => byId.get(c.id)?.sort !== c.sort);
    for (const c of changes) await resourceApi.update('locations', c.id, { sort: c.sort });
    reload();
  }
  async function toggle(row: LocRow) {
    await resourceApi.changeStatus('locations', row.id, row.status === 'inactive' ? 'normal' : 'inactive', row.status === 'inactive' ? undefined : '在位置页停用');
    reload();
  }
  const ops = (space: boolean): ColumnOps => ({
    canCreate: can.createLoc, canEdit: can.editLoc, canDelete: can.deleteLoc,
    onCreate: (v) => create(space, v), onRename: rename, onReorder: reorder, onToggle: toggle, onDelete: setDeleting,
  });

  const selectArea = (id: number) => { setAreaId(id); setMode('area'); };
  const selectSpace = (id: number) => { setSpaceId(id); setMode('storage'); };
  const selectAsset = (id: number) => { setAssetId(id); setSpaceId(0); setMode('storage'); };

  // 顶部四个按钮
  const newArea = () => setForm({ type: 'locations', select: 'area', initial: { scope: 'area', ...(areaId ? { parentId: areaId } : {}), locationType: defaultChildType(false, idx.areas.find((l) => l.id === areaId) ?? null) } });
  const newSpace = () => {
    if (!assetId) { setMsg('请先在“固定资产储物空间”里选一项固定资产，再新增它的储物空间。'); storageRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); return; }
    setForm({ type: 'locations', select: 'storage', initial: { scope: 'asset_space', fixedAssetId: assetId, ...(spaceId ? { parentId: spaceId } : {}), locationType: defaultChildType(true, spaces.find((l) => l.id === spaceId) ?? null) } });
  };
  const newArchive = () => setForm({ type: 'archives', initial: picked ? { locationId: picked } : {} });

  if (error) return <div role="alert" className="notice error m">{error}</div>;
  if (!locs) return <div className="res-loading" role="status"><span className="res-spin" aria-hidden="true" />加载中…</div>;

  const hint = <PageHint text={resourceDescription('locations') ?? ''} />;
  const areaParent = idx.areas.find((l) => l.id === areaId);
  const spaceParent = spaces.find((l) => l.id === spaceId);
  const areaTrailing = manageArea && areaParent && !areaCols.some((c) => c.parentId === areaId) ? { parent: areaParent } : null;
  const spaceTrailing = manageSpace && spaceParent && !spaceCols.some((c) => c.parentId === spaceId) ? { parent: spaceParent } : null;
  const hasKids = picked > 0 && idx.subtree(picked).length > 1;
  const canManage = can.editLoc || can.createLoc || can.deleteLoc;

  return (
    <div className="lb">
      {hasAppbar && <AppbarHint>{hint}</AppbarHint>}
      <div className="lb-bar">
        {!hasAppbar && hint}
        <span className="lb-bar-sum">{idx.areas.length} 个区域位置 · {archives.length} 份档案</span>
        <span className="res-bar-gap" />
        {inactiveCount > 0 && <button type="button" className="res-btn" aria-pressed={showInactive} title={showInactive ? `已显示停用位置 ${inactiveCount} 条` : '默认隐藏停用位置'} onClick={() => setShowInactive((v) => !v)}>{showInactive ? '隐藏停用' : `显示停用 ${inactiveCount}`}</button>}
        {can.createLoc && <button type="button" className="res-btn" onClick={newArea}>＋ 新增区域</button>}
        {can.createLoc && <button type="button" className="res-btn" onClick={newSpace}>＋ 新增储物空间</button>}
        {can.createArchive && <button type="button" className="res-btn primary" onClick={newArchive}>＋ 新增档案</button>}
      </div>
      {msg && <div role="status" className="notice m between"><span>{msg}</span><button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setMsg('')}>✕</button></div>}

      <section className="lb-panel" aria-label="区域位置">
        <header className="lb-ph">
          <div><strong>区域位置</strong><span>办公楼、楼层、房间，一层层往下点</span></div>
          {canManage && <button type="button" className={`res-btn sm${manageArea ? ' primary' : ''}`} aria-pressed={manageArea} onClick={() => setManageArea((v) => !v)}>{manageArea ? '退出管理' : '管理'}</button>}
        </header>
        <LevelCrumbs rootLabel="全部区域" path={areaPath} selectedId={mode === 'area' ? areaId : -1} onSelect={selectArea} />
        <LevelColumns
          {...ops(false)} columns={areaCols} selectedId={areaId} active={mode === 'area'} manage={manageArea && canManage} noun="区域" typeOptions={AREA_TYPES}
          childType={(p) => defaultChildType(false, p)} counts={(id) => idx.deep(id)} onSelect={selectArea} trailing={areaTrailing}
          emptyHint="点击“管理”后新增办公楼、楼层或房间。"
        />
        {areaId > 0 && (idx.assetsAt.get(areaId)?.length ?? 0) > 0 && can.viewAssets && (
          <div className="lb-here" aria-label="放在这里的固定资产">
            <span>放在这里的固定资产</span>
            {(idx.assetsAt.get(areaId) ?? []).map((a) => {
              const n = idx.spacesOf(a.id).length;
              return <button key={a.id} type="button" className="lb-asset" title="看它里面的储物空间" onClick={() => { selectAsset(a.id); setCatId(0); storageRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }}>{a.title}<small>{n ? `${n} 个空间` : '建立空间'}</small></button>;
            })}
          </div>
        )}
      </section>

      <section className="lb-panel" aria-label="固定资产储物空间" ref={storageRef}>
        <header className="lb-ph">
          <div><strong>固定资产储物空间</strong><span>先选固定资产，再给它建立上层、下层、左边、右边等内部位置</span></div>
          {canManage && <button type="button" className={`res-btn sm${manageSpace ? ' primary' : ''}`} aria-pressed={manageSpace} onClick={() => setManageSpace((v) => !v)}>{manageSpace ? '退出管理' : '管理'}</button>}
        </header>
        <StoragePicker
          categories={cats} assets={assets} categoryId={catId} assetId={assetId} spaceCount={(id) => idx.spacesOf(id).length}
          onCategory={setCatId} onAsset={selectAsset} onOpenAsset={can.viewAssets ? (id) => setDetail({ type: 'fixed-assets', id }) : undefined}
        />
        <div className="lb-sub"><span>当前资产储物空间</span><strong>{assetTitle || '请先选择固定资产'}</strong>{assetId > 0 && <small>这里维护选中资产内部的柜层、抽屉、档案盒等位置</small>}</div>
        {assetId > 0 && <LevelCrumbs rootLabel={assetTitle} path={spacePath} selectedId={mode === 'storage' ? spaceId : -1} onSelect={selectSpace} />}
        {assetId > 0 ? (
          <LevelColumns
            {...ops(true)} columns={spaceCols} selectedId={spaceId} active={mode === 'storage'} manage={manageSpace && canManage} noun="空间" typeOptions={SPACE_TYPES}
            childType={(p) => defaultChildType(true, p)} counts={(id) => idx.deep(id)} onSelect={selectSpace} trailing={spaceTrailing}
            emptyHint="这个固定资产还没有储物空间。点击“管理”后建立上层、下层、左边、右边等内部位置。"
          />
        ) : <div className="lc-empty"><strong>先选择固定资产</strong><span>例如档案柜、办公桌、保险柜。</span></div>}
      </section>

      <LocationArchives
        scopeText={scopeText} rows={rows} counts={counts} locationId={picked} hasKids={hasKids} deep={deep} onDeep={setDeep} where={where}
        canCreate={can.createArchive} canStatus={can.statusArchive} canViewAssets={can.viewAssets}
        onNew={newArchive} onOpenLocation={() => picked && setDetail({ type: 'locations', id: picked })}
        onOpenArchive={(id) => setDetail({ type: 'archives', id })} onChanged={reload}
      />

      {detail && <RecordDetail def={detail.type === 'locations' ? locDef : detail.type === 'archives' ? archiveDef : assetDef} id={detail.id} onClose={() => setDetail(null)} onChanged={() => reload()} />}
      {form && (
        <RecordForm
          def={form.type === 'archives' ? archiveDef : locDef} record={null} initial={form.initial} onClose={() => setForm(null)}
          onSaved={(dto) => {
            const sel = form.select; const kind = form.type;
            setForm(null);
            if (kind === 'archives') { reload(`已新增档案「${dto.title}」`); setDetail({ type: 'archives', id: dto.id }); return; }
            pending.current = { mode: sel === 'storage' ? 'storage' : 'area', id: dto.id };
            reload(`已新增「${dto.title}」`);
          }}
        />
      )}
      {deleting && (
        <ReasonDialog
          title={`删除位置「${deleting.title}」`}
          hint="删除后，放在这里的档案、固定资产和证照等资料的“存放位置”会被清空；它的下级位置会变成一级位置。不想丢掉历史的话，可以改用“停用”。删除要写原因，会留在操作记录里。"
          confirmLabel="确认删除"
          onClose={() => setDeleting(null)}
          onSubmit={async (reason) => {
            await resourceApi.remove('locations', deleting.id, reason);
            if (areaId === deleting.id) setAreaId(0);
            if (spaceId === deleting.id) setSpaceId(0);
            setDeleting(null);
            reload(`已删除「${deleting.title}」`);
          }}
        />
      )}
    </div>
  );
}
