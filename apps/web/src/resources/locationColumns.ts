/**
 * 房间与档案位置看板用的纯函数（不碰接口）。
 * 区域位置（办公楼 → 楼层 → 房间）和固定资产储物空间（柜层 → 抽屉 → 格/盒）各自按“分级多列”展示：
 * 每一级一列，点中一项就在右边展开它的下一级。档案存放在某个位置上，数量按“含下级”汇总。
 */

export interface LocRow { id: number; title: string; status: string; parentId: number; scope: string; locationType: string; fixedAssetId: number; code: string; sort: number }
export interface AssetRow { id: number; title: string; status: string; assetNo: string; categoryId: number; locationId: number; categoryLabel: string; locationLabel: string }
export interface ArchiveRow { id: number; title: string; status: string; archiveNo: string; archiveType: string; locationId: number; keeperLabel: string; relatedLabel: string }

export const LOC_TYPE_LABEL: Record<string, string> = { building: '办公楼/区域', floor: '楼层', room: '房间', cabinet: '柜子', asset_slot: '资产内部位置', shelf: '层', drawer: '抽屉', box: '格/盒' };

export const isSpace = (l: LocRow) => l.scope === 'asset_space';
const bySort = (a: LocRow, b: LocRow) => a.sort - b.sort || a.id - b.id;

export interface Column { title: string; parentId: number; rows: LocRow[] }

/** 这些位置里，哪些是顶层：没有上级，或上级不在这批位置里（比如被停用隐藏了） */
function kidsMap(rows: readonly LocRow[]): Map<number, LocRow[]> {
  const ids = new Set(rows.map((r) => r.id));
  const m = new Map<number, LocRow[]>();
  for (const r of rows) {
    const p = r.parentId && ids.has(r.parentId) && r.parentId !== r.id ? r.parentId : 0;
    m.set(p, [...(m.get(p) ?? []), r]);
  }
  for (const list of m.values()) list.sort(bySort);
  return m;
}

/** 从顶层到选中项（含自己），最多 20 级，防环 */
export function pathRows(rows: readonly LocRow[], id: number): LocRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: LocRow[] = [];
  for (let c = byId.get(id), i = 0; c && i < 20 && !out.includes(c); c = byId.get(c.parentId), i++) out.unshift(c);
  return out;
}

/**
 * 分级多列：第一列是顶层，选中项路径上每一级各出一列（只出有下级的）。
 * noun 是列头里的称呼：“区域”“空间”。
 */
export function buildColumns(rows: readonly LocRow[], selectedId: number, noun: string): Column[] {
  const kids = kidsMap(rows);
  const path = pathRows(rows, selectedId);
  const level = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const name = (i: number) => (i < level.length ? `${level[i]}级${noun}` : `${i + 1}级${noun}`);
  const cols: Column[] = [{ title: name(0), parentId: 0, rows: kids.get(0) ?? [] }];
  path.forEach((l, i) => { const r = kids.get(l.id) ?? []; if (r.length) cols.push({ title: name(i + 1), parentId: l.id, rows: r }); });
  return cols;
}

/** 新增下级时默认的类型 */
export function defaultChildType(space: boolean, parent: LocRow | null): string {
  if (space) return !parent ? 'shelf' : parent.locationType === 'shelf' ? 'drawer' : 'box';
  if (!parent) return 'building';
  return parent.locationType === 'building' ? 'floor' : 'room';
}

export interface Counts { archives: number; assets: number; alerts: number }

export interface Index {
  /** 当前能看到的位置（没勾“显示停用”时，停用的和停用位置的下级都不在） */
  visible: LocRow[];
  areas: LocRow[];
  spacesOf: (assetId: number) => LocRow[];
  archivesAt: Map<number, ArchiveRow[]>;
  assetsAt: Map<number, AssetRow[]>;
  /** 含下级（区域里还包括放在区域里的固定资产的储物空间）的数量 */
  deep: (id: number) => Counts;
  /** 这个位置本身和全部下级的编号 */
  subtree: (id: number) => number[];
  /** 放在区域里的固定资产，其全部储物空间的编号（选中一项固定资产、没选具体空间时用） */
  assetSpaceIds: (assetId: number) => number[];
  assetCounts: (assetId: number) => Counts;
  /** 档案的位置记录已不存在（或被隐藏）时 */
  stray: ArchiveRow[];
}

