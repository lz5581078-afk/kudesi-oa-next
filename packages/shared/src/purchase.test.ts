import { describe, expect, it } from 'vitest';
import {
  allocateCents, allocateFees, approvalCents, batchStageLabel, currentBatch, emptyPurchaseState, nextStepKey, prepayUsage, remainingQty, returnBlockedReason,
  shipmentOutstanding, toShipQty, type Batch, type PurchaseLine, type PurchaseState,
} from './purchase';
import { getFlowTemplate, validateSteps } from './flow';

const line = (productId: number, qty: number): PurchaseLine => ({ productId, qty, unit: '斤', name: `商品${productId}`, code: `P${productId}`, weightG: 500 });
const lines = [line(1, 10), line(2, 4)];
const batch = (over: Partial<Batch> = {}): Batch => ({ id: 'b1', shipmentId: 's1', shipment: [{ productId: 1, qty: 10 }], logisticsNo: 'SF1', expectedArrivalAt: '2026-11-01', dispatchFiles: [1], fees: [], ...over });
const state = (over: Partial<PurchaseState> = {}): PurchaseState => ({ ...emptyPurchaseState(), prices: { '1': 250, '2': 1000 }, ...over });

describe('采购数量与金额', () => {
  it('批准金额 = 已入库货款 + 剩余数量 × 单价；数量乘单价后才结算到分', () => {
    expect(approvalCents(lines, state())).toBe(10 * 250 + 4 * 1000);
    expect(approvalCents(lines, state({ prices: { '1': 250 } }))).toBeNull();
    // 4 位小数的单价：3 件 × 33.3333 分 = 99.9999 分 → 100 分
    expect(approvalCents([line(1, 3)], state({ prices: { '1': 33.3333 } }))).toBe(100);
    const done = state({ batches: [batch({ posted: true, goodsCents: 2500, accepted: [{ productId: 1, qty: 10, unitPriceCents: 250 }] })] });
    expect(remainingQty(done, lines[0])).toBe(0);
    expect(remainingQty(done, lines[1])).toBe(4);
    expect(approvalCents(lines, done)).toBe(2500 + 4000);
  });
  it('终止的数量不再算剩余和批准金额', () => {
    const s = state({ cancelledQty: { '2': 4 } });
    expect(remainingQty(s, lines[1])).toBe(0);
    expect(approvalCents(lines, s)).toBe(2500);
  });
  it('待发货数量：退回换货、确认缺失的数量要补发', () => {
    const sh = { id: 's1', lines: [{ productId: 1, qty: 6 }], logisticsNo: 'x', expectedArrivalAt: '', files: [], closedMissing: { '1': 1 }, returned: { '1': 2 } };
    const s = state({ shipments: [sh] });
    expect(toShipQty(s, lines[0])).toBe(10 - (6 - 2 - 1));
    expect(shipmentOutstanding(s, sh, 1)).toBe(5);
  });
});

describe('费用分摊', () => {
  it('最大余数法：各份相加正好等于总额', () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateCents(100, [0, 0])).toBeNull();
    expect(allocateCents(5, [1, 2, 2])!.reduce((a, b) => a + b, 0)).toBe(5);
  });
  it('按货值、数量、重量分摊运费和装卸费', () => {
    const ls = [{ productId: 1, qty: 10, unitPriceCents: 250, weightG: 500 }, { productId: 2, qty: 4, unitPriceCents: 1000, weightG: 1000 }];
    const fees = [{ type: 'freight' as const, amountCents: 130 }, { type: 'handling' as const, amountCents: 13 }];
    const byValue = allocateFees(ls, fees, 'value')!;
    expect(byValue.reduce((a, r) => a + r.freightCents, 0)).toBe(130);
    expect(byValue.reduce((a, r) => a + r.handlingCents, 0)).toBe(13);
    expect(byValue[0].freightCents).toBe(Math.round((130 * 2500) / 6500));
    expect(allocateFees(ls, fees, 'quantity')![0].freightCents).toBe(93);
    expect(allocateFees(ls, fees, 'weight')![1].freightCents).toBeGreaterThan(allocateFees(ls, fees, 'weight')![0].freightCents - 100);
    expect(allocateFees([{ ...ls[0], weightG: 0 }], fees, 'weight')).toBeNull();
  });
});

describe('预付款占用', () => {
  it('冲抵先用新付款（按付款先后），再用已有预付款；没用掉的可退或释放', () => {
    const pay = (docId: number, amountCents: number) => ({ docId, docNo: `YF${docId}`, amountCents, bankAccountId: 1, reference: `r${docId}`, files: [], payeeName: 'a', payeeAccount: 'b' });
    const s = state({ payments: [pay(1, 1000), pay(2, 500)], prepayClaimCents: 300, batches: [batch({ offsetCents: 1200, posted: true })] });
    const u = prepayUsage(s);
    expect(u).toMatchObject({ newCents: 1500, claimCents: 300, reservedCents: 1800, consumedCents: 1200, unusedCents: 600, unusedClaimCents: 300 });
    expect(u.perDoc.map((d) => d.unusedCents)).toEqual([0, 300]);
    expect(prepayUsage(state({ payments: [pay(1, 1000)], prepayClaimCents: 300, batches: [batch({ offsetCents: 1100 })] })).unusedClaimCents).toBe(200);
  });
});

