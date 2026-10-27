import { describe, expect, it } from 'vitest';
import {
  LIVE_DEFAULT_RULES, LiveRuleError, liveArchiveHourlyRate, liveBuildSettlement, liveCanScheduleDay, liveCanSeeSession, liveComputeCommission,
  liveComputeWage, liveCountsAsRefund, liveFilterPreview, liveFromText, liveMissingReporter, liveRefundForOrder, liveReportRoleFor,
  liveRoundDiv, liveRulesFromInput, liveRulesToInput, liveRulesFromStored, liveCentsToYuan, liveWageMinutes, liveSettleLine, liveTierIndex, liveToText, liveVersionFor, liveRooms, liveGroupRooms, liveParseRoomName, liveRoomSide, liveNaturalCompare, liveYuanToCents, liveRefundKey,
} from './live';

const R = LIVE_DEFAULT_RULES;
const calc = (sales: number, ad?: number, rules = R) => liveComputeCommission({ rules, finalSalesCents: sales, adSpendCents: ad });

describe('金额与时间', () => {
  it('元转分只接受两位小数', () => {
    expect(liveYuanToCents('1,234.57')).toBe(123457);
    expect(liveYuanToCents('')).toBeNull();
    expect(() => liveYuanToCents('1.234')).toThrow(LiveRuleError);
    expect(() => liveYuanToCents('-1')).toThrow(LiveRuleError);
    expect(() => liveYuanToCents('', '销售额', { allowEmpty: false })).toThrow('请填写销售额');
  });
  it('北京时间墙钟互转，非法日期拒绝', () => {
    expect(liveToText('2026-03-01T08:30')).toBe('2026-03-01 08:30:00');
    expect(liveToText('2026-03-01T00:30:00Z')).toBe('2026-03-01 08:30:00');
    expect(liveFromText('2026-02-30 10:00')).toBeNull();
  });
  it('只能排今天到 7 天内', () => {
    const now = new Date('2026-03-01T02:00:00Z');
    expect(liveCanScheduleDay('2026-03-01', now)).toBe(true);
    expect(liveCanScheduleDay('2026-03-08', now)).toBe(true);
    expect(liveCanScheduleDay('2026-03-09', now)).toBe(false);
    expect(liveCanScheduleDay('2026-02-28', now)).toBe(false);
  });
});

describe('提成计算', () => {
  it('1234.57 元落第 1 档：主播 3%，中控 2%，运营 0.5%', () => {
    const r = calc(123457 - 123457 + 123457);
    expect(r.tierIndex).toBe(1);
    expect(r.anchor.amountCents).toBe(liveRoundDiv(123457 * 350, 10000));
    expect(r.anchor.amountCents).toBe(4321);
    expect(r.operator.amountCents).toBe(617);
  });
  it('含下限：恰好 1000 元进第二档；含上限进第一档', () => {
    expect(liveTierIndex(R, 100000)).toBe(1);
    expect(liveTierIndex({ ...R, boundary: 'max_inclusive' }, 100000)).toBe(0);
    expect(liveTierIndex({ ...R, boundary: 'max_inclusive' }, 0)).toBe(0);
    expect(liveTierIndex(R, 99999999)).toBe(4);
  });
  it('投产不足扣减点数，不低于 0；运营不受影响', () => {
    const r = calc(100000, 20000); // 投产 5 < 10
    expect(r.belowRoi).toBe(true);
    expect(r.anchor.rateUnits).toBe(350 - 200);
    expect(r.control.rateUnits).toBe(250 - 150);
    expect(r.operator.rateUnits).toBe(50);
    const low = calc(50000, 20000);
    expect(low.anchor.rateUnits).toBe(100);
    const clamp = liveComputeCommission({ rules: { ...R, belowRoiAnchorDeductUnits: 900 }, finalSalesCents: 50000, adSpendCents: 20000 });
    expect(clamp.anchor.rateUnits).toBe(0);
    expect(clamp.anchor.amountCents).toBe(0);
  });
  it('投产恰好等于阈值算达标；无投流按达标', () => {
    expect(calc(100000, 10000).belowRoi).toBe(false);
    expect(calc(100000, 10001).belowRoi).toBe(true);
    expect(calc(100000, 0).roiCounted).toBe(false);
    expect(calc(100000).belowRoi).toBe(false);
  });
  it('金额按半分进位', () => {
    expect(liveRoundDiv(5, 10)).toBe(1);
    expect(liveRoundDiv(4, 10)).toBe(0);
  });
});

