import { describe, expect, it } from 'vitest';
import { FLOW_TEMPLATES, getFlowTemplate, validatePostingDecl, validateSteps, type StepDef } from './flow';
import { acceptedLines, applyReceipt, normalizeLines, normalizePrices, normalizeReceipt, priceLines, shanghaiToday } from './purchase';

const tpl = getFlowTemplate('purchase-request')!;
const lines = [{ productId: 11, qty: 100 }, { productId: 12, qty: 2.5 }];

describe('采购申请明细', () => {
  it('规范化：商品不重复、数量大于 0 且最多 4 位小数', () => {
    expect(normalizeLines([{ productId: 1, qty: '3.25', unit: ' 箱 ' }]).lines).toEqual([{ productId: 1, qty: 3.25, unit: '箱' }]);
    expect(normalizeLines([]).errors.length).toBe(1);
    expect(normalizeLines([{ productId: 1, qty: 1 }, { productId: 1, qty: 2 }]).errors.join()).toContain('重复');
    expect(normalizeLines([{ productId: 1, qty: 0 }]).errors.join()).toContain('大于 0');
    expect(normalizeLines([{ productId: 1, qty: 1.00001 }]).errors.length).toBe(1);
    expect(normalizeLines([{ productId: 0, qty: 1 }]).errors.join()).toContain('没有选择商品');
    expect(normalizeLines(Array.from({ length: 101 }, (_, i) => ({ productId: i + 1, qty: 1 }))).errors.join()).toContain('最多 100');
  });
  it('单价必须一一对应、大于 0、最多 4 位小数（分）', () => {
    expect(normalizePrices([{ productId: 11, unitPriceCents: 1250.5 }, { productId: 12, unitPriceCents: 800 }], lines).errors).toEqual([]);
    expect(normalizePrices([{ productId: 11, unitPriceCents: 1250 }], lines).errors.join()).toContain('还没有填');
    expect(normalizePrices([{ productId: 11, unitPriceCents: 0 }, { productId: 12, unitPriceCents: 1 }], lines).errors.join()).toContain('大于 0');
    expect(normalizePrices([{ productId: 11, unitPriceCents: 1.00001 }, { productId: 12, unitPriceCents: 1 }], lines).errors.length).toBeGreaterThan(0);
    expect(normalizePrices([{ productId: 99, unitPriceCents: 1 }, { productId: 11, unitPriceCents: 1 }, { productId: 12, unitPriceCents: 1 }], lines).errors.join()).toContain('没有的商品');
  });
  it('数量乘单价之后才结算到分，合计是各行分之和', () => {
    // 100 × 12.505 元（1250.5 分）= 1250.5 × 100 = 125050 分；2.5 × 8 元 = 2000 分
    const r = priceLines(lines, [{ productId: 11, unitPriceCents: 1250.5 }, { productId: 12, unitPriceCents: 800 }]);
    expect(r.items.map((i) => i.amountCents)).toEqual([125050, 2000]);
    expect(r.totalCents).toBe(127050);
    // 3 件 × 0.3333 分 = 0.9999 分 → 1 分（先乘后舍入，不是先舍入单价）
    expect(priceLines([{ productId: 1, qty: 3 }], [{ productId: 1, unitPriceCents: 0.3333 }]).totalCents).toBe(1);
  });
});

