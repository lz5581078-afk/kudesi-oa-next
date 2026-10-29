import { addDaysText, daysBetweenDates } from './expiry';

/**
 * 通信费用台账（资料·费用模块）的口径与数据形状。
 * 数据不另存：手机号费用来自手机号资料，宽带费用来自宽带资料；这里只放纯函数和前后端共用的类型。
 * 金额一律整数分。
 */

export const FEE_SOON_DAYS = 7;
export const BROADBAND_SOON_DAYS = 30;

export type LedgerCycle = 'monthly' | 'quarterly' | 'halfyear' | 'yearly' | 'custom';
const CYCLE_MONTHS: Record<Exclude<LedgerCycle, 'custom'>, number> = { monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 };

/**
 * 折算月均（整数分，四舍五入）：月=原值，季÷3，半年÷6，年÷12；
 * 自定义周期按“周期天数”折算：金额 × 30 ÷ 天数。周期缺失或不认识按月付。
 */
export function monthlyEquivalentCents(cents: number | null | undefined, cycle: string | null | undefined, customDays?: number | null): number | null {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return null;
  if (cycle === 'custom') {
    if (!customDays || customDays < 1) return null;
    return Math.round((cents * 30) / customDays);
  }
  const months = CYCLE_MONTHS[(cycle as keyof typeof CYCLE_MONTHS) ?? 'monthly'] ?? 1;
  return Math.round(cents / months);
}

const DATE = /^\d{4}-\d{2}-\d{2}/;
const dateOnly = (v: unknown): string | null => (typeof v === 'string' && DATE.test(v) ? v.slice(0, 10) : null);

/**
 * 下次充值日：与手机号保存规则一致——有最后充值日就是“最后充值 + 充值周期天数”（周期缺省 30 天）；
 * 没有最后充值日时沿用档案里已有的下次充值日（旧系统迁入的值）。
 */
export function nextRechargeDate(input: { lastRechargeAt?: unknown; rechargeCycleDays?: unknown; nextRechargeAt?: unknown }): string | null {
  const last = dateOnly(input.lastRechargeAt);
  if (last) {
    const days = Number(input.rechargeCycleDays);
    return addDaysText(last, days >= 1 ? days : 30);
  }
  return dateOnly(input.nextRechargeAt);
}

export type RechargeState = 'overdue' | 'soon' | 'ok' | 'none';
export interface DueInfo<S extends string> { state: S; days: number | null }

/** 充值状态：下次充值日早于今天=逾期，7 天内（含今天）=即将充值，否则正常；没有日期=未排期 */
export function rechargeState(next: string | null | undefined, today: string, soonDays = FEE_SOON_DAYS): DueInfo<RechargeState> {
  const n = dateOnly(next);
  if (!n) return { state: 'none', days: null };
  const days = daysBetweenDates(today, n);
  return { state: days < 0 ? 'overdue' : days <= soonDays ? 'soon' : 'ok', days };
}

export type ExpiryState = 'expired' | 'soon' | 'ok' | 'none';
/** 宽带到期状态：早于今天=已到期，30 天内=即将到期 */
export function broadbandExpiry(expiresAt: string | null | undefined, today: string, soonDays = BROADBAND_SOON_DAYS): DueInfo<ExpiryState> {
  const n = dateOnly(expiresAt);
  if (!n) return { state: 'none', days: null };
  const days = daysBetweenDates(today, n);
  return { state: days < 0 ? 'expired' : days <= soonDays ? 'soon' : 'ok', days };
}

/**
 * 主子卡只允许两级：主卡（没有主卡）→ 子卡（有主卡）。返回不合法的原因，合法返回 null。
 * - 不能选自己；主卡本身不能是子卡；已经有子卡的号码不能再设主卡；停止使用的号码不能当新主卡。
 */
