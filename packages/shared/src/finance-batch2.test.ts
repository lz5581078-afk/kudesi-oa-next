import { describe, expect, it } from 'vitest';
import { buildEntries, buildTransferConfirmEntries, hasMoneyDiscount, negateEntries, payRole, validateDoc, DOC_TYPE_MAP, type DocInput, type Entry } from './finance-documents';

const sum = (e: Entry[]) => e.reduce((s, x) => s + x.amount, 0);
const kind = (e: Entry[], k: string) => e.filter((x) => x.kind === k).reduce((s, x) => s + x.amount, 0);
const money = (itemName: string, cents: number) => ({ itemName, qty: 1, unitPriceCents: cents });
const prod = (id: number, qty: number, price: number) => ({ productId: id, qty, unitPriceCents: price });

describe('收款单/付款单优惠金额（A8：优惠冲减往来，计入财务费用）', () => {
  it('收款优惠：银行只收到钱，应收减少 = 到账 + 优惠，财务费用借记，借贷平衡', () => {
    const e = buildEntries({ type: 'receipt', date: '2026-10-29', partyId: 1, bankAccountId: 9, discountCents: 1000, lines: [money('回款', 9000)] }, () => null);
    expect(sum(e)).toBe(0);
    expect(kind(e, 'bank')).toBe(9000);
    expect(kind(e, 'receivable')).toBe(-10000);
    expect(kind(e, 'finance_cost')).toBe(1000);
  });
  it('收款优惠叠加预收冲抵：应收减少 = 到账 + 冲抵 + 优惠', () => {
    const e = buildEntries({ type: 'receipt', date: '2026-10-29', partyId: 1, bankAccountId: 9, offsetCents: 500, discountCents: 200, lines: [money('回款', 1000)] }, () => null);
    expect(sum(e)).toBe(0);
    expect(kind(e, 'receivable')).toBe(-1700);
    expect(kind(e, 'advance_receipt')).toBe(500);
  });
  it('付款优惠：应付减少 = 付出 + 优惠，财务费用贷记（得到的折扣）', () => {
    const e = buildEntries({ type: 'payment', date: '2026-10-29', partyId: 1, bankAccountId: 9, discountCents: 300, lines: [money('货款', 9700)] }, () => null);
    expect(sum(e)).toBe(0);
    expect(kind(e, 'payable')).toBe(10000);
    expect(kind(e, 'bank')).toBe(-9700);
    expect(kind(e, 'finance_cost')).toBe(-300);
  });
  it('不填优惠时分录和以前完全一样；红冲整体取反', () => {
    const e = buildEntries({ type: 'receipt', date: '2026-10-29', partyId: 1, bankAccountId: 9, lines: [money('回款', 500)] }, () => null);
    expect(e.map((x) => [x.kind, x.amount])).toEqual([['bank', 500], ['receivable', -500]]);
    const d = buildEntries({ type: 'receipt', date: '2026-10-29', partyId: 1, bankAccountId: 9, discountCents: 50, lines: [money('回款', 500)] }, () => null);
    expect(sum(negateEntries(d))).toBe(0);
    expect(kind(negateEntries(d), 'finance_cost')).toBe(-50);
  });
  it('校验：只有收付款单和商品类单据能填；收付款优惠要选往来对象；结算单据合计包含优惠', () => {
    expect(hasMoneyDiscount('receipt') && hasMoneyDiscount('payment') && !hasMoneyDiscount('advance-receipt')).toBe(true);
    expect(validateDoc({ type: 'receipt', date: '2026-10-29', bankAccountId: 1, discountCents: 10, lines: [money('回款', 500)] }).join()).toContain('先选择');
    expect(validateDoc({ type: 'receipt', date: '2026-10-29', partyId: 1, bankAccountId: 1, discountCents: 10, lines: [money('回款', 500)] })).toEqual([]);
    expect(validateDoc({ type: 'advance-receipt', date: '2026-10-29', partyId: 1, bankAccountId: 1, discountCents: 10, amountCents: 500 }).join()).toContain('只有商品类单据能填优惠金额');
    const base: DocInput = { type: 'receipt', date: '2026-10-29', partyId: 1, bankAccountId: 1, discountCents: 100, settleBy: 'doc', lines: [money('回款', 900)] };
    expect(validateDoc({ ...base, settlements: [{ sourceDocId: 5, amountCents: 900 }] }).join()).toContain('结算单据合计');
    expect(validateDoc({ ...base, settlements: [{ sourceDocId: 5, amountCents: 1000 }] })).toEqual([]);
  });
});

