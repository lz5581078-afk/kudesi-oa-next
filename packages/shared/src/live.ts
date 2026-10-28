/**
 * 直播管理的纯函数（前后端共用）：北京时间、金额与比例、提成规则与计算、主播工资、月底结算扣减、退款判定。
 * 规则来源：旧系统 server/modules/live（commission/wage/settlement/jushuitan-refunds），已在 docs/协作/审计/UI-直播管理.md 逐条对照。
 *
 * 数值约定：金额一律整数分；比例一律“百分数 × 100”的整数（3.5% = 350，称“比例点”），
 * 提成 = round(销售额分 × 比例点 ÷ 10000)，整数四舍五入（半分进位）；投产比存成 ×10000 的整数。
 */

// ================= 北京时间 =================
// 直播业务时间一律按北京时间墙钟保存为 'YYYY-MM-DD HH:mm:ss'，不依赖数据库会话或进程时区。

const pad = (v: number) => String(v).padStart(2, '0');

function beijingParts(date: Date) {
  const s = new Date(date.getTime() + 8 * 3600000);
  return { y: s.getUTCFullYear(), m: pad(s.getUTCMonth() + 1), d: pad(s.getUTCDate()), h: pad(s.getUTCHours()), mi: pad(s.getUTCMinutes()), s: pad(s.getUTCSeconds()) };
}
const wall = (date: Date) => { const p = beijingParts(date); return `${p.y}-${p.m}-${p.d} ${p.h}:${p.mi}:${p.s}`; };

/** 'YYYY-MM-DD HH:mm[:ss]' 或 'YYYY-MM-DDTHH:mm' 视为北京时间；带时区的 ISO 字符串按其时区；其余返回 null。 */
export function liveFromText(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value ?? '').trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (local) {
    const [, y, m, d, h, mi, s = '00'] = local;
    const date = new Date(`${y}-${m}-${d}T${h}:${mi}:${s}+08:00`);
    return Number.isNaN(date.getTime()) || wall(date) !== `${y}-${m}-${d} ${h}:${mi}:${s}` ? null : date;
  }
  if (/(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
/** Date 或文字 → 'YYYY-MM-DD HH:mm:ss'（北京时间）；空/非法 → null。 */
export function liveToText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = liveFromText(value);
  return date ? wall(date) : null;
}
export function liveToday(now: Date = new Date()): string { const p = beijingParts(now); return `${p.y}-${p.m}-${p.d}`; }
export function liveAddDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function liveIsDay(value: unknown): value is string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export const liveIsMonth = (value: unknown): value is string => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value ?? ''));
/** 'HH:mm' → 分钟数；非法返回 null。 */
export function liveMinutesOf(value: unknown): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
/** 只能给今天及未来 7 天排场（北京时间）。 */
export function liveCanScheduleDay(day: unknown, now: Date = new Date()): boolean {
  return liveIsDay(day) && day >= liveToday(now) && day <= liveAddDays(liveToday(now), 7);
}
/** 整月边界：本月第一天、下月第一天、上月第一天。 */
export function liveMonthBounds(month: string) {
  const first = new Date(`${month}-01T00:00:00Z`);
  const next = new Date(first); next.setUTCMonth(next.getUTCMonth() + 1);
  const previous = new Date(first); previous.setUTCMonth(previous.getUTCMonth() - 1);
  return { from: `${month}-01`, until: next.toISOString().slice(0, 10), previousFrom: previous.toISOString().slice(0, 10) };
}

// ================= 金额与比例 =================

export class LiveRuleError extends Error {}
const fail = (message: string): never => { throw new LiveRuleError(message); };

export const LIVE_MAX_AMOUNT_CENTS = 10_000_000_000; // 1 亿元，避免整数乘法越过安全范围