describe('到货验收累计', () => {
  it('分批到货：累计合格数量到齐才算全部合格', () => {
    const a = applyReceipt(lines, undefined, [{ productId: 11, receivedQty: 60, acceptedQty: 60 }, { productId: 12, receivedQty: 2.5, acceptedQty: 2.5 }]);
    expect(a.errors).toEqual([]);
    expect(a.result).toBe('shortage');
    const b = applyReceipt(lines, a.state, [{ productId: 11, receivedQty: 40, acceptedQty: 40 }]);
    expect(b.result).toBe('ok');
    expect(b.state['11']).toEqual({ received: 100, accepted: 100 });
  });
  it('有不合格：收到的比合格的多就是“有不合格”；补发重验后合格数补齐则变为全部合格', () => {
    const a = applyReceipt(lines, undefined, [{ productId: 11, receivedQty: 100, acceptedQty: 90 }, { productId: 12, receivedQty: 2.5, acceptedQty: 2.5 }]);
    expect(a.result).toBe('defect');
    const b = applyReceipt(lines, a.state, [{ productId: 11, receivedQty: 10, acceptedQty: 10 }]);
    expect(b.result).toBe('ok');
    expect(b.state['11']).toEqual({ received: 110, accepted: 100 });
  });
  it('合格累计不能超过申请数量；小数累加不丢精度', () => {
    expect(applyReceipt(lines, undefined, [{ productId: 11, receivedQty: 101, acceptedQty: 101 }]).errors.join()).toContain('超过了申请数量');
    const s = applyReceipt([{ productId: 1, qty: 0.3 }], undefined, [{ productId: 1, receivedQty: 0.1, acceptedQty: 0.1 }]);
    const t = applyReceipt([{ productId: 1, qty: 0.3 }], s.state, [{ productId: 1, receivedQty: 0.2, acceptedQty: 0.2 }]);
    expect(t.result).toBe('ok');
  });
  it('本次登记校验：合格不能大于到货；商品必须在申请里；至少有一行到货', () => {
    expect(normalizeReceipt([{ productId: 11, receivedQty: 5, acceptedQty: 6 }], lines).errors.join()).toContain('合格数量不能大于到货');
    expect(normalizeReceipt([{ productId: 99, receivedQty: 5, acceptedQty: 5 }], lines).errors.join()).toContain('不在这张采购申请');
    expect(normalizeReceipt([{ productId: 11, receivedQty: 0, acceptedQty: 0 }], lines).errors.join()).toContain('没有登记任何到货');
    expect(normalizeReceipt([{ productId: 11, receivedQty: 0, acceptedQty: 0 }], lines, true).errors).toEqual([]);
    expect(normalizeReceipt([{ productId: 11, receivedQty: 5, acceptedQty: 5 }], lines).errors).toEqual([]);
  });
  it('只列出合格数量大于 0 的商品', () => {
    expect(acceptedLines([{ productId: 11, qty: 100, unit: '箱' }, { productId: 12, qty: 2 }], { '11': { received: 5, accepted: 4 }, '12': { received: 1, accepted: 0 } })).toEqual([{ productId: 11, qty: 4, unit: '箱' }]);
  });
  it('上海时区的今天', () => {
    expect(shanghaiToday(new Date('2026-10-28T17:00:00Z'))).toBe('2026-10-29');
  });
});

describe('采购申请流程模板', () => {
  const withPeople = (): StepDef[] => tpl.steps.map((s) => (s.type === 'approval' || s.type === 'execute' || s.type === 'finance' ? { ...s, assignee: { source: 'employee' as const, id: 7 } } : { ...s }));
  it('默认步骤与办理人建议是合法的结构（办理人由管理员确认后才能发布）', () => {
    expect(validateSteps(tpl, tpl.steps)).toEqual([]);
    expect(validateSteps(tpl, withPeople())).toEqual([]);
    expect(validatePostingDecl(tpl)).toEqual([]);
    expect(FLOW_TEMPLATES.filter((t) => t.key === 'purchase-request').length).toBe(1);
  });
  it('金额条件只作用在老板审批上，且读采购方案步骤算出的金额', () => {
    const boss = tpl.steps.find((s) => s.key === 'boss_review')!;
    expect(boss.when).toMatchObject({ field: 'form.plan.amountCents', op: 'gte' });
    expect(tpl.stepFields.plan.some((f) => f.key === 'amountCents' && f.readonly && f.permission === 'product.cost.view')).toBe(true);
  });
  it('单价、金额类字段全部要成本查看权限；业务必须的步骤不能删', () => {
    const money = [...tpl.fields, ...Object.values(tpl.stepFields).flat()].filter((f) => f.key === 'prices' || f.key === 'estimates' || f.key === 'amountCents' || f.key === 'paidCents' || f.key === 'refundedCents' || f.key === 'expectedRefundCents');
    expect(money.length).toBeGreaterThan(5);
    for (const f of money) expect(f.permission).toBe('product.cost.view');
    expect(validateSteps(tpl, withPeople().filter((s) => s.key !== 'receive')).join()).toContain('缺少业务必须的步骤');
    expect(validateSteps(tpl, withPeople().filter((s) => s.key !== 'finance_review')).join()).toBe('');
  });
});