describe('规则校验', () => {
  const ok = liveRulesToInput(R);
  it('默认规则往返不变', () => { expect(liveRulesFromInput(ok)).toEqual(R); });
  it('档位必须从 0 连续到无上限', () => {
    expect(() => liveRulesFromInput({ ...ok, tiers: [{ ...ok.tiers[0], min: '1' }] })).toThrow('从 0');
    const gap = JSON.parse(JSON.stringify(ok)); gap.tiers[1].min = '1500';
    expect(() => liveRulesFromInput(gap)).toThrow('不能有空缺');
    const last = JSON.parse(JSON.stringify(ok)); last.tiers[4].max = '9999';
    expect(() => liveRulesFromInput(last)).toThrow('最后一档');
    expect(() => liveRulesFromInput({ ...ok, tiers: [] })).toThrow(LiveRuleError);
  });
  it('比例超范围拒绝', () => {
    const bad = JSON.parse(JSON.stringify(ok)); bad.tiers[0].anchorRate = '101';
    expect(() => liveRulesFromInput(bad)).toThrow('0 到 100');
  });
  it('按生效日选最新版本', () => {
    const vs = [{ id: 1, effectiveFrom: '2026-01-01' }, { id: 2, effectiveFrom: '2026-03-01' }, { id: 3, effectiveFrom: '2026-03-01' }];
    expect(liveVersionFor(vs, '2026-02-28')?.id).toBe(1);
    expect(liveVersionFor(vs, '2026-03-01')?.id).toBe(3);
    expect(liveVersionFor(vs, '2025-12-31')).toBeNull();
  });
});

describe('主播工资', () => {
  it('按分钟计算', () => {
    expect(liveComputeWage({ startAt: '2026-03-01 20:00:00', endAt: '2026-03-01 22:30:00', hourlyRateCents: 5000 })).toEqual({ minutes: 150, hourlyRateCents: 5000, amountCents: 12500 });
    expect(liveComputeWage({ startAt: '2026-03-01 20:00:00', endAt: '2026-03-01 20:01:00', hourlyRateCents: 1 }).amountCents).toBe(0);
  });
  it('下播不晚于上播、超过 24 小时、无时薪都拒绝', () => {
    expect(() => liveComputeWage({ startAt: '2026-03-01 20:00:00', endAt: '2026-03-01 20:00:00', hourlyRateCents: 1 })).toThrow('晚于');
    expect(() => liveComputeWage({ startAt: '2026-03-01 00:00:00', endAt: '2026-03-02 00:01:00', hourlyRateCents: 1 })).toThrow('24');
    expect(() => liveComputeWage({ startAt: '2026-03-01 00:00:00', endAt: '2026-03-01 01:00:00', hourlyRateCents: null })).toThrow('时薪');
  });
  it('只有计时员工的档案时薪可作默认', () => {
    expect(liveArchiveHourlyRate({ payType: 'hourly', hourlyRate: 3000 })).toBe(3000);
    expect(liveArchiveHourlyRate({ payType: 'monthly', hourlyRate: 3000 })).toBeNull();
    expect(liveArchiveHourlyRate(null)).toBeNull();
  });
});

describe('月底结算', () => {
  it('扣减 = 退款 × 原比例，不超过提成', () => {
    expect(liveSettleLine({ commissionCents: 4321, rateUnits: 350, refundCents: 20000 })).toEqual({ deductionCents: 700, payableCents: 3621 });
    expect(liveSettleLine({ commissionCents: 100, rateUnits: 350, refundCents: 999999 })).toEqual({ deductionCents: 100, payableCents: 0 });
  });
  it('同场退款共用，合计按场次去重', () => {
    const records = [
      { id: 1, sessionId: 10, role: 'anchor', amountCents: 3500, rateUnits: 350 },
      { id: 2, sessionId: 10, role: 'control', amountCents: 2500, rateUnits: 250 },
    ];
    const orders = new Map([[10, [{ orderId: 'A', shopId: 's', amountCents: 100000 }, { orderId: 'B', shopId: 's', amountCents: 50000 }]]]);
    const refunds = new Map([[liveRefundKey('s', 'A'), { cents: 20000 }]]);
    const r = liveBuildSettlement(records, orders, refunds);
    expect(r.totals).toEqual({ count: 2, commissionCents: 6000, refundCents: 20000, deductionCents: 700 + 500, payableCents: 4800 });
  });
  it('退款判定：已完成、非换货、封顶订单金额；已取消订单整单退', () => {
    expect(liveCountsAsRefund({ status: 'Confirmed', type: '退货退款', refund: 10 })).toBe(true);
    expect(liveCountsAsRefund({ status: 'Confirmed', type: '换货', refund: 10 })).toBe(false);
    expect(liveCountsAsRefund({ status: 'Cancelled', refund: 10 })).toBe(false);
    expect(liveCountsAsRefund({ status: 'WaitConfirm', shop_status: 'WAIT_SELLER_AGREE', refund: 10 })).toBe(false);
    expect(liveRefundForOrder(5000, { status: 'Cancelled' }).cents).toBe(5000);
    const dup = [{ as_id: 1, status: 'Confirmed', refund: 30 }, { as_id: 1, status: 'Confirmed', refund: 30 }, { as_id: 2, status: 'Confirmed', refund: 40 }];
    expect(liveRefundForOrder(5000, { status: 'Confirmed' }, dup).cents).toBe(5000);
    expect(liveRefundForOrder(10000, null, dup).cents).toBe(7000);
  });
});

