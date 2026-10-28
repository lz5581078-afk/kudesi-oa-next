/**
 * 房间与档案位置的层级模型（纯函数，不碰接口）：
 * 房间 → 柜子（固定资产）→ 层位/抽屉（储物空间）→ 档案。
 * 区域位置按上级一层层挂；固定资产放在它所在的位置下面；固定资产的储物空间挂在这项资产下面
 * （旧数据里直接挂在区域下面的储物空间，就挂在那个区域下面）；档案存放在某个位置上，不单独成节点，只算数量。
 */

export interface LocRow { id: number; title: string; status: string; parentId: number; scope: string; locationType: string; fixedAssetId: number; code: string; sort: number; description: string }
export interface AssetRow { id: number; title: string; status: string; assetNo: string; locationId: number; userLabel: string; categoryLabel: string }
export interface ArchiveRow { id: number; title: string; status: string; archiveNo: string; archiveType: string; locationId: number; keeperLabel: string; relatedLabel: string }

export type NodeKind = 'area' | 'asset' | 'space' | 'group';

export interface BNode {
  key: string;
  kind: NodeKind;
  /** 对应的资料记录 id（group 为 0） */
  id: number;
  title: string;
  /** 类型说明：房间、柜子、层、抽屉、固定资产… */
  tag: string;
  status: string;
  code: string;
  locationType: string;
  parentKey: string | null;
  sort: number;
  /** 往下新增时挂在哪个位置记录/固定资产下 */
  assetId: number;
}

export const LOC_TYPE_LABEL: Record<string, string> = { building: '办公楼/区域', floor: '楼层', room: '房间', cabinet: '柜子', asset_slot: '资产内部位置', shelf: '层', drawer: '抽屉', box: '格/盒' };

export interface Model {
  nodes: Map<string, BNode>;
  kids: Map<string | null, string[]>;
  roots: string[];
  /** 直接存放在这个节点上的档案 */
  archivesAt: Map<string, ArchiveRow[]>;
  /** 直接放在这个位置上的固定资产（只有区域位置会有） */
  assetsAt: Map<string, AssetRow[]>;
  /** 含下级的数量 */
  deepArchives: Map<string, number>;
  deepAssets: Map<string, number>;
  /** 借出/遗失的档案数（含下级），用来在树上提醒 */
  deepAlerts: Map<string, number>;
  /** 档案的位置记录已不存在（或被隐藏）时 */
  stray: ArchiveRow[];
}

const GROUP_SPACE = 'g:space';
const GROUP_ASSET = 'g:asset';

export function locKey(id: number) { return `l:${id}`; }
export function assetKey(id: number) { return `a:${id}`; }

