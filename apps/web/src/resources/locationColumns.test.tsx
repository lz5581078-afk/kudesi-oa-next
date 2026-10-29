import { describe, expect, it } from 'vitest';
import { buildColumns, buildIndex, defaultChildType, locationPathText, pathRows, type ArchiveRow, type AssetRow, type LocRow } from './locationColumns';

const loc = (id: number, title: string, o: Partial<LocRow> = {}): LocRow => ({ id, title, status: 'normal', parentId: 0, scope: 'area', locationType: 'room', fixedAssetId: 0, code: '', sort: 0, ...o });
const asset = (id: number, title: string, locationId: number): AssetRow => ({ id, title, status: 'in_use', assetNo: `A${id}`, categoryId: 0, locationId, categoryLabel: '', locationLabel: '' });
const arc = (id: number, title: string, locationId: number, status = 'stored'): ArchiveRow => ({ id, title, status, archiveNo: `D${id}`, archiveType: '合同', locationId, keeperLabel: '', relatedLabel: '' });

const locs = [
  loc(1, '总部楼', { locationType: 'building', sort: 2 }),
  loc(6, '分部楼', { locationType: 'building', sort: 1 }),
  loc(2, '三楼财务室', { parentId: 1 }),
  loc(3, '一层', { scope: 'asset_space', locationType: 'shelf', fixedAssetId: 10 }),
  loc(4, '抽屉甲', { scope: 'asset_space', locationType: 'drawer', parentId: 3, fixedAssetId: 10 }),
  loc(5, '旧库房', { parentId: 1, status: 'inactive' }),
];
const assets = [asset(10, '档案柜', 2), asset(11, '空柜', 0)];
const archives = [arc(100, '合同A', 4), arc(101, '合同B', 4, 'borrowed'), arc(102, '合同C', 2, 'missing'), arc(103, '悬空档案', 999)];

describe('分级多列：区域位置', () => {
  const idx = buildIndex(locs, assets, archives, { showInactive: false });
  it('第一列是顶层（按排序值），选中一项后右边出现它的下级一列', () => {
    expect(buildColumns(idx.areas, 0, '区域').map((c) => [c.title, c.rows.map((r) => r.title)])).toEqual([['一级区域', ['分部楼', '总部楼']]]);
    const cols = buildColumns(idx.areas, 2, '区域');
    expect(cols.map((c) => c.title)).toEqual(['一级区域', '二级区域']);
    expect(cols[1].rows.map((r) => r.title)).toEqual(['三楼财务室']);
  });
  it('选中项没有下级就不多出一列；停用的位置默认不在列里', () => {
    expect(buildColumns(idx.areas, 2, '区域').length).toBe(2);
    expect(idx.areas.some((l) => l.id === 5)).toBe(false);
    expect(buildIndex(locs, assets, archives, { showInactive: true }).areas.some((l) => l.id === 5)).toBe(true);
  });
  it('路径从顶层到选中项', () => {
    expect(pathRows(idx.areas, 2).map((l) => l.title)).toEqual(['总部楼', '三楼财务室']);
  });
});

describe('分级多列：固定资产储物空间', () => {
  const idx = buildIndex(locs, assets, archives, { showInactive: false });
  it('只看选中固定资产自己的空间：一层 → 抽屉', () => {
    const cols = buildColumns(idx.spacesOf(10), 3, '空间');
    expect(cols.map((c) => c.rows.map((r) => r.title))).toEqual([['一层'], ['抽屉甲']]);
    expect(idx.spacesOf(11)).toEqual([]);
  });
  it('档案数含下级，借出/遗失累计成提醒；房间里算上放在房间里的柜子的空间', () => {
    expect(idx.deep(4)).toMatchObject({ archives: 2, alerts: 1 });
    expect(idx.deep(3).archives).toBe(2);
    expect(idx.deep(2)).toMatchObject({ archives: 3, alerts: 2, assets: 1 });
    expect(idx.deep(1).archives).toBe(3);
  });
  it('范围：选中位置含下级，或选中固定资产时是它全部空间', () => {
    expect(idx.subtree(2).sort()).toEqual([2, 3, 4]);
    expect(idx.assetSpaceIds(10).sort()).toEqual([3, 4]);
    expect(idx.assetCounts(10).archives).toBe(2);
  });
  it('位置记录不存在的档案归入“没找到位置”', () => {
    expect(idx.stray.map((a) => a.id)).toEqual([103]);
  });
  it('存放位置文字带出柜子和它所在的房间', () => {
    expect(locationPathText(locs, 4, assets)).toBe('总部楼 / 三楼财务室 / 档案柜 / 一层 / 抽屉甲');
    expect(locationPathText(locs, 2, assets)).toBe('总部楼 / 三楼财务室');
  });
  it('上级成环时不死循环', () => {
    const cyc = [loc(1, 'x', { parentId: 2 }), loc(2, 'y', { parentId: 1 })];
    expect(buildIndex(cyc, [], [], { showInactive: false }).visible.length).toBe(2);
    expect(pathRows(cyc, 1).length).toBeLessThanOrEqual(2);
  });
});

describe('新增下级的默认类型', () => {
  it('区域：楼 → 楼层 → 房间；空间：层 → 抽屉 → 格/盒', () => {
    expect(defaultChildType(false, null)).toBe('building');
    expect(defaultChildType(false, loc(1, '楼', { locationType: 'building' }))).toBe('floor');
    expect(defaultChildType(false, loc(1, '层', { locationType: 'floor' }))).toBe('room');
    expect(defaultChildType(true, null)).toBe('shelf');
    expect(defaultChildType(true, loc(1, '层', { locationType: 'shelf' }))).toBe('drawer');
    expect(defaultChildType(true, loc(1, '抽屉', { locationType: 'drawer' }))).toBe('box');
  });
});