describe('多账户收付款', () => {
  it('payRole：哪些单据能分账户、钱往哪个方向', () => {
    const r = (t: string) => payRole(DOC_TYPE_MAP.get(t as never)!);
    expect([r('sale'), r('online-sale'), r('purchase-return'), r('receipt'), r('advance-receipt'), r('other-income')]).toEqual(['in', 'in', 'in', 'in', 'in', 'in']);
    expect([r('sale-return'), r('purchase-in'), r('payment'), r('prepayment'), r('expense')]).toEqual(['out', 'out', 'out', 'out', 'out']);
    expect([r('transfer'), r('withdrawal')]).toEqual([null, null]);
  });
  it('销售单分账户：每个账户一条银行分录，合计即实收，剩余挂应收', () => {
    const input: DocInput = { type: 'sale', date: '2026-10-29', partyId: 1, warehouseId: 2, accounts: [{ role: 'in', bankAccountId: 11, amountCents: 4000 }, { role: 'in', bankAccountId: 12, amountCents: 3000 }], lines: [prod(1, 10, 1000)] };
    expect(validateDoc(input)).toEqual([]);
    const e = buildEntries(input, () => 300);
    expect(sum(e)).toBe(0);
    expect(e.filter((x) => x.kind === 'bank').map((x) => [x.accountId, x.amount])).toEqual([[11, 4000], [12, 3000]]);
    expect(kind(e, 'receivable')).toBe(3000);
  });
  it('采购入库、付款单、收款单分账户；账户合计不等于金额一律拒绝', () => {
    const pin: DocInput = { type: 'purchase-in', date: '2026-10-29', partyId: 1, warehouseId: 2, accounts: [{ role: 'out', bankAccountId: 11, amountCents: 500 }, { role: 'out', bankAccountId: 12, amountCents: 500 }], lines: [prod(1, 4, 500)] };
    expect(validateDoc(pin)).toEqual([]);
    const e = buildEntries(pin, () => null);
    expect(sum(e)).toBe(0);
    expect(kind(e, 'bank')).toBe(-1000);
    expect(kind(e, 'payable')).toBe(-1000);
    const pay: DocInput = { type: 'payment', date: '2026-10-29', partyId: 1, accounts: [{ role: 'out', bankAccountId: 11, amountCents: 100 }, { role: 'out', bankAccountId: 12, amountCents: 200 }], lines: [money('货款', 300)] };
    expect(validateDoc(pay)).toEqual([]);
    expect(validateDoc({ ...pay, lines: [money('货款', 350)] }).join()).toContain('各账户金额合计');
    expect(validateDoc({ ...pin, paidCents: 900 }).join()).toContain('各账户金额合计');
  });
  it('方向错、重复账户、金额不合法、不支持的单据', () => {
    const base: DocInput = { type: 'receipt', date: '2026-10-29', partyId: 1, lines: [money('回款', 1000)] };
    expect(validateDoc({ ...base, accounts: [{ role: 'out', bankAccountId: 1, amountCents: 1000 }] }).join()).toContain('方向不对');
    expect(validateDoc({ ...base, accounts: [{ role: 'in', bankAccountId: 1, amountCents: 500 }, { role: 'in', bankAccountId: 1, amountCents: 500 }] }).join()).toContain('不能重复');
    expect(validateDoc({ ...base, accounts: [{ role: 'in', bankAccountId: 1, amountCents: 0 }, { role: 'in', bankAccountId: 2, amountCents: 1000 }] }).join()).toContain('大于 0');
    expect(validateDoc({ type: 'withdrawal', date: '2026-10-29', storeId: 1, refNo: 'a', amountCents: 100, accounts: [{ role: 'in', bankAccountId: 1, amountCents: 100 }] }).join()).toContain('不能分多个账户');
  });
  it('单账户写法（老单据）不受影响；分账户 + 收款优惠 + 预收冲抵一起算也平衡', () => {
    const old: DocInput = { type: 'sale', date: '2026-10-29', partyId: 1, warehouseId: 2, bankAccountId: 11, paidCents: 500, lines: [prod(1, 1, 1000)] };
    expect(validateDoc(old)).toEqual([]);
    expect(buildEntries(old, () => 100).filter((x) => x.kind === 'bank').map((x) => [x.accountId, x.amount])).toEqual([[11, 500]]);
    const e = buildEntries({ type: 'receipt', date: '2026-10-29', partyId: 1, offsetCents: 100, discountCents: 50, accounts: [{ role: 'in', bankAccountId: 1, amountCents: 300 }, { role: 'in', bankAccountId: 2, amountCents: 200 }], lines: [money('回款', 500)] }, () => null);
    expect(sum(e)).toBe(0);
    expect(kind(e, 'receivable')).toBe(-650);
  });
});