export function buildModel(locs: readonly LocRow[], assets: readonly AssetRow[], archives: readonly ArchiveRow[], opts: { showInactive: boolean }): Model {
  const nodes = new Map<string, BNode>();
  const locById = new Map(locs.map((l) => [l.id, l]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const visibleLoc = (l: LocRow) => opts.showInactive || l.status !== 'inactive';
  const shown = new Set<number>();
  // 位置要显示：自己没停用，上面各级也都没停用
  for (const l of locs) {
    let ok = true;
    for (let c: LocRow | undefined = l, i = 0; c && i < 20; c = locById.get(c.parentId), i++) if (!visibleLoc(c)) { ok = false; break; }
    if (ok) shown.add(l.id);
  }
  const ownerAssets = new Set(locs.filter((l) => l.scope === 'asset_space' && l.fixedAssetId && shown.has(l.id) && assetById.has(l.fixedAssetId)).map((l) => l.fixedAssetId));

  let needSpaceGroup = false;
  let needAssetGroup = false;
  for (const l of locs) {
    if (!shown.has(l.id)) continue;
    const space = l.scope === 'asset_space';
    let parentKey: string | null = null;
    if (l.parentId && locById.has(l.parentId) && shown.has(l.parentId)) parentKey = locKey(l.parentId);
    else if (space) {
      if (l.fixedAssetId && assetById.has(l.fixedAssetId)) parentKey = assetKey(l.fixedAssetId);
      else { parentKey = GROUP_SPACE; needSpaceGroup = true; }
    }
    nodes.set(locKey(l.id), {
      key: locKey(l.id), kind: space ? 'space' : 'area', id: l.id, title: l.title, tag: LOC_TYPE_LABEL[l.locationType] ?? (space ? '储物空间' : '位置'),
      status: l.status, code: l.code, locationType: l.locationType, parentKey, sort: l.sort, assetId: l.fixedAssetId,
    });
  }
  for (const id of ownerAssets) {
    const a = assetById.get(id)!;
    let parentKey: string | null = null;
    if (a.locationId && locById.has(a.locationId) && shown.has(a.locationId)) parentKey = locKey(a.locationId);
    else { parentKey = GROUP_ASSET; needAssetGroup = true; }
    nodes.set(assetKey(id), { key: assetKey(id), kind: 'asset', id, title: a.title, tag: a.assetNo || '固定资产', status: a.status, code: a.assetNo, locationType: '', parentKey, sort: -1, assetId: id });
  }
  if (needAssetGroup) nodes.set(GROUP_ASSET, { key: GROUP_ASSET, kind: 'group', id: 0, title: '没有放在房间里的柜子', tag: '固定资产', status: 'normal', code: '', locationType: '', parentKey: null, sort: 9000, assetId: 0 });
  if (needSpaceGroup) nodes.set(GROUP_SPACE, { key: GROUP_SPACE, kind: 'group', id: 0, title: '没有归属的储物空间', tag: '储物空间', status: 'normal', code: '', locationType: '', parentKey: null, sort: 9001, assetId: 0 });

  // 防环：沿上级往上走超过 30 级的，当作顶层
  for (const n of nodes.values()) {
    let c: BNode | undefined = n;
    let i = 0;
    for (; c && c.parentKey && i < 30; i++) c = nodes.get(c.parentKey);
    if (i >= 30) n.parentKey = null;
  }

  const kids = new Map<string | null, string[]>();
  for (const n of nodes.values()) kids.set(n.parentKey, [...(kids.get(n.parentKey) ?? []), n.key]);
  for (const list of kids.values()) {
    list.sort((a, b) => {
      const x = nodes.get(a)!; const y = nodes.get(b)!;
      // 固定资产（柜子）排在同级位置之前；同类按排序值、再按编号
      const rank = (n: BNode) => (n.kind === 'asset' ? 0 : n.kind === 'group' ? 2 : 1);
      return rank(x) - rank(y) || x.sort - y.sort || x.id - y.id;
    });
  }
  const roots = kids.get(null) ?? [];

  const archivesAt = new Map<string, ArchiveRow[]>();
  const stray: ArchiveRow[] = [];
  for (const a of archives) {
    const k = a.locationId ? locKey(a.locationId) : '';
    if (k && nodes.has(k)) archivesAt.set(k, [...(archivesAt.get(k) ?? []), a]);
    else stray.push(a);
  }
  const assetsAt = new Map<string, AssetRow[]>();
  for (const a of assets) {
    const k = a.locationId ? locKey(a.locationId) : '';
    if (k && nodes.has(k)) assetsAt.set(k, [...(assetsAt.get(k) ?? []), a]);
  }

  const deepArchives = new Map<string, number>();
  const deepAssets = new Map<string, number>();
  const deepAlerts = new Map<string, number>();
  const sum = (key: string, depth = 0): void => {
    let ar = archivesAt.get(key)?.length ?? 0;
    let as = assetsAt.get(key)?.length ?? 0;
    let al = (archivesAt.get(key) ?? []).filter((x) => x.status === 'borrowed' || x.status === 'missing').length;
    if (depth < 30) for (const c of kids.get(key) ?? []) {
      sum(c, depth + 1);
      ar += deepArchives.get(c) ?? 0; as += deepAssets.get(c) ?? 0; al += deepAlerts.get(c) ?? 0;
    }
    deepArchives.set(key, ar); deepAssets.set(key, as); deepAlerts.set(key, al);
  };
  for (const r of roots) sum(r);
  return { nodes, kids, roots, archivesAt, assetsAt, deepArchives, deepAssets, deepAlerts, stray };
}

/** 从顶层到该节点（含自己） */
export function pathKeys(m: Model, key: string): string[] {
  const out: string[] = [];
  for (let c: BNode | undefined = m.nodes.get(key), i = 0; c && i < 30; c = c.parentKey ? m.nodes.get(c.parentKey) : undefined, i++) out.unshift(c.key);
  return out;
}

export function pathText(m: Model, key: string, sep = ' / '): string {
  return pathKeys(m, key).map((k) => m.nodes.get(k)?.title ?? '').join(sep);
}

/** 节点及其全部下级的 key */
export function subtreeKeys(m: Model, key: string): string[] {
  const out = [key];
  for (let i = 0; i < out.length && out.length < 20000; i++) out.push(...(m.kids.get(out[i]) ?? []));
  return out;
}

/** 搜索：返回要显示的节点（命中节点、命中档案所在节点，及它们所有上级） */
export function searchKeys(m: Model, word: string): { keep: Set<string>; hits: Set<string> } {
  const w = word.trim().toLowerCase();
  const keep = new Set<string>();
  const hits = new Set<string>();
  if (!w) return { keep, hits };
  const add = (k: string) => { hits.add(k); for (const p of pathKeys(m, k)) keep.add(p); };
  for (const n of m.nodes.values()) if (n.title.toLowerCase().includes(w) || n.code.toLowerCase().includes(w)) add(n.key);
  for (const [k, list] of m.archivesAt) if (list.some((a) => `${a.title} ${a.archiveNo} ${a.archiveType}`.toLowerCase().includes(w))) add(k);
  return { keep, hits };
}

/** 新增下级时默认的类型：楼 → 楼层 → 房间 → 柜子；储物空间：层 → 抽屉 → 格/盒 */
export function defaultChildType(parent: BNode | null): string {
  if (!parent) return 'building';
  if (parent.kind === 'asset') return 'shelf';
  if (parent.kind === 'space') return parent.locationType === 'shelf' ? 'drawer' : 'box';
  switch (parent.locationType) {
    case 'building': return 'floor';
    case 'floor': return 'room';
    case 'room': return 'cabinet';
    default: return 'room';
  }
}