/** '1,234.5' / 1234.5 / '' → 123450 分；空值返回 null（allowEmpty 为 false 时抛错）；非法值抛错。 */
export function liveYuanToCents(value: unknown, label = '金额', opts: { allowEmpty?: boolean } = {}): number | null {
  const allowEmpty = opts.allowEmpty ?? true;
  if (value === null || value === undefined || String(value).trim() === '') {
    if (allowEmpty) return null;
    return fail(`请填写${label}`);
  }
  const text = String(value).replace(/[,，￥¥\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return fail(`${label}需要是不小于 0、最多两位小数的数字`);
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents > LIVE_MAX_AMOUNT_CENTS) return fail(`${label}超出允许范围`);
  return cents;
}
/** 分 → '1234.50'（两位小数文字，只用于显示与导出）。 */
export const liveCentsToYuan = (cents: number | null | undefined): string | null => (cents === null || cents === undefined ? null : `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${pad(Math.abs(cents) % 100)}`);

/** 百分数（最多两位小数）→ 比例点（×100 的整数）：3.5 → 350。 */
export function livePercentToUnits(value: unknown, label: string): number {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return fail(`${label}需要在 0 到 100 之间`);
  const number = Number(text);
  if (number < 0 || number > 100) return fail(`${label}需要在 0 到 100 之间`);
  const units = Math.round(number * 100);
  if (Math.abs(units - number * 100) > 1e-6) return fail(`${label}最多保留两位小数`);
  return units;
}
/** 比例点 → 百分数文字：350 → '3.5'。 */
export const liveUnitsToPercent = (units: number): string => String(units / 100);

/** 整数四舍五入除法（非负）：round(numerator / denominator)，半分进位。 */
export function liveRoundDiv(numerator: number, denominator: number): number {
  const q = Math.floor(numerator / denominator);
  return (numerator - q * denominator) * 2 >= denominator ? q + 1 : q;
}

// ================= 提成规则 =================

export type LiveBoundary = 'min_inclusive' | 'max_inclusive';
export interface LiveTier { minCents: number; maxCents: number | null; anchorRateUnits: number; controlRateUnits: number }
export interface LiveRules {
  boundary: LiveBoundary;
  /** 投产阈值 ×100：10 → 1000 */
  roiThresholdUnits: number;
  belowRoiAnchorDeductUnits: number;
  belowRoiControlDeductUnits: number;
  /** 运营提成比例点；旧版本没有这个字段时按 0.5%（50）计算 */
  operatorRateUnits: number;
  tiers: LiveTier[];
}
export const LIVE_DEFAULT_OPERATOR_RATE_UNITS = 50;

/** 公司开通时写入的初始规则（直播管理规格确认版，2026-01-01 起生效）。 */
export const LIVE_DEFAULT_RULES: LiveRules = Object.freeze({
  boundary: 'min_inclusive',
  roiThresholdUnits: 1000,
  belowRoiAnchorDeductUnits: 200,
  belowRoiControlDeductUnits: 150,
  operatorRateUnits: LIVE_DEFAULT_OPERATOR_RATE_UNITS,
  tiers: [
    { minCents: 0, maxCents: 100_000, anchorRateUnits: 300, controlRateUnits: 200 },
    { minCents: 100_000, maxCents: 200_000, anchorRateUnits: 350, controlRateUnits: 250 },
    { minCents: 200_000, maxCents: 400_000, anchorRateUnits: 400, controlRateUnits: 300 },
    { minCents: 400_000, maxCents: 600_000, anchorRateUnits: 450, controlRateUnits: 300 },
    { minCents: 600_000, maxCents: null, anchorRateUnits: 500, controlRateUnits: 350 },
  ],
}) as LiveRules;

/** 页面表单里的规则：金额（元）、比例（%）都是文字，和旧系统的规则设置页一致。 */
export interface LiveRulesInput {
  boundary?: string;
  roiThreshold?: unknown;
  belowRoiAnchorDeduct?: unknown;
  belowRoiControlDeduct?: unknown;
  operatorRate?: unknown;
  tiers?: Array<{ min?: unknown; max?: unknown; anchorRate?: unknown; controlRate?: unknown }>;
}

/** 校验表单规则并换成整数规则；不合法抛 LiveRuleError（中文提示）。 */
export function liveRulesFromInput(input: LiveRulesInput | null | undefined): LiveRules {
  if (!input || typeof input !== 'object') return fail('提成规则格式不正确');
  const boundary = (input.boundary || 'min_inclusive') as string;
  if (boundary !== 'min_inclusive' && boundary !== 'max_inclusive') return fail('档位边界只能是「含下限」或「含上限」');
  const tiers = Array.isArray(input.tiers) ? input.tiers : [];
  if (tiers.length < 1 || tiers.length > 20) return fail('提成档位需要 1 到 20 档');
  const normalized: LiveTier[] = tiers.map((tier, index) => {
    const label = `第 ${index + 1} 档`;
    const minCents = liveYuanToCents(tier.min, `${label}下限`, { allowEmpty: false }) as number;
    const empty = tier.max === null || tier.max === undefined || String(tier.max).trim() === '';
    const maxCents = empty ? null : liveYuanToCents(tier.max, `${label}上限`);
    if (maxCents !== null && maxCents <= minCents) return fail(`${label}上限必须大于下限`);
    return { minCents, maxCents, anchorRateUnits: livePercentToUnits(tier.anchorRate, `${label}主播比例`), controlRateUnits: livePercentToUnits(tier.controlRate, `${label}中控比例`) };
  });
  if (normalized[0].minCents !== 0) return fail('第 1 档下限必须从 0 开始');
  normalized.forEach((tier, index) => {
    const next = normalized[index + 1];
    if (next && tier.maxCents !== next.minCents) fail(`第 ${index + 1} 档上限必须等于第 ${index + 2} 档下限，档位之间不能有空缺或重叠`);
    if (!next && tier.maxCents !== null) fail('最后一档不设上限（表示「及以上」）');
  });
  const thresholdText = String(input.roiThreshold ?? '').trim();
  const threshold = Number(thresholdText);
  if (!/^\d+(\.\d+)?$/.test(thresholdText) || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1000 || Math.abs(threshold * 100 - Math.round(threshold * 100)) > 1e-6) return fail('投产阈值需要是大于 0、最多两位小数的数字');
  return {
    boundary: boundary as LiveBoundary,
    roiThresholdUnits: Math.round(threshold * 100),
    belowRoiAnchorDeductUnits: livePercentToUnits(input.belowRoiAnchorDeduct ?? 0, '投产不足时主播扣减点数'),
    belowRoiControlDeductUnits: livePercentToUnits(input.belowRoiControlDeduct ?? 0, '投产不足时中控扣减点数'),
    operatorRateUnits: livePercentToUnits(input.operatorRate ?? liveUnitsToPercent(LIVE_DEFAULT_OPERATOR_RATE_UNITS), '运营提成比例'),
    tiers: normalized,
  };
}

/** 整数规则 → 表单文字（规则编辑器的初值、规则展示）。 */
export function liveRulesToInput(rules: LiveRules): Required<LiveRulesInput> & { tiers: Array<{ min: string; max: string; anchorRate: string; controlRate: string }> } {
  return {
    boundary: rules.boundary,
    roiThreshold: String(rules.roiThresholdUnits / 100),
    belowRoiAnchorDeduct: liveUnitsToPercent(rules.belowRoiAnchorDeductUnits),
    belowRoiControlDeduct: liveUnitsToPercent(rules.belowRoiControlDeductUnits),
    operatorRate: liveUnitsToPercent(rules.operatorRateUnits),
    tiers: rules.tiers.map((t) => ({ min: String(t.minCents / 100), max: t.maxCents === null ? '' : String(t.maxCents / 100), anchorRate: liveUnitsToPercent(t.anchorRateUnits), controlRate: liveUnitsToPercent(t.controlRateUnits) })),
  };
}

/** 读库里保存的规则 JSON（兼容缺运营比例的旧版本）。 */
export function liveRulesFromStored(stored: unknown): LiveRules {
  const raw = (typeof stored === 'string' ? JSON.parse(stored) : stored) as Partial<LiveRules> | null;
  if (!raw || !Array.isArray(raw.tiers)) return fail('提成规则版本数据不完整');
  return { ...(raw as LiveRules), operatorRateUnits: raw.operatorRateUnits ?? LIVE_DEFAULT_OPERATOR_RATE_UNITS };
}

/** 销售额落在第几档（索引）。含下限：[min,max)；含上限：(min,max]，第一档始终含 0。 */
export function liveTierIndex(rules: LiveRules, salesCents: number): number {
  const tiers = rules.tiers;
  for (let i = 0; i < tiers.length; i += 1) {
    const { minCents, maxCents } = tiers[i];
    const aboveMin = rules.boundary === 'max_inclusive' && i > 0 ? salesCents > minCents : salesCents >= minCents;
    const belowMax = maxCents === null || (rules.boundary === 'max_inclusive' ? salesCents <= maxCents : salesCents < maxCents);
    if (aboveMin && belowMax) return i;
  }
  return tiers.length - 1;
}

export interface LiveRoleResult { rateUnits: number; amountCents: number }
export interface LiveCommissionResult {
  finalSalesCents: number;
  adSpendCents: number;
  /** 投产 ×10000；没有投流为 null */
  roiScaled: number | null;
  roiCounted: boolean;
  belowRoi: boolean;
  tierIndex: number;
  tier: LiveTier;
  anchor: LiveRoleResult;
  control: LiveRoleResult;
  operator: LiveRoleResult;
}

/**
 * 计算一场直播的主播、中控、运营提成。投流为空或 0 时按投产达标处理；
 * 投产 = 销售额 ÷ 投流，用整数比较 销售额×100 < 阈值点×投流，避免浮点误差。运营固定比例，不分档、不受投产扣减。
 */
export function liveComputeCommission(input: { rules: LiveRules; finalSalesCents: number; adSpendCents?: number | null }): LiveCommissionResult {
  const { rules, finalSalesCents: sales } = input;
  const ad = input.adSpendCents ?? 0;
  const index = liveTierIndex(rules, sales);
  const tier = rules.tiers[index];
  const belowRoi = ad > 0 && sales * 100 < rules.roiThresholdUnits * ad;
  const role = (rate: number, deduct: number): LiveRoleResult => {
    const units = Math.max(0, rate - (belowRoi ? deduct : 0));
    return { rateUnits: units, amountCents: liveRoundDiv(sales * units, 10000) };
  };
  return {
    finalSalesCents: sales, adSpendCents: ad, roiScaled: ad > 0 ? liveRoundDiv(sales * 10000, ad) : null, roiCounted: ad > 0, belowRoi, tierIndex: index, tier: { ...tier },
    anchor: role(tier.anchorRateUnits, rules.belowRoiAnchorDeductUnits),
    control: role(tier.controlRateUnits, rules.belowRoiControlDeductUnits),
    operator: role(rules.operatorRateUnits, 0),
  };
}

/** 选取在 sessionDate 当天生效的最新版本：生效日期最大者，同日取编号大的。 */
export function liveVersionFor<T extends { id: number; effectiveFrom: string }>(versions: readonly T[], sessionDate: string): T | null {
  const day = String(sessionDate).slice(0, 10);
  return [...versions].filter((v) => v.effectiveFrom.slice(0, 10) <= day)
    .sort((a, b) => b.effectiveFrom.slice(0, 10).localeCompare(a.effectiveFrom.slice(0, 10)) || b.id - a.id)[0] ?? null;
}

// ================= 主播工资（按小时） =================

export const LIVE_MAX_WAGE_MINUTES = 24 * 60;

/** 起止时间 → 整分钟数（四舍五入）；下播必须晚于上播，单场最多 24 小时。 */
export function liveWageMinutes(startAt: unknown, endAt: unknown): number {
  const start = liveFromText(startAt), end = liveFromText(endAt);
  if (!start || !end) return fail('主播工资的上播、下播时间格式不正确');
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  if (minutes <= 0) return fail('主播工资的下播时间必须晚于上播时间');
  if (minutes > LIVE_MAX_WAGE_MINUTES) return fail('主播工资的单场时长不能超过 24 小时，请核对上下播时间');
  return minutes;
}
/** 工资 = 时薪 × 分钟数 ÷ 60，按分四舍五入。 */
export function liveComputeWage(input: { startAt: unknown; endAt: unknown; hourlyRateCents: number | null | undefined }): { minutes: number; hourlyRateCents: number; amountCents: number } {
  const minutes = liveWageMinutes(input.startAt, input.endAt);
  const rate = input.hourlyRateCents;
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return fail('请填写主播时薪');
  if (rate <= 0) return fail('主播时薪必须大于 0');
  return { minutes, hourlyRateCents: rate, amountCents: liveRoundDiv(rate * minutes, 60) };
}
/** 员工档案里的默认时薪：只有计薪方式为「计时」且大于 0 才作为默认值，其余情况（正式员工、计月）审核时必须手填。 */
export function liveArchiveHourlyRate(profile: { payType?: string | null; hourlyRate?: number | null } | null | undefined): number | null {
  if (!profile || profile.payType !== 'hourly') return null;
  const rate = Number(profile.hourlyRate);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

// ================= 月底提成结算 =================

/** 一条提成在结算中的扣减与应发：扣减 = round(退款 × 原比例)，不超过原提成；档位、比例、投产都不重算。 */
export function liveSettleLine(input: { commissionCents: number; rateUnits: number; refundCents: number }) {
  const deduction = Math.min(input.commissionCents, liveRoundDiv(Math.max(0, input.refundCents) * input.rateUnits, 10000));
  return { deductionCents: deduction, payableCents: input.commissionCents - deduction };
}
export const liveRefundKey = (shopId: unknown, orderId: unknown) => JSON.stringify([String(shopId || ''), String(orderId)]);

export interface LiveSettleRecord { id: number; sessionId: number; role: string; amountCents: number; rateUnits: number }
export interface LiveSettleOrder { orderId: string; shopId: string; amountCents: number }
export function liveBuildSettlement(records: readonly LiveSettleRecord[], sessionOrders: ReadonlyMap<number, readonly LiveSettleOrder[]>, refunds: ReadonlyMap<string, { cents: number }>) {
  const lines = records.map((record) => {
    const orders = sessionOrders.get(record.sessionId) ?? [];
    const refundCents = orders.reduce((sum, o) => sum + (refunds.get(liveRefundKey(o.shopId, o.orderId))?.cents ?? 0), 0);
    const { deductionCents, payableCents } = liveSettleLine({ commissionCents: record.amountCents, rateUnits: record.rateUnits, refundCents });
    return { record, orderCount: orders.length, ordersCents: orders.reduce((s, o) => s + o.amountCents, 0), refundCents, commissionCents: record.amountCents, deductionCents, payableCents };
  });
  const sum = (key: 'commissionCents' | 'deductionCents' | 'payableCents') => lines.reduce((t, l) => t + l[key], 0);
  // 同一场的主播、中控、运营共用本场退款，退款合计按场次去重
  const sessionRefund = new Map(lines.map((l) => [l.record.sessionId, l.refundCents]));
  return { lines, totals: { count: lines.length, commissionCents: sum('commissionCents'), refundCents: [...sessionRefund.values()].reduce((a, b) => a + b, 0), deductionCents: sum('deductionCents'), payableCents: sum('payableCents') } };
}

// ---- 聚水潭退款判定（只读核对用；原始行字段沿用聚水潭接口） ----
export interface JstRefundRow { as_id?: unknown; so_id?: unknown; status?: string; shop_status?: string; type?: string; refund?: unknown; refund_amount?: unknown; payment?: unknown; modified?: unknown; as_date?: unknown }
const NON_REFUND_TYPES = /换货|补发|维修/;
const DONE_SHOP_STATUSES = /SUCCESS|成功|已退款|退款完成/i;
const rowCents = (row: JstRefundRow) => Math.round(Number(row.refund ?? row.refund_amount ?? row.payment ?? 0) * 100);

/** 售后单是否计入退款：退款已完成，且不是换货/补发、不是已取消或被合并的售后单。 */
export function liveCountsAsRefund(row: JstRefundRow | null | undefined): boolean {
  if (!row) return false;
  if (row.status === 'Cancelled' || row.status === 'Merged') return false;
  if (NON_REFUND_TYPES.test(String(row.type || ''))) return false;
  if (rowCents(row) <= 0) return false;
  return row.status === 'Confirmed' || DONE_SHOP_STATUSES.test(String(row.shop_status || ''));
}
/** 一个订单的退款（分）与依据：订单已取消整单算退款；否则累计已完成售后单，不超过订单金额。 */
export function liveRefundForOrder(orderAmountCents: number, orderRow: { status?: string } | null | undefined, refundRows: readonly JstRefundRow[] = []) {
  if (orderRow && orderRow.status === 'Cancelled') return { cents: orderAmountCents, source: 'cancelled' as const, details: [{ kind: 'order', status: 'Cancelled' }] as Array<Record<string, unknown>> };
  const seen = new Set<string>();
  const rows = refundRows.filter((r) => { if (r.as_id == null) return true; const k = String(r.as_id); if (seen.has(k)) return false; seen.add(k); return true; });
  const total = Math.min(orderAmountCents, rows.filter(liveCountsAsRefund).reduce((s, r) => s + rowCents(r), 0));
  const details = rows.map((r) => ({ kind: 'refund', asId: r.as_id != null ? String(r.as_id) : null, type: r.type || null, status: r.status || null, shopStatus: r.shop_status || null, amountCents: rowCents(r), counted: liveCountsAsRefund(r), modified: r.modified || r.as_date || null }));
  return { cents: total, source: total > 0 ? ('refund' as const) : ('none' as const), details: details as Array<Record<string, unknown>> };
}

// ================= 场次与权限 =================

export const LIVE_SESSION_STATUS: Record<string, string> = { live: '直播中', pending_report: '待提交审核', submitted: '待审核', returned: '已退回', approved: '已审核' };
export const LIVE_SCHEDULE_STATUS: Record<string, string> = { scheduled: '未开始', live: '直播中', finished: '已播', cancelled: '已取消' };
export const LIVE_ROLE_LABEL: Record<string, string> = { anchor: '主播', control: '中控', operator: '运营' };
export const LIVE_FINAL_SOURCES: Record<string, string> = {
  anchor: '主播所报销售额', control: '中控所报销售额', anchor_orders: '主播勾选订单合计', control_orders: '中控勾选订单合计', manual: '审核人手填',
};
export const LIVE_MAX_SCHEDULE_MINUTES = 16 * 60;
/** 排场开始前 2 小时起到结束前，可以从排场上播。 */
export const LIVE_START_EARLY_MS = 2 * 3600000;

export interface LiveSessionPeople { anchorId: number; controlId?: number | null; operatorId?: number | null; startedBy?: number | null }

/** 可以为该场次报下播的角色：主播本人报主播，中控本人报中控；仅本人填报，任何管理人员不能代填。 */
export function liveReportRoleFor(userId: number, session: LiveSessionPeople, requested?: string | null): 'anchor' | 'control' | 'operator' | null {
  if (requested === 'anchor' && session.anchorId === userId) return 'anchor';
  if (requested === 'control' && session.controlId && session.controlId === userId) return 'control';
  if (requested === 'operator' && session.operatorId === userId && session.controlId !== userId) return 'operator';
  if (!requested) {
    if (session.anchorId === userId) return 'anchor';
    if (session.controlId === userId) return 'control';
  }
  return null;
}
/** 场次可见：有查看权限，或本人是该场主播、中控、运营、上播人。 */
export function liveCanSeeSession(canViewAll: boolean, userId: number, session: LiveSessionPeople): boolean {
  return canViewAll || [session.anchorId, session.controlId, session.operatorId, session.startedBy].some((v) => v != null && v === userId);
}

/** 场次预估提成只向本人展示：没有查看全员提成权限的人，只看到自己角色的金额；已审核场次只用保存的快照，不再试算。 */
export function liveFilterPreview<P extends { available: boolean; anchor?: unknown; control?: unknown; operator?: unknown }>(
  canViewAll: boolean, userId: number, session: LiveSessionPeople & { status: string }, preview: P | null,
): P | null {
  if (session.status === 'approved') return null;
  if (!preview || !preview.available || canViewAll) return preview;
  const mine = (id?: number | null) => id != null && id === userId;
  return { ...preview, anchor: mine(session.anchorId) ? preview.anchor : null, control: mine(session.controlId) ? preview.control : null, operator: mine(session.operatorId) && !mine(session.controlId) ? preview.operator : null };
}

/** 一张提成/工资表里的“报下播是否本人填报”：旧管理代填记录可保留查看，但未审核场次必须由该角色本人重新填写。 */
export function liveOwnReport<R extends { role: string; reporterId: number }>(reports: readonly R[], role: 'anchor' | 'control', personId: number | null | undefined): R | undefined {
  return personId ? reports.find((r) => r.role === role && r.reporterId === personId) : undefined;
}
/** 提交审核前缺的必填填报人（主播必填；有中控时中控必填；运营选填）。返回缺报的角色，齐了返回 null。 */
export function liveMissingReporter(reports: readonly { role: string; reporterId: number }[], session: LiveSessionPeople): 'anchor' | 'control' | null {
  if (!liveOwnReport(reports, 'anchor', session.anchorId)) return 'anchor';
  if (session.controlId && !liveOwnReport(reports, 'control', session.controlId)) return 'control';
  return null;
}

// ================= 直播间（西走廊下名称含「直播间」的房间） =================

export const LIVE_CORRIDOR_NAME = '西走廊办公室';
export const LIVE_ROOM_KEYWORD = '直播间';
const STORAGE_TYPES = new Set(['cabinet', 'asset_slot', 'shelf', 'drawer', 'box']);
// 办公楼/区域、楼层只是分区：不作为直播间，但继续查找其下的房间。
const AREA_TYPES = new Set(['building', 'floor']);
const BIG_ROOM_PATTERN = /大房间|[（(]\s*大\s*[）)]/;
const BIG_ROOM_NOTE = /[（(]\s*(?:大房间|大)\s*[）)]|大房间/g;

export type LiveRoomSide = 'north' | 'south' | 'none';
/** 名称里带「北」→ north，带「南」→ south；都带或都不带 → none。 */
export function liveRoomSide(name: string): LiveRoomSide {
  const north = name.includes('北'), south = name.includes('南');
  return north && !south ? 'north' : south && !north ? 'south' : 'none';
}
/** 「直播间-北3（大房间）」→ { isLive, side:'north', shortName:'北3', big:true }。分侧和编号取「直播间」之后的文字。 */
export function liveParseRoomName(name: string) {
  const full = String(name || '').trim();
  const at = full.lastIndexOf(LIVE_ROOM_KEYWORD);
  const isLive = at >= 0;
  const rest = (isLive ? full.slice(at + LIVE_ROOM_KEYWORD.length) : full).replace(/^[\s\-—–_·:：]+/, '');
  return { isLive, side: liveRoomSide(rest || full.replace(LIVE_ROOM_KEYWORD, '')), shortName: rest.replace(BIG_ROOM_NOTE, '').trim() || full, big: BIG_ROOM_PATTERN.test(full) };
}
/** 自然排序：把名称中的数字（含全角）按数值比较，「北2」排在「北10」之前。 */
export function liveNaturalCompare(a: string, b: string): number {
  const parts = (v: string) => String(v || '').normalize('NFKC').split(/(\d+)/).filter((p) => p !== '').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const left = parts(a), right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i], y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x - y; continue; }
    const c = String(x).localeCompare(String(y), 'zh-Hans-CN');
    if (c) return c;
  }
  return 0;
}
export interface LiveLocation { id: number; name: string; parentId?: number | null; locationType?: string | null; scope?: string | null; status?: string | null; archived?: boolean }
export interface LiveRoom { id: number; name: string; shortName: string; big: boolean; path: string; side: LiveRoomSide; sortOrder: number }
const INACTIVE_STATUS = new Set(['inactive', 'archived', 'deleted', 'disabled']);
const locActive = (l: LiveLocation) => !INACTIVE_STATUS.has(String(l.status || 'normal')) && !l.archived;
const SIDE_ORDER: Record<LiveRoomSide, number> = { north: 0, south: 1, none: 2 };
export function liveSortRooms<T extends { side: LiveRoomSide; shortName: string; name: string; id: number }>(rooms: readonly T[]): T[] {
  return [...rooms].sort((a, b) => SIDE_ORDER[a.side] - SIDE_ORDER[b.side] || liveNaturalCompare(a.shortName || a.name, b.shortName || b.name) || a.id - b.id);
}
export function liveGroupRooms<T extends { side: LiveRoomSide; shortName: string; name: string; id: number }>(rooms: readonly T[]) {
  const sorted = liveSortRooms(rooms);
  return { north: sorted.filter((r) => r.side === 'north'), south: sorted.filter((r) => r.side === 'south'), none: sorted.filter((r) => r.side === 'none') };
}
/**
 * 从公司全部位置里找出直播间：名为「西走廊办公室」的启用位置下、名称含「直播间」的所有启用下级房间
 * （含多级下级；楼层/区域只作分区继续向下找；跳过柜内空间、层、抽屉、格/盒；停用或归档的上级连同其下级一起排除）。
 */
