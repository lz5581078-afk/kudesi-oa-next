import { describe, expect, it } from 'vitest';
import { buildModel, defaultChildType, pathText, searchKeys, subtreeKeys, type ArchiveRow, type AssetRow, type LocRow } from './locationModel';

const loc = (id: number, title: string, o: Partial<LocRow> = {}): LocRow => ({ id, title, status: 'normal', parentId: 0, scope: 'area', locationType: 'room', fixedAssetId: 0, code: '', sort: 0, description: '', ...o });
const asset = (id: number, title: string, locationId: number): AssetRow => ({ id, title, status: 'in_use', assetNo: `A${id}`, locationId, userLabel: '', categoryLabel: '' });
const arc = (id: number, title: string, locationId: number, status = 'stored'): ArchiveRow => ({ id, title, status, archiveNo: `D${id}`, archiveType: '合同', locationId, keeperLabel: '', relatedLabel: '' });

const locs = [
  loc(1, '总部楼', { locationType: 'building' }),
  loc(2, '三楼财务室', { parentId: 1 }),
  loc(3, '一层', { scope: 'asset_space', locationType: 'shelf', fixedAssetId: 10 }),
  loc(4, '抽屉甲', { scope: 'asset_space', locationType: 'drawer', parentId: 3, fixedAssetId: 10 }),
  loc(5, '旧库房', { parentId: 1, status: 'inactive' }),
];
const assets = [asset(10, '档案柜', 2), asset(11, '无处安放的柜', 0)];
const archives = [arc(100, '合同A', 4), arc(101, '合同B', 4, 'borrowed'), arc(102, '合同C', 2, 'missing'), arc(103, '悬空档案', 999)];

describe('房间→柜子→层位→档案 层级模型', () => {
  const m = buildModel(locs, assets, archives, { showInactive: false });
  it('柜子（固定资产）挂在所在房间下，层位挂在柜子下，抽屉挂在层下', () => {
    expect(pathText(m, 'l:4')).toBe('总部楼 / 三楼财务室 / 档案柜 / 一层 / 抽屉甲');
    expect(m.nodes.get('a:10')?.kind).toBe('asset');
  });
  it('档案只计数，不成节点；含下级的数量逐级累加', () => {
    expect(m.archivesAt.get('l:4')?.length).toBe(2);
    expect(m.deepArchives.get('l:2')).toBe(3);
    expect(m.deepArchives.get('l:1')).toBe(3);
    expect(m.deepAssets.get('l:1')).toBe(1);
  });
  it('借出/遗失的档案向上累计为提醒', () => {
    expect(m.deepAlerts.get('l:4')).toBe(1);
    expect(m.deepAlerts.get('l:1')).toBe(2);
  });
  it('位置不存在的档案归入“未找到位置”列表，没放在房间里的柜子不会丢，只有有层位的柜子才成节点', () => {
    expect(m.stray.map((a) => a.id)).toEqual([103]);
    expect(m.nodes.has('a:11')).toBe(false);
  });
  it('停用位置默认不显示，打开显示停用后出现', () => {
    expect(m.nodes.has('l:5')).toBe(false);
    expect(buildModel(locs, assets, archives, { showInactive: true }).nodes.has('l:5')).toBe(true);
  });
  it('搜索命中档案时保留它所在位置和全部上级', () => {
    const { keep, hits } = searchKeys(m, '合同B');
    expect(hits.has('l:4')).toBe(true);
    expect(['l:1', 'l:2', 'a:10', 'l:3', 'l:4'].every((k) => keep.has(k))).toBe(true);
  });
  it('子树包含自己和全部下级', () => {
    expect(subtreeKeys(m, 'l:2').sort()).toEqual(['a:10', 'l:2', 'l:3', 'l:4'].sort());
  });
  it('上级成环时不死循环', () => {
    const cyc = buildModel([loc(1, 'x', { parentId: 2 }), loc(2, 'y', { parentId: 1 })], [], [], { showInactive: false });
    expect(cyc.nodes.size).toBe(2);
  });
  it('新增下级的默认类型：楼→楼层→房间→柜子，柜子下是层，层下是抽屉', () => {
    const n = (k: string) => m.nodes.get(k)!;
    expect(defaultChildType(null)).toBe('building');
    expect(defaultChildType(n('l:1'))).toBe('floor');
    expect(defaultChildType(n('a:10'))).toBe('shelf');
    expect(defaultChildType(n('l:3'))).toBe('drawer');
  });
});