describe('场次权限与隐私', () => {
  const s = { anchorId: 1, controlId: 2, operatorId: 3, startedBy: 4, status: 'pending_report' };
  it('只有本人能为自己的角色报下播，管理者不能代填', () => {
    expect(liveReportRoleFor(1, s, 'anchor')).toBe('anchor');
    expect(liveReportRoleFor(1, s, 'control')).toBeNull();
    expect(liveReportRoleFor(9, s, 'anchor')).toBeNull();
    expect(liveReportRoleFor(2, s)).toBe('control');
  });
  it('可见：有权限或相关人员', () => {
    expect(liveCanSeeSession(false, 4, s)).toBe(true);
    expect(liveCanSeeSession(false, 9, s)).toBe(false);
    expect(liveCanSeeSession(true, 9, s)).toBe(true);
  });
  it('预估提成只给本人看，已审核不再试算', () => {
    const p = { available: true, anchor: { a: 1 }, control: { a: 2 }, operator: { a: 3 } };
    expect(liveFilterPreview(false, 1, s, p)).toMatchObject({ anchor: { a: 1 }, control: null, operator: null });
    expect(liveFilterPreview(true, 9, s, p)).toBe(p);
    expect(liveFilterPreview(false, 1, { ...s, status: 'approved' }, p)).toBeNull();
  });
  it('提交前必须主播和中控本人都已填报', () => {
    expect(liveMissingReporter([], s)).toBe('anchor');
    expect(liveMissingReporter([{ role: 'anchor', reporterId: 1 }], s)).toBe('control');
    expect(liveMissingReporter([{ role: 'anchor', reporterId: 9 }, { role: 'control', reporterId: 2 }], s)).toBe('anchor');
    expect(liveMissingReporter([{ role: 'anchor', reporterId: 1 }, { role: 'control', reporterId: 2 }], s)).toBeNull();
    expect(liveMissingReporter([{ role: 'anchor', reporterId: 1 }], { ...s, controlId: null })).toBeNull();
  });
});