export function buildIndex(locs: readonly LocRow[], assets: readonly AssetRow[], archives: readonly ArchiveRow[], opts: { showInactive: boolean }): Index {
  const byId = new Map(locs.map((l) => [l.id, l]));
  const okOne = (l: LocRow) => opts.showInactive || l.status !== 'inactive';
  const visible = locs.filter((l) => {
    for (let c: LocRow | undefined = l, i = 0; c && i < 20; c = byId.get(c.parentId), i++) if (!okOne(c)) return false;
    return true;
  });
  const vis = new Map(visible.map((l) => [l.id, l]));
  const assetById = new Map(assets.map((a) => [a.id, a]));

  // 有效上级：自己的上级（看得见时）；储物空间没有上级时，算在它的固定资产所在的区域里
  const effParent = (l: LocRow): number => {
    if (l.parentId && vis.has(l.parentId) && l.parentId !== l.id) return l.parentId;
    if (isSpace(l) && l.fixedAssetId) { const a = assetById.get(l.fixedAssetId); if (a?.locationId && vis.has(a.locationId)) return a.locationId; }
    return 0;
  };
  const eff = new Map<number, number[]>();
  for (const l of visible) eff.set(effParent(l), [...(eff.get(effParent(l)) ?? []), l.id]);

  const archivesAt = new Map<number, ArchiveRow[]>();
  const stray: ArchiveRow[] = [];
  for (const a of archives) {
    if (a.locationId && vis.has(a.locationId)) archivesAt.set(a.locationId, [...(archivesAt.get(a.locationId) ?? []), a]);
    else stray.push(a);
  }
  const assetsAt = new Map<number, AssetRow[]>();
  for (const a of assets) if (a.locationId && vis.has(a.locationId)) assetsAt.set(a.locationId, [...(assetsAt.get(a.locationId) ?? []), a]);

  const subtree = (id: number): number[] => {
    const out = [id];
    for (let i = 0; i < out.length && out.length < 20000; i++) for (const c of eff.get(out[i]) ?? []) if (!out.includes(c)) out.push(c);
    return out;
  };
  const alertOf = (list: readonly ArchiveRow[]) => list.filter((a) => a.status === 'borrowed' || a.status === 'missing').length;
  const memo = new Map<number, Counts>();
  const deep = (id: number): Counts => {
    const hit = memo.get(id);
    if (hit) return hit;
    const ids = subtree(id);
    const c: Counts = { archives: 0, assets: 0, alerts: 0 };
    for (const k of ids) {
      const list = archivesAt.get(k) ?? [];
      c.archives += list.length; c.alerts += alertOf(list); c.assets += (assetsAt.get(k) ?? []).length;
    }
    memo.set(id, c);
    return c;
  };
  const spacesOf = (assetId: number) => visible.filter((l) => isSpace(l) && l.fixedAssetId === assetId);
  const assetSpaceIds = (assetId: number) => spacesOf(assetId).map((l) => l.id);
  const assetCounts = (assetId: number): Counts => {
    const c: Counts = { archives: 0, assets: 0, alerts: 0 };
    for (const k of assetSpaceIds(assetId)) { const list = archivesAt.get(k) ?? []; c.archives += list.length; c.alerts += alertOf(list); }
    return c;
  };
  return { visible, areas: visible.filter((l) => !isSpace(l)), spacesOf, archivesAt, assetsAt, deep, subtree, assetSpaceIds, assetCounts, stray };
}

/** 档案所在位置的路径文字（从顶层往下，用于列表里的“存放位置”） */
export function locationPathText(locs: readonly LocRow[], id: number, assets: readonly AssetRow[] = [], sep = ' / '): string {
  const byId = new Map(locs.map((l) => [l.id, l]));
  const path = pathRows(locs, id);
  const names = path.map((l) => l.title);
  const first = path[0];
  // 柜子里的空间：路径前面补上“柜子名”，一眼看到在哪个柜子
  if (first && isSpace(first) && first.fixedAssetId) {
    const a = assets.find((x) => x.id === first.fixedAssetId);
    if (a) { const area = a.locationId && byId.has(a.locationId) ? pathRows(locs, a.locationId).map((l) => l.title) : []; return [...area, a.title, ...names].join(sep); }
  }
  return names.join(sep);
}
