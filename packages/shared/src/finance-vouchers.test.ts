import { describe, expect, it } from 'vitest';
import { allocateDiscount, buildEntries, docTotal, DOC_TYPE_MAP, validateDoc, type DocInput } from './finance-documents';

const sum = (e: Array<{ amount: number }>) => e.reduce((s, x) => s + x.amount, 0);
const prod = (id: number, qty: number, price: number) => ({ productId: id, qty, unitPriceCents: price });

describe('整单优惠（管家婆优惠金额/抹零）', () => {
  it('把优惠按行金额比例摊开，尾差补在最后一行，合计等于优惠', () => {
    expect(allocateDiscount([1000, 2000, 3000], 100)).toEqual([16, 33, 51]);
    expect(allocateDiscount([5, 0, 5], 1)).toEqual([0, 0, 1]);
    expect(allocateDiscount([100], 0)).toEqual([0]);
  });
  it('销售单：单据金额、应收、销售收入都按优惠后计，借贷平衡，成本不受影响', () => {
    const input: DocInput = { type: 'sale', date: '2026-10-29', partyId: 1, warehouseId: 2, discountCents: 300, lines: [prod(9, 10, 1000)] };
    const def = DOC_TYPE_MAP.get('sale')!;
    expect(docTotal(def, input)).toBe(9700);
    const e = buildEntries(input, () => 400);
    expect(sum(e)).toBe(0);
    expect(e.find((x) => x.kind === 'revenue')!.amount).toBe(-9700);
    expect(e.find((x) => x.kind === 'cogs')!.amount).toBe(4000);
  });
  it('采购入库：优惠摊进库存成本，应付按优惠后', () => {
    const input: DocInput = { type: 'purchase-in', date: '2026-10-29', partyId: 1, warehouseId: 2, discountCents: 100, lines: [prod(1, 1, 3000), prod(2, 1, 1000)] };
    const e = buildEntries(input, () => null);
    expect(sum(e)).toBe(0);
    expect(e.filter((x) => x.kind === 'inventory').map((x) => x.amount)).toEqual([2925, 975]);
    expect(e.find((x) => x.kind === 'payable')!.amount).toBe(-3900);
  });
  it('采购退货：库存按优惠后转出', () => {
    const e = buildEntries({ type: 'purchase-return', date: '2026-10-29', partyId: 1, warehouseId: 2, discountCents: 100, lines: [prod(1, 1, 3000), prod(2, 1, 1000)] }, () => null);
    expect(sum(e)).toBe(0);
    expect(e.filter((x) => x.kind === 'inventory').map((x) => x.amount)).toEqual([-2925, -975]);
  });
  it('只有商品类单据能填优惠，优惠不能大于等于明细合计', () => {
    expect(validateDoc({ type: 'expense', date: '2026-10-29', discountCents: 1, lines: [{ feeItemId: 1, qty: 1, unitPriceCents: 500 }] }).join()).toContain('只有商品类单据能填优惠金额');
    expect(validateDoc({ type: 'sale', date: '2026-10-29', partyId: 1, warehouseId: 1, discountCents: 1000, lines: [prod(1, 1, 1000)] }).join()).toContain('优惠金额必须小于明细合计');
    expect(validateDoc({ type: 'sale', date: '2026-10-29', partyId: 1, warehouseId: 1, discountCents: 999, lines: [prod(1, 1, 1000)] })).toEqual([]);
  });
});

describe('费用单用预付款结算（旧版“用预付款结算”）', () => {
  const base: DocInput = { type: 'expense', date: '2026-10-29', partyId: 7, partyKind: 'supplier', lines: [{ feeItemId: 3, qty: 1, unitPriceCents: 10000 }] };
  it('预付冲抵 + 当场付款 + 余额挂应付，借贷平衡', () => {
    const input = { ...base, offsetCents: 4000, paidCents: 3000, bankAccountId: 5 };
    expect(validateDoc(input)).toEqual([]);
    const e = buildEntries(input, () => null);
    expect(sum(e)).toBe(0);
    expect(e.find((x) => x.kind === 'prepayment')!.amount).toBe(-4000);
    expect(e.find((x) => x.kind === 'payable')!.amount).toBe(-3000);
    expect(e.find((x) => x.kind === 'bank')!.amount).toBe(-3000);
  });
  it('全部用预付款结算时不用选付款账户，也不挂应付', () => {
    const input = { ...base, offsetCents: 10000, paidCents: 0 };
    expect(validateDoc(input)).toEqual([]);
    expect(buildEntries(input, () => null).some((x) => x.kind === 'payable')).toBe(false);
  });
  it('冲抵必须选往来对象；冲抵不能超过单据金额', () => {
    expect(validateDoc({ ...base, partyId: null, offsetCents: 1000, paidCents: 9000, bankAccountId: 1 }).join()).toContain('冲抵预付款要先选择');
    expect(validateDoc({ ...base, offsetCents: 20000 }).join()).toContain('冲抵金额不能超过单据金额');
  });
});
