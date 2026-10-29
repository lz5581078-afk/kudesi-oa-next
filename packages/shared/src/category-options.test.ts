import { describe, expect, it } from 'vitest';
import {
  allowedCategoryValues, categoryDeleteBlock, categoryFieldOf, categoryHideBlock, effectiveCategoryOptions, generateCategoryValue, mergeCategoryOptions, selectableCategories,
  validateCategoryLabel, visibleCategories, type CategoryRow,
} from './category-options';
import { allGrantableKeys } from './permission-catalog';
import { SPECIAL_PERMISSIONS } from './navigation';
import { RESOURCE_DEFS, getResourceDef, validateResourceInput } from './resources';

const code = [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }, { value: 'c', label: '丙' }];
const row = (value: string, label: string, sortOrder: number, o: Partial<CategoryRow> = {}): CategoryRow => ({ value, label, sortOrder, hidden: false, custom: false, ...o });

describe('有效选项合并', () => {
  it('没有配置就是代码选项，顺序不变', () => {
    expect(mergeCategoryOptions(code, []).map((o) => [o.value, o.label, o.system, o.hidden])).toEqual([['a', '甲', true, false], ['b', '乙', true, false], ['c', '丙', true, false]]);
  });
  it('改名只换显示名并保留代码原名；排序按配置；自建分类排后面', () => {
    const m = mergeCategoryOptions(code, [row('a', '甲新', 30), row('b', '乙', 10), row('c', '丙', 20), row('c_abc12345', '自建', 40, { custom: true })]);
    expect(m.map((o) => o.value)).toEqual(['b', 'c', 'a', 'c_abc12345']);
    expect(m.find((o) => o.value === 'a')).toMatchObject({ label: '甲新', defaultLabel: '甲', system: true });
    expect(m.find((o) => o.value === 'c_abc12345')).toMatchObject({ system: false });
  });
  it('系统分类即使配置里写了 hidden 也不会被隐藏；代码新增的选项没有行时仍出现', () => {
    const m = mergeCategoryOptions(code, [row('a', '甲', 10, { hidden: true })]);
    expect(m.find((o) => o.value === 'a')!.hidden).toBe(false);
    expect(m.map((o) => o.value)).toEqual(['a', 'b', 'c']);
  });
  it('隐藏的自建分类：不在页签和可选集合里，但当前值保留可见；已有值显示带“已隐藏”', () => {
    const m = mergeCategoryOptions(code, [row('c_x', '旧自建', 99, { custom: true, hidden: true })]);
    expect(visibleCategories(m).map((o) => o.value)).toEqual(['a', 'b', 'c']);
    expect(allowedCategoryValues(m)).toEqual(['a', 'b', 'c']);
    expect(selectableCategories(m).map((o) => o.value)).toEqual(['a', 'b', 'c']);
    expect(selectableCategories(m, 'c_x').at(-1)).toEqual({ value: 'c_x', label: '旧自建（已隐藏）' });
  });
});

describe('规则', () => {
  it('系统分类不能隐藏、不能删除；自建分类有记录在用不能删，零记录可以', () => {
    const sys = { system: true, label: '甲' };
    const own = { system: false, label: '自建' };
    expect(categoryHideBlock(sys)).toContain('不能隐藏');
    expect(categoryHideBlock(own)).toBeNull();
    expect(categoryDeleteBlock(sys, 0)).toContain('不能删除');
    expect(categoryDeleteBlock(own, 3)).toContain('3 条记录在用');
    expect(categoryDeleteBlock(own, 0)).toBeNull();
  });
  it('名称校验：空、超长、保留名、重名（忽略全半角和大小写）', () => {
    expect(validateCategoryLabel('', [])).toContain('请填写');
    expect(validateCategoryLabel('x'.repeat(21), [])).toContain('不能超过');
    expect(validateCategoryLabel('全部', [])).toContain('保留');
    expect(validateCategoryLabel('ＡＢ', ['ab'])).toContain('同名');
    expect(validateCategoryLabel(' 新分类 ', ['旧'])).toBeNull();
  });
  it('生成的值格式固定、不与已有冲突', () => {
    const taken = new Set<string>();
    const seq = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    let i = 0;
    const rnd = () => seq[i++ % seq.length];
    const first = generateCategoryValue(taken, rnd);
    expect(first).toBe('c_00000000');
    taken.add(first);
    expect(generateCategoryValue(taken, rnd)).not.toBe(first);
    expect(generateCategoryValue(new Set())).toMatch(/^c_[0-9a-z]{8}$/);
  });
});

describe('哪些资料开放', () => {
  it('开放的资料：tabsBy 是单选 select；财务区 4 个和房间位置不开放', () => {
    const open = RESOURCE_DEFS.filter((d) => categoryFieldOf(d)).map((d) => d.key).sort();
    expect(open).toEqual(['bank-accounts', 'licenses', 'memos', 'partners', 'phones', 'qualifications', 'self-media', 'store-scores', 'stores', 'tax-profiles']);
    for (const k of ['finance-products', 'finance-categories', 'finance-fee-items', 'finance-product-units', 'locations']) expect(categoryFieldOf(getResourceDef(k)!)).toBeUndefined();
    for (const d of RESOURCE_DEFS.filter((x) => x.tabsBy)) expect(open.includes(d.key) || !!d.nav?.section || d.key === 'locations').toBe(true);
  });
  it('payload 为空时有效选项等于代码选项；有配置时按配置', () => {
    const def = getResourceDef('qualifications')!;
    expect(effectiveCategoryOptions(def, undefined)!.map((o) => o.value)).toEqual(def.fields.find((f) => f.key === 'type')!.options!.map((o) => o.value));
    const m = effectiveCategoryOptions(def, { qualifications: { field: 'type', rows: [row('c_k', '新', 100, { custom: true })] } })!;
    expect(m.at(-1)!.value).toBe('c_k');
  });
  it('权限键只在 navigation 定义一次，并出现在可授予权限清单里', () => {
    expect(allGrantableKeys().has(SPECIAL_PERMISSIONS.resourceCategoriesManage)).toBe(true);
  });
  it('校验：动态选项让自建分类值通过，不在其中仍被拒；记录原值不动也合法', () => {
    const def = getResourceDef('qualifications')!;
    const ok = validateResourceInput(def, { name: '甲', type: 'c_k' }, { status: 'normal', dynamicOptions: { type: ['general', 'c_k'] } });
    expect(ok.errors).toEqual([]);
    expect(validateResourceInput(def, { name: '甲', type: 'c_k' }, { status: 'normal' }).errors.join()).toContain('取值不合法');
    expect(validateResourceInput(def, { name: '甲', type: 'c_old' }, { status: 'normal', existing: { type: 'c_old' }, dynamicOptions: { type: ['general'] } }).errors).toEqual([]);
  });
});