describe('转款手续费、在途与确认入账', () => {
  const tr = (extra: Partial<DocInput>): DocInput => ({ type: 'transfer', date: '2026-10-29', accounts: [{ role: 'out', bankAccountId: 1, amountCents: 5000 }, { role: 'in', bankAccountId: 2, amountCents: 5000 }], lines: [money('调拨', 5000)], ...extra });
  const bankOf = (e: Entry[], id: number) => e.filter((x) => x.kind === 'bank' && x.accountId === id).reduce((s, x) => s + x.amount, 0);
  it('无手续费：分录和以前一样', () => {
    const e = buildEntries(tr({}), () => null);
    expect(e.map((x) => [x.kind, x.accountId, x.amount])).toEqual([['bank', 1, -5000], ['bank', 2, 5000]]);
    expect(validateDoc(tr({}))).toEqual([]);
  });
  it('转出方承担：转出账户多扣手续费；转入方承担：转入账户少收', () => {
    const out = buildEntries(tr({ feeCents: 30, feeBearer: 'out' }), () => null);
    expect(sum(out)).toBe(0);
    expect([bankOf(out, 1), bankOf(out, 2), kind(out, 'finance_cost')]).toEqual([-5030, 5000, 30]);
    const inn = buildEntries(tr({ feeCents: 30, feeBearer: 'in' }), () => null);
    expect([bankOf(inn, 1), bankOf(inn, 2), kind(inn, 'finance_cost')]).toEqual([-5000, 4970, 30]);
  });
  it('单账户老写法也能带手续费', () => {
    const e = buildEntries({ type: 'transfer', date: '2026-10-29', bankAccountId: 1, toBankAccountId: 2, amountCents: 100, feeCents: 5, feeBearer: 'out' }, () => null);
    expect([bankOf(e, 1), bankOf(e, 2)]).toEqual([-105, 100]);
  });
  it('在途：只扣转出账户，转入侧记在途资金；确认入账再转进银行，合计和直接转账一致', () => {
    const post = buildEntries(tr({ inTransit: true }), () => null);
    expect(sum(post)).toBe(0);
    expect([bankOf(post, 1), bankOf(post, 2), kind(post, 'in_transit')]).toEqual([-5000, 0, 5000]);
    const confirm = buildTransferConfirmEntries(tr({ inTransit: true }));
    expect(sum(confirm)).toBe(0);
    const all = [...post, ...confirm];
    expect([bankOf(all, 1), bankOf(all, 2), kind(all, 'in_transit')]).toEqual([-5000, 5000, 0]);
    expect(sum(negateEntries(all))).toBe(0);
  });
  it('在途 + 转入方承担手续费：手续费到确认那一刻才扣；转出方承担则过账就扣', () => {
    const post = buildEntries(tr({ inTransit: true, feeCents: 20, feeBearer: 'in' }), () => null);
    expect(kind(post, 'finance_cost')).toBe(0);
    const confirm = buildTransferConfirmEntries(tr({ inTransit: true, feeCents: 20, feeBearer: 'in' }));
    expect([bankOf(confirm, 2), kind(confirm, 'finance_cost')]).toEqual([4980, 20]);
    const postOut = buildEntries(tr({ inTransit: true, feeCents: 20, feeBearer: 'out' }), () => null);
    expect([bankOf(postOut, 1), kind(postOut, 'finance_cost')]).toEqual([-5020, 20]);
    expect(kind(buildTransferConfirmEntries(tr({ inTransit: true, feeCents: 20, feeBearer: 'out' })), 'finance_cost')).toBe(0);
  });
  it('校验：手续费要选承担方且只有转款单能填；在途只有转款单能登记；确认入账只给转款单', () => {
    expect(validateDoc(tr({ feeCents: 10 })).join()).toContain('承担');
    expect(validateDoc(tr({ feeCents: -1, feeBearer: 'out' })).join()).toContain('手续费');
    expect(validateDoc({ type: 'receipt', date: '2026-10-29', partyId: 1, bankAccountId: 1, feeCents: 10, feeBearer: 'out', lines: [money('回款', 100)] }).join()).toContain('只有转款单能填手续费');
    expect(validateDoc({ type: 'receipt', date: '2026-10-29', partyId: 1, bankAccountId: 1, inTransit: true, lines: [money('回款', 100)] }).join()).toContain('只有转款单能登记为在途');
    expect(() => buildTransferConfirmEntries({ type: 'receipt', date: '2026-10-29' })).toThrow();
  });
});