describe('直播间', () => {
  it('南北分侧与自然排序', () => {
    expect(liveRoomSide('北1')).toBe('north');
    expect(liveRoomSide('南北通道')).toBe('none');
    expect(liveNaturalCompare('北2', '北10')).toBeLessThan(0);
    expect(liveNaturalCompare('北１０', '北9')).toBeGreaterThan(0);
    expect(liveParseRoomName('直播间-北3（大房间）')).toEqual({ isLive: true, side: 'north', shortName: '北3', big: true });
    expect(liveParseRoomName('直播间-南4（大）').big).toBe(true);
    expect(liveParseRoomName('大会议室').isLive).toBe(false);
  });
  it('只取西走廊下名称含直播间的启用房间，排除停用及其下级、柜内空间、已归档、其他走廊', () => {
    const L = (id: number, name: string, parentId: number | null, extra: Record<string, unknown> = {}) => ({ id, name, parentId, locationType: 'room', status: 'normal', ...extra });
    const rooms = liveRooms([
      L(1, '西走廊办公室', null), L(2, '直播间-北10', 1), L(3, '直播间-北2（大房间）', 1), L(4, '直播间-南1', 1), L(5, '样品直播间', 1),
      L(6, '直播间-北3', 1, { status: 'inactive' }), L(7, '直播间-北3内间', 6), L(8, '南区', 1, { locationType: 'floor' }), L(9, '直播间-南5(大)', 8),
      L(10, 'A柜', 2, { locationType: 'asset_slot', scope: 'asset_space' }), L(11, '第1层', 2, { locationType: 'shelf' }), L(12, '东走廊', null), L(13, '直播间-北1', 12),
      L(15, '财务综合办公室', 1), L(16, '大会议室', 1), L(14, '直播间-南9', 1, { archived: true }),
    ]);
    expect(rooms.map((r) => r.name)).toEqual(['直播间-北2（大房间）', '直播间-北10', '直播间-南1', '直播间-南5(大)', '样品直播间']);
    expect(rooms.map((r) => [r.shortName, r.big])).toEqual([['北2', true], ['北10', false], ['南1', false], ['南5', true], ['样品直播间', false]]);
    expect(rooms.find((r) => r.shortName === '南5')!.path).toBe('南区 / 直播间-南5(大)');
    const g = liveGroupRooms(rooms);
    expect(g.north.map((r) => r.shortName)).toEqual(['北2', '北10']);
    expect(g.south.map((r) => r.shortName)).toEqual(['南1', '南5']);
    expect(g.none.map((r) => r.name)).toEqual(['样品直播间']);
    expect(liveRooms([L(1, '西走廊办公室', null, { status: 'inactive' }), L(2, '直播间-北1', 1)])).toEqual([]);
  });
});

describe('月结（移植旧测试）', () => {
  it('扣减按分四舍五入，不超过原提成', () => {
    expect(liveSettleLine({ commissionCents: 5000, rateUnits: 200, refundCents: 20050 })).toEqual({ deductionCents: 401, payableCents: 4599 });
    expect(liveSettleLine({ commissionCents: 3750, rateUnits: 150, refundCents: 20050 })).toEqual({ deductionCents: 301, payableCents: 3449 });
    expect(liveSettleLine({ commissionCents: 100, rateUnits: 500, refundCents: 1_000_000 })).toEqual({ deductionCents: 100, payableCents: 0 });
    expect(liveSettleLine({ commissionCents: 100, rateUnits: 0, refundCents: 5000 })).toEqual({ deductionCents: 0, payableCents: 100 });
  });
  it('汇总：同一场主播、中控共用本场退款，退款合计按场次去重', () => {
    const built = liveBuildSettlement(
      [{ id: 1, sessionId: 10, role: 'anchor', amountCents: 5000, rateUnits: 200 }, { id: 2, sessionId: 10, role: 'control', amountCents: 3750, rateUnits: 150 }, { id: 3, sessionId: 11, role: 'anchor', amountCents: 3000, rateUnits: 300 }],
      new Map([[10, [{ orderId: 'A', shopId: '555', amountCents: 10000 }, { orderId: 'B', shopId: '555', amountCents: 10050 }]], [11, []]]),
      new Map([[liveRefundKey('555', 'A'), { cents: 10000 }], [liveRefundKey('555', 'B'), { cents: 10050 }]]),
    );
    expect(built.lines.map((l) => [l.refundCents, l.deductionCents, l.payableCents])).toEqual([[20050, 401, 4599], [20050, 301, 3449], [0, 0, 3000]]);
    expect(built.totals).toEqual({ count: 3, commissionCents: 11750, refundCents: 20050, deductionCents: 702, payableCents: 11048 });
  });
  it('不同聚水潭店铺的同号订单不串', () => {
    const built = liveBuildSettlement(
      [{ id: 1, sessionId: 1, role: 'anchor', amountCents: 1000, rateUnits: 1000 }, { id: 2, sessionId: 2, role: 'anchor', amountCents: 1000, rateUnits: 1000 }],
      new Map([[1, [{ orderId: 'A', shopId: '1', amountCents: 10000 }]], [2, [{ orderId: 'A', shopId: '2', amountCents: 10000 }]]]),
      new Map([[liveRefundKey('1', 'A'), { cents: 1000 }], [liveRefundKey('2', 'A'), { cents: 2000 }]]),
    );
    expect(built.lines.map((l) => l.refundCents)).toEqual([1000, 2000]);
  });
  it('未计入的售后单也留作依据；已取消的售后单不计', () => {
    const none = liveRefundForOrder(1000, null, [{ as_id: 1, status: 'Cancelled', refund: 5 }]);
    expect(none.cents).toBe(0);
    expect(none.source).toBe('none');
    expect((none.details[0] as { counted: boolean }).counted).toBe(false);
    expect(liveCountsAsRefund({ status: 'WaitConfirm', shop_status: 'SUCCESS', type: '普通退货', refund: 10 })).toBe(true);
    expect(liveCountsAsRefund({ status: 'Confirmed', type: '补发', refund: 10 })).toBe(false);
    expect(liveCountsAsRefund({ status: 'Confirmed', refund: 0 })).toBe(false);
    expect(liveRefundForOrder(9990, { status: 'Sent' }, [{ status: 'Confirmed', refund: 30 }, { status: 'Confirmed', refund: 20.5 }]).cents).toBe(5050);
  });
});