export function parentLinkProblem(input: { selfId?: number | null; parent: { id: number; parentPhoneId?: unknown; stopped?: boolean } | null; selfChildCount: number }): string | null {
  const p = input.parent;
  if (!p) return null;
  if (input.selfId != null && p.id === input.selfId) return '主卡不能选自己';
  if (typeof p.parentPhoneId === 'number') return '这张主卡本身是子卡，主子卡只允许两级，请选真正的主卡';
  if (p.stopped) return '这张主卡已停止使用，请先启用它或换一张主卡';
  if (input.selfChildCount > 0) return `这张卡下面还有 ${input.selfChildCount} 张子卡，不能再设为子卡；请先把它们改挂到别的主卡`;
  return null;
}

// ---------- 台账接口的数据形状 ----------

export type LedgerView = 'main' | 'all' | 'broadband';
export type LedgerFocus = 'main' | 'sub' | 'standalone' | 'soon' | 'overdue' | 'nofee' | 'unbound' | 'expiring' | 'expired';
export type LedgerSort = 'number' | 'monthly' | 'next' | 'carrier';

export interface LedgerPhoneRow {
  id: number;
  version: string;
  number: string;
  status: string;
  carrier: string | null;
  plan: string | null;
  kind: 'main' | 'sub';
  parentId: number | null;
  parentNumber: string | null;
  /** 没有费用查看权限时为 undefined（服务端不返回） */
  feeCents?: number | null;
  feeCycle: string;
  monthlyCents?: number | null;
  cycleDays: number | null;
  rechargeDay: string | null;
  lastRechargeAt: string | null;
  nextRechargeAt: string | null;
  state: RechargeState;
  daysLeft: number | null;
  user: string | null;
  userKind: 'use' | 'external' | 'partner' | 'keeper' | null;
  childCount: number;
  broadband: Array<{ id: number; account: string }>;
}

export interface LedgerGroup {
  main: LedgerPhoneRow;
  children: LedgerPhoneRow[];
  /** 主卡 + 子卡折算月均合计（没有费用权限时不返回）；未设费用的卡按 0 计，数量见 unpriced */
  monthlyCents?: number;
  unpriced: number;
}

export interface LedgerBroadbandRow {
  id: number;
  version: string;
  account: string;
  status: string;
  /** 使用区域 id（宽带资料的 locationId）和完整路径（办公楼 / 楼层 / 房间） */
  locationId: number | null;
  location: string | null;
  bandwidth: string | null;
  cycle: string;
  amountCents?: number | null;
  monthlyCents?: number | null;
  expiresAt: string | null;
  state: ExpiryState;
  daysLeft: number | null;
  phoneId: number | null;
  phoneNumber: string | null;
}

export interface LedgerSummary {
  /** 手机 + 宽带折算月均；没有费用权限时不返回 */
  monthlyCents?: number;
  phoneMonthlyCents?: number;
  broadbandMonthlyCents?: number;
  mainCount: number;
  subCount: number;
  soonCount: number;
  overdueCount: number;
  noFeeCount: number;
  orphanCount: number;
  /** 没有宽带查看权限时为 null */
  broadbandCount: number | null;
  broadbandExpiringCount: number | null;
  broadbandExpiredCount: number | null;
  broadbandUnboundCount: number | null;
  broadbandNoAreaCount: number | null;
}

export interface LedgerResult {
  today: string;
  view: LedgerView;
  canSeeFees: boolean;
  canSeeBroadband: boolean;
  summary: LedgerSummary;
  total: number;
  /** 当前筛选结果（全部页）折算月均合计；没有费用权限时不返回 */
  filteredMonthlyCents?: number;
  page: number;
  pageSize: number;
  groups?: LedgerGroup[];
  orphans?: LedgerPhoneRow[];
  rows?: LedgerPhoneRow[];
  broadband?: LedgerBroadbandRow[];
  /** 宽带页签的区域筛选项：有宽带在用的区域（完整路径）和条数 */
  areas?: Array<{ id: number; path: string; count: number }>;
  carriers: string[];
  users: string[];
}
