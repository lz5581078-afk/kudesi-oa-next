/**
 * 即将到期 / 已过期（旧系统 expiring.js 的规则）：
 * - date：字段本身就是到期日；
 * - annual：MM-DD，每年循环，取今天起（含）的下一次；
 * - reconciliation：银行对账日。"15"=每月 15 号（对账周期为季时是每季末月 15 号）、"Q-END-15"=每季末月 15 号、"MM-DD"=每年。
 * 业务日期按中国时区；已停用/注销/已归档的资料不提醒。
 */
import { RESOURCE_DEFS } from './resources';

export type ExpiryKind = 'date' | 'annual' | 'reconciliation';

export interface ExpirySource {
  resource: string;
  field: string;
  label: string;
  kind: ExpiryKind;
  /** reconciliation 用：对账周期字段 key */
  cycleField?: string;
}

export const EXPIRY_SOURCES: readonly ExpirySource[] = [
  { resource: 'licenses', field: 'expiresAt', label: '营业期限到期', kind: 'date' },
  { resource: 'licenses', field: 'annualAuditDay', label: '年报/年审', kind: 'annual' },
  { resource: 'qualifications', field: 'expiresAt', label: '资质到期', kind: 'date' },
  { resource: 'trademarks', field: 'validUntil', label: '商标到期', kind: 'date' },
  { resource: 'software', field: 'renewAt', label: '软件续费', kind: 'date' },
  { resource: 'memos', field: 'endAt', label: '账号/服务到期', kind: 'date' },
  { resource: 'phones', field: 'nextRechargeAt', label: '下次充值', kind: 'date' },
  { resource: 'stores', field: 'jushuitanExpireAt', label: '聚水潭授权到期', kind: 'date' },
  { resource: 'stores', field: 'trademarkExpireAt', label: '授权商标到期', kind: 'date' },
  { resource: 'bank-accounts', field: 'reconcileDay', label: '对账日', kind: 'reconciliation', cycleField: 'reconcileCycle' },
];

/** 不再提醒的状态：停用/注销（和旧系统一致）；已归档的资料另行排除 */
export const EXPIRY_SKIP_STATUSES: readonly string[] = ['inactive', 'cancelled'];

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const clamped = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(Math.min(d, daysInMonth(y, m)))}`;

function parse(text: string): { y: number; m: number; d: number } | null {
  const mt = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text ?? ''));
  return mt ? { y: Number(mt[1]), m: Number(mt[2]), d: Number(mt[3]) } : null;
}
const utc = (text: string) => { const p = parse(text)!; return Date.UTC(p.y, p.m - 1, p.d); };

/** 中国时区的今天 YYYY-MM-DD */
export function todayShanghai(now: number = Date.now()): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}
export function daysBetweenDates(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}
export function addDaysText(text: string, days: number): string {
  return new Date(utc(text) + days * DAY_MS).toISOString().slice(0, 10);
}

/** "MM-DD" → 今天起（含）的下一次；2 月 29 日在平年落到 28 日 */
export function nextAnnualOccurrence(monthDay: string, today: string): string | null {
  const mt = /^(\d{1,2})-(\d{1,2})$/.exec(String(monthDay ?? '').trim());
  const base = parse(today);
  if (!mt || !base) return null;
  const m = Number(mt[1]);
  const d = Number(mt[2]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const thisYear = clamped(base.y, m, d);
  return thisYear >= today ? thisYear : clamped(base.y + 1, m, d);
}
export function nextMonthlyDay(day: number, today: string): string | null {
  const base = parse(today);
  if (!base || !(day >= 1 && day <= 31)) return null;
  const cur = clamped(base.y, base.m, day);
  if (cur >= today) return cur;
  return base.m === 12 ? clamped(base.y + 1, 1, day) : clamped(base.y, base.m + 1, day);
}
export function nextQuarterEndDay(day: number, today: string): string | null {
  const base = parse(today);
  if (!base || !(day >= 1 && day <= 31)) return null;
  for (let off = 0; off < 8; off++) {
    const idx = base.m - 1 + off;
    const y = base.y + Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    if (m % 3 !== 0) continue;
    const c = clamped(y, m, day);
    if (c >= today) return c;
  }
  return null;
}
export function nextReconciliationDate(cycle: string | undefined, value: string, today: string): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const q = /^Q-END-(\d{1,2})$/i.exec(text);
  if (q) return nextQuarterEndDay(Number(q[1]), today);
  if (/^\d{1,2}-\d{1,2}$/.test(text)) return nextAnnualOccurrence(text, today);
  if (/^\d{1,2}$/.test(text)) return cycle === 'quarterly' ? nextQuarterEndDay(Number(text), today) : nextMonthlyDay(Number(text), today);
  return null;
}

export function dueDateFor(src: ExpirySource, data: Record<string, unknown>, today: string): string | null {
  const v = data[src.field];
  if (typeof v !== 'string' || !v) return null;
  if (src.kind === 'date') return parse(v) ? v.slice(0, 10) : null;
  if (src.kind === 'annual') return nextAnnualOccurrence(v, today);
  return nextReconciliationDate(typeof data[src.cycleField ?? ''] === 'string' ? (data[src.cycleField!] as string) : undefined, v, today);
}

/** 登记过的来源 + 资料定义里 alerts 声明、但上面没覆盖的字段（如固定资产保修、推广限制解除） */
export function expirySources(): ExpirySource[] {
  const out = [...EXPIRY_SOURCES];
  for (const def of RESOURCE_DEFS) {
    for (const a of def.alerts ?? []) {
      if (out.some((s) => s.resource === def.key && s.field === a.field)) continue;
      const f = def.fields.find((x) => x.key === a.field);
      if (f?.type === 'date') out.push({ resource: def.key, field: a.field, label: f.label, kind: 'date' });
    }
  }
  return out;
}