describe('提成计算（移植旧测试用例）', () => {
  const c = (sales: string, ad: string | null = null, rules: typeof R = R) =>
    liveComputeCommission({ rules, finalSalesCents: liveYuanToCents(sales)!, adSpendCents: ad ? liveYuanToCents(ad) : null });
  const rates = (r: ReturnType<typeof c>) => [r.anchor.rateUnits, r.control.rateUnits];
  const money = (cents: number) => liveCentsToYuan(cents);

  it('档位边界（含下限）', () => {
    for (const [sales, anchor, control] of [['0', 300, 200], ['0.01', 300, 200], ['999.99', 300, 200], ['1000', 350, 250], ['1999.99', 350, 250], ['2000', 400, 300], ['3999.99', 400, 300], ['4000', 450, 300], ['5999.99', 450, 300], ['6000', 500, 350], ['123456.78', 500, 350]] as const) {
      expect(rates(c(sales))).toEqual([anchor, control]);
    }
  });
  it('投产恰好 10 不扣减，低于扣减，投流空或 0 按达标', () => {
    expect(rates(c('2500', '250'))).toEqual([400, 300]);
    expect(c('2500', '250').roiScaled).toBe(100000);
    expect(c('2500', '250').belowRoi).toBe(false);
    expect(rates(c('2500', '277.78'))).toEqual([200, 150]);
    expect(rates(c('2500', '250.01'))).toEqual([200, 150]);
    expect(rates(c('2500', '0'))).toEqual([400, 300]);
    expect(rates(c('2500', null))).toEqual([400, 300]);
    expect(c('2500', null).roiScaled).toBeNull();
    expect(c('2500', null).roiCounted).toBe(false);
  });
  it('金额按分四舍五入', () => {
    expect(money(c('2500', '277.78').anchor.amountCents)).toBe('50.00');
    expect(money(c('2500', '277.78').control.amountCents)).toBe('37.50');
    expect(money(c('999.99').anchor.amountCents)).toBe('30.00');
    expect(money(c('999.99').control.amountCents)).toBe('20.00');
    expect(money(c('1000').anchor.amountCents)).toBe('35.00');
    expect(money(c('1999.99').control.amountCents)).toBe('50.00');
    expect(money(c('1234.57').anchor.amountCents)).toBe('43.21');
    expect(money(c('0.14').anchor.amountCents)).toBe('0.00');
    expect(money(c('0.17').anchor.amountCents)).toBe('0.01');
    expect(money(c('6000').anchor.amountCents)).toBe('300.00');
  });
  it('扣减不低于 0；含上限边界；可调阈值', () => {
    const steep = { ...R, belowRoiAnchorDeductUnits: 1000, belowRoiControlDeductUnits: 1000 };
    expect(rates(c('500', '100', steep))).toEqual([0, 0]);
    const upper = { ...R, boundary: 'max_inclusive' as const };
    expect(rates(c('1000', null, upper))).toEqual([300, 200]);
    expect(rates(c('1000.01', null, upper))).toEqual([350, 250]);
    expect(rates(c('0', null, upper))).toEqual([300, 200]);
    expect(rates(c('6000', null, upper))).toEqual([450, 300]);
    expect(rates(c('6000.01', null, upper))).toEqual([500, 350]);
    const roi8 = { ...R, roiThresholdUnits: 850 };
    expect(c('850', '100', roi8).belowRoi).toBe(false);
    expect(c('849.99', '100', roi8).belowRoi).toBe(true);
  });
  it('运营固定 0.5%，不分档，不受投产扣减', () => {
    expect(c('2500').operator.rateUnits).toBe(50);
    expect(money(c('2500').operator.amountCents)).toBe('12.50');
    expect(money(c('6000').operator.amountCents)).toBe('30.00');
    expect(money(c('2500', '277.78').operator.amountCents)).toBe('12.50');
    expect(money(c('1234.57').operator.amountCents)).toBe('6.17');
    expect(money(c('0.99').operator.amountCents)).toBe('0.00');
    expect(money(c('1.00').operator.amountCents)).toBe('0.01');
    const legacy = liveRulesFromStored({ ...R, operatorRateUnits: undefined });
    expect(c('2500', null, legacy).operator.rateUnits).toBe(50);
    expect(money(c('2500', null, { ...R, operatorRateUnits: 100 }).operator.amountCents)).toBe('25.00');
  });
  it('输入校验', () => {
    expect(() => liveYuanToCents('-1')).toThrow('不小于 0');
    expect(() => liveYuanToCents('12.345')).toThrow('两位小数');
    expect(() => liveYuanToCents('abc')).toThrow();
    expect(liveYuanToCents('¥ 88')).toBe(8800);
    const ok = liveRulesToInput(R);
    const bad = (patch: Record<string, unknown>) => () => liveRulesFromInput({ ...ok, ...patch } as never);
    expect(bad({ boundary: 'both' })).toThrow('边界');
    expect(bad({ roiThreshold: '0' })).toThrow('投产阈值');
    expect(bad({ operatorRate: '101' })).toThrow('0 到 100');
    expect(bad({ operatorRate: '0.555' })).toThrow('两位小数');
    expect(bad({ tiers: [{ min: '0', max: '1000', anchorRate: '1', controlRate: '1' }] })).toThrow('不设上限');
    expect(bad({ tiers: [{ min: '0', max: '', anchorRate: '1.234', controlRate: '1' }] })).toThrow('两位小数');
  });
});