export function liveRooms(locations: readonly LiveLocation[]): LiveRoom[] {
  const children = new Map<number, LiveLocation[]>();
  for (const l of locations) {
    const key = l.parentId ?? 0;
    children.set(key, [...(children.get(key) ?? []), l]);
  }
  const rooms: LiveRoom[] = [];
  const seen = new Set<number>();
  const visit = (parent: LiveLocation, path: string[]) => {
    for (const l of children.get(parent.id) ?? []) {
      if (seen.has(l.id) || !locActive(l)) continue;
      if (l.scope === 'asset_space' || STORAGE_TYPES.has(String(l.locationType))) continue;
      seen.add(l.id);
      if (AREA_TYPES.has(String(l.locationType))) { visit(l, [...path, l.name]); continue; }
      const parsed = liveParseRoomName(l.name);
      if (parsed.isLive) rooms.push({ id: l.id, name: l.name, shortName: parsed.shortName, big: parsed.big, path: [...path, l.name].join(' / '), side: parsed.side, sortOrder: 0 });
      visit(l, [...path, l.name]);
    }
  };
  for (const root of locations.filter((l) => String(l.name || '').trim() === LIVE_CORRIDOR_NAME && locActive(l))) { seen.add(root.id); visit(root, []); }
  return liveSortRooms(rooms);
}