describe('条件流转（沿用旧系统路由）', () => {
  it('收货、质检有异常去异常处理，没有就往下', () => {
    expect(nextStepKey('receive', lines, state({ batches: [batch({ pendingException: true })] }))).toBe('exception');
    expect(nextStepKey('receive', lines, state({ batches: [batch()] }))).toBe('quality');
    expect(nextStepKey('quality', lines, state({ batches: [batch()] }))).toBe('expense');
    expect(nextStepKey('quality', lines, state({ batches: [batch({ pendingException: true })] }))).toBe('exception');
    expect(nextStepKey('apply', lines, state())).toBeUndefined();
  });
  it('异常处理后：终止退款去退款，整批重发回发货，否则回质检', () => {
    expect(nextStepKey('exception', lines, state({ cancelApproved: true, batches: [batch()] }))).toBe('refund');
    expect(nextStepKey('exception', lines, state({ batches: [batch({ retryShipment: true })] }))).toBe('dispatch');
    expect(nextStepKey('exception', lines, state({ batches: [batch()] }))).toBe('quality');
    expect(nextStepKey('refund', lines, state())).toBe('end');
  });
  it('结算后：有费用待付去付费用，还有没到的回发货，都完了结束', () => {
    const unpaid = batch({ posted: true, fees: [{ id: 'f', type: 'freight', amountCents: 10, payeeName: 'a', payeeAccount: 'b', files: [], paid: false }] });
    expect(nextStepKey('settle', lines, state({ batches: [unpaid] }))).toBe('expense_pay');
    expect(nextStepKey('settle', lines, state({ batches: [batch({ posted: true, accepted: [{ productId: 1, qty: 10, unitPriceCents: 250 }] })] }))).toBe('dispatch');
    const all = state({ cancelledQty: { '2': 4 }, batches: [batch({ posted: true, accepted: [{ productId: 1, qty: 10, unitPriceCents: 250 }] })] });
    expect(nextStepKey('settle', lines, all)).toBe('end');
    expect(nextStepKey('expense_pay', lines, state({ batches: [batch({ posted: true })] }))).toBe('dispatch');
  });
});

describe('退回限制与批次进度', () => {
  it('已付款后不能退回到付款前；已入库不能退回结算；换货后不能退回收货', () => {
    expect(returnBlockedReason('plan', state())).toBeNull();
    const paid = state({ payments: [{ docId: 1, docNo: 'x', amountCents: 1, bankAccountId: 1, reference: 'r', files: [], payeeName: '', payeeAccount: '' }] });
    expect(returnBlockedReason('pay', paid)).toContain('货款已安排');
    expect(returnBlockedReason('expense', paid)).toBeNull();
    const swapped = state({ batches: [batch({ returnedLines: [{ productId: 1, qty: 1 }] })] });
    expect(returnBlockedReason('quality', swapped)).toBe('本批已退回换货，不能再退回收货核对');
    expect(returnBlockedReason('receive', swapped)).toBeNull();
    expect(returnBlockedReason('settle', state({ batches: [batch({ posted: true })] }))).toBe('本批已入库过账，不能退回');
    expect(returnBlockedReason('dispatch', state())).toBe('这一步不能退回');
  });
  it('批次进度的人话', () => {
    expect(batchStageLabel(batch())).toBe('运输中');
    expect(batchStageLabel(batch({ arrived: true }))).toBe('待核对实收');
    expect(batchStageLabel(batch({ received: [] }))).toBe('待质检');
    expect(batchStageLabel(batch({ accepted: [] }))).toBe('待申报费用');
    expect(batchStageLabel(batch({ accepted: [], feesDeclared: true }))).toBe('待财务结算');
    expect(batchStageLabel(batch({ pendingException: true }))).toBe('异常处理中');
    expect(batchStageLabel(batch({ posted: true }))).toBe('已入库');
    expect(currentBatch(state())).toBeUndefined();
  });
});

describe('采购申请流程模板', () => {
  it('锁定的步骤齐全且顺序固定；默认步骤必须配置办理人才能发布', () => {
    const t = getFlowTemplate('purchase-request')!;
    expect(t.steps.map((s) => s.key)).toEqual(['apply', 'plan', 'approve', 'pay', 'prepay_review', 'dispatch', 'arrival', 'receive', 'quality', 'exception', 'refund', 'expense', 'settle', 'expense_pay', 'end']);
    expect(validateSteps(t, t.steps).length).toBeGreaterThan(0);
    const assigned = t.steps.map((s) => (s.type === 'submit' || s.type === 'end' ? s : { ...s, assignee: { source: 'employee' as const, id: 7 } }));
    expect(validateSteps(t, assigned)).toEqual([]);
    expect(validateSteps(t, assigned.filter((s) => s.key !== 'exception')).join()).toContain('缺少业务必须的步骤');
  });
});