describe('主播工资（移植旧测试用例）', () => {
  const w = (s: string, e: string, rate: string) => liveComputeWage({ startAt: s, endAt: e, hourlyRateCents: liveYuanToCents(rate) });
  it('整小时与按分钟、半分进位', () => {
    expect(w('2026-10-25 14:00:00', '2026-10-25 16:00:00', '30')).toEqual({ minutes: 120, hourlyRateCents: 3000, amountCents: 6000 });
    expect(w('2026-10-25T14:00', '2026-10-25T16:30', '28.5').amountCents).toBe(7125);
    expect(w('2026-10-25 14:00:00', '2026-10-25 15:07:00', '25').amountCents).toBe(2792);
    expect(w('2026-10-25 14:00:00', '2026-10-25 14:01:00', '0.30').amountCents).toBe(1);
    expect(w('2026-10-25 23:00:00', '2026-10-26 01:30:00', '40').amountCents).toBe(10000);
    expect(w('2026-10-25 14:00:00', '2026-10-26 14:00:00', '10').amountCents).toBe(24000);
  });
  it('秒数四舍五入到整分钟', () => {
    expect(liveWageMinutes('2026-10-25 14:00:00', '2026-10-25 14:59:40')).toBe(60);
    expect(liveWageMinutes('2026-10-25 14:00:00', '2026-10-25 14:00:30')).toBe(1);
    expect(() => liveWageMinutes('2026-10-25 14:00:00', '2026-10-25 14:00:20')).toThrow('晚于');
    expect(() => w('2026-10-25 14:00:00', '2026-10-26 14:01:00', '30')).toThrow('24 小时');
    expect(() => w('', '2026-10-25 14:00:00', '30')).toThrow('格式');
  });
  it('时薪必填且大于 0', () => {
    expect(() => liveComputeWage({ startAt: '2026-10-25 14:00:00', endAt: '2026-10-25 16:00:00', hourlyRateCents: null })).toThrow('时薪');
    expect(() => w('2026-10-25 14:00:00', '2026-10-25 16:00:00', '0')).toThrow('大于 0');
    expect(liveYuanToCents('¥ 1,200')).toBe(120000);
  });
  it('档案默认时薪只认计时且大于 0', () => {
    expect(liveArchiveHourlyRate({ payType: 'hourly', hourlyRate: 2200 })).toBe(2200);
    expect(liveArchiveHourlyRate({ payType: 'hourly', hourlyRate: 0 })).toBeNull();
    expect(liveArchiveHourlyRate({ payType: 'monthly', hourlyRate: 30000 })).toBeNull();
    expect(liveArchiveHourlyRate(undefined)).toBeNull();
  });
});
