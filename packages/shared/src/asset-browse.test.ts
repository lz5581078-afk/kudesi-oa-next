import { describe, expect, it } from 'vitest';
import { RESOURCE_DEFS, browseFilterFields } from './resources';

const def = (k: string) => RESOURCE_DEFS.find((d) => d.key === k)!;

describe('固定资产/档案的左侧浏览维度', () => {
  it('固定资产按分类、位置、使用人、部门四个维度浏览', () => {
    expect(browseFilterFields(def('fixed-assets')).map((f) => f.key)).toEqual(['categoryId', 'locationId', 'userId', 'departmentId']);
  });
  it('档案按存放位置和保管人浏览', () => {
    expect(browseFilterFields(def('archives')).map((f) => f.key)).toEqual(['locationId', 'keeperUserId']);
  });
  it('固定资产的位置树不含资产内部的储物空间；分类可在树上管理', () => {
    const d = def('fixed-assets');
    expect(d.treeExclude?.locationId).toEqual({ field: 'scope', values: ['asset_space'] });
    expect(d.treeManage).toContain('categoryId');
  });
  it('固定资产的快捷页签保留在用、闲置、维修、丢失、保修将到期、未放位置', () => {
    expect((def('fixed-assets').quickTabs ?? []).map((t) => t.key)).toEqual(['in-use', 'idle', 'repairing', 'lost', 'warranty', 'no-location']);
  });
  it('位置类型有“柜子”', () => {
    const t = def('locations').fields.find((f) => f.key === 'locationType')!;
    expect((t.options ?? []).map((o) => o.value)).toContain('cabinet');
  });
});
