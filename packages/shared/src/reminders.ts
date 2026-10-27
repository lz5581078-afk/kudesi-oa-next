/**
 * 周期性提醒日的计算（营业执照年审、银行对账日），口径照旧系统：
 * - 年审 MM-DD：每年滚动，取今天或之后的第一次；2 月 29 日在平年落到 28 日
 * - 对账：按月填 1-31；按季填“季度末月（3/6/9/12 月）的第 N 天”，存成 Q-END-N；按年填 MM-DD
 * 日期都是 YYYY-MM-DD 文本，按上海本地日期，不引入时区计算。
 */

const DAY_MS = 86_400_000;

function parts(text: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function clamp(y: number, m: number, d: number): string {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return fmt(y, m, Math.min(d, last));
}

export function daysBetweenDates(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) return NaN;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

/** 今天（北京时间）的日期文本 */
export function todayInShanghai(now: number = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

/** “MM-DD”下一次出现的日期（今天算）。格式不对返回 null。 */
export function nextAnnualOccurrence(monthDay: string | null | undefined, today: string): string | null {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(monthDay ?? '').trim());
  const base = parts(today);
  if (!m || !base) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const thisYear = clamp(base.y, month, day);
  return thisYear >= today ? thisYear : clamp(base.y + 1, month, day);
}

export function nextMonthlyDay(day: number, today: string): string | null {
  const base = parts(today);
  if (!base || !(day >= 1 && day <= 31)) return null;
  const current = clamp(base.y, base.m, day);
  if (current >= today) return current;
  return base.m === 12 ? clamp(base.y + 1, 1, day) : clamp(base.y, base.m + 1, day);
}

export function nextQuarterEndDay(day: number, today: string): string | null {
  const base = parts(today);
  if (!base || !(day >= 1 && day <= 31)) return null;
  for (let offset = 0; offset < 8; offset += 1) {
    const idx = base.m - 1 + offset;
    const y = base.y + Math.floor(idx / 12);
    const month = (idx % 12) + 1;
    if (month % 3 !== 0) continue;
    const candidate = clamp(y, month, day);
    if (candidate >= today) return candidate;
  }
  return null;
}

/** 对账提醒日：月 "15"、季 "Q-END-15"（兼容只写 "15"）、年 "MM-DD"。 */
export function nextReconciliationDate(cycle: string | null | undefined, value: string | null | undefined, today: string): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const quarter = /^Q-END-(\d{1,2})$/i.exec(text);
  if (quarter) return nextQuarterEndDay(Number(quarter[1]), today);
  if (/^\d{1,2}-\d{1,2}$/.test(text)) return nextAnnualOccurrence(text, today);
  if (/^\d{1,2}$/.test(text)) return cycle === 'quarterly' ? nextQuarterEndDay(Number(text), today) : nextMonthlyDay(Number(text), today);
  return null;
}

/**
 * 校验并规范化对账提醒日；返回规范值或抛出提示文字（返回对象的 error）。
 * 按季：Q-END-1..31（只填数字时补成 Q-END-数字；兼容旧数据里的 MM-DD）；按年：MM-DD；按月：1..31
 */
export function normalizeReconcileDay(cycle: string | null | undefined, value: string | null | undefined): { value?: string; error?: string } {
  const text = String(value ?? '').trim();
  if (!text) return {};
  const dayOk = (n: number) => Number.isInteger(n) && n >= 1 && n <= 31;
  const monthDayOk = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(text);
  if (cycle === 'monthly') {
    if (!/^\d{1,2}$/.test(text) || !dayOk(Number(text))) return { error: '按月对账的提醒日应填 1 到 31' };
    return { value: String(Number(text)) };
  }
  if (cycle === 'quarterly') {
    const q = /^Q-END-(\d{1,2})$/i.exec(text);
    if (q && dayOk(Number(q[1]))) return { value: `Q-END-${Number(q[1])}` };
    if (/^\d{1,2}$/.test(text) && dayOk(Number(text))) return { value: `Q-END-${Number(text)}` };
    if (monthDayOk) return { value: text };
    return { error: '按季对账的提醒日应填季度末月的第几天（1 到 31）' };
  }
  if (cycle === 'yearly') {
    if (!monthDayOk) return { error: '按年对账的提醒日应填 MM-DD' };
    return { value: text };
  }
  return { value: text };
}
