import { describe, expect, it } from 'vitest';
import { FLOW_TEMPLATES, normalizeSpecs, normalizeWarehouse, validateSteps } from './index';

describe('SKU 批量申请：规格清单', () => {
  it('规格名称不能为空或重复（忽略大小写），至少一个主商品，同商品数量合并', () => {
    expect(normalizeSpecs([]).errors[0]).toMatch(/至少/);
    expect(normalizeSpecs([{ name: '', main: [{ baseCodeId: 1, qty: 1 }] }]).errors.join()).toMatch(/名称/);
    expect(normalizeSpecs([{ name: 'A', main: [{ baseCodeId: 1, qty: 1 }] }, { name: 'a', main: [{ baseCodeId: 2, qty: 1 }] }]).errors.join()).toMatch(/重复/);
    expect(normalizeSpecs([{ name: 'A', main: [] }]).errors.join()).toMatch(/主商品/);
    const ok = normalizeSpecs([{ name: ' A ', main: [{ baseCodeId: 1, qty: 1 }, { baseCodeId: 1, qty: 2 }], gift: [{ baseCodeId: 3, qty: 1 }] }]);
    expect(ok.errors).toEqual([]);
    expect(ok.specs[0]).toEqual({ name: 'A', main: [{ baseCodeId: 1, qty: 3 }], gift: [{ baseCodeId: 3, qty: 1 }] });
  });
  it('数量必须是正整数；最多 100 个规格', () => {
    expect(normalizeSpecs([{ name: 'A', main: [{ baseCodeId: 1, qty: 0.5 }] }]).errors.join()).toMatch(/整数/);
    expect(normalizeSpecs(Array.from({ length: 101 }, (_, i) => ({ name: `s${i}`, main: [{ baseCodeId: 1, qty: 1 }] }))).errors[0]).toMatch(/最多 100/);
  });
});

describe('SKU 批量申请：仓库配置', () => {
  const names = ['甲'];
  it('四类每类要么有物料，要么写明不需要的原因', () => {
    const r = normalizeWarehouse([{ lines: [{ role: 'package', baseCodeId: 1, qty: 1 }], notRequired: { label: '无' } }], names);
    expect(r.errors.join()).toMatch(/其他打包材料/);
    expect(r.errors.join()).toMatch(/人工/);
    const ok = normalizeWarehouse([{ lines: [{ role: 'package', baseCodeId: 1, qty: 1 }, { role: 'instruction', baseCodeId: 2, qty: 1 }, { role: 'labor', laborId: 3, qty: 2 }], notRequired: { other: '无' } }], names);
    expect(ok.errors).toEqual([]);
  });
  it('配置条数必须和规格对上；物料数量必须大于 0', () => {
    expect(normalizeWarehouse([], names).errors[0]).toMatch(/对不上/);
    expect(normalizeWarehouse([{ lines: [{ role: 'package', baseCodeId: 1, qty: 0 }], notRequired: {} }], names).errors.join()).toMatch(/数量/);
  });
});

describe('SKU 批量申请：流程模板', () => {
  const t = FLOW_TEMPLATES.find((x) => x.key === 'sku-batch-apply')!;
  it('运营申请 → 仓库完善 → 财务审核 → 结束，步骤都锁定，办理表单字段齐全', () => {
    expect(t.steps.map((s) => s.key)).toEqual(['apply', 'warehouse', 'review', 'end']);
    expect(t.steps.every((s) => s.locked)).toBe(true);
    expect(t.stepFields.warehouse.map((f) => f.key)).toContain('config');
    expect(t.stepFields.review.map((f) => f.key)).toEqual(['confirmed', 'syncToJst']);
  });
  it('管理员不能删掉仓库或财务步骤', () => {
    const emp = (key: string, name: string, type: 'execute' | 'finance') => ({ key, name, type, assignee: { source: 'employee' as const, id: 1 } });
    const full = [t.steps[0], emp('warehouse', '仓库完善', 'execute'), emp('review', '财务审核', 'finance'), t.steps[3]];
    expect(validateSteps(t, full)).toEqual([]);
    expect(validateSteps(t, [t.steps[0], emp('review', '财务审核', 'finance'), t.steps[3]]).join()).toMatch(/缺少业务必须的步骤/);
  });
});
