/**
 * 任务中心：手工任务和周期任务。
 * 周期任务按北京时间的“日期”判断今天要不要生成；每个（周期任务, 日期）只会生成一条（schedule_key 幂等）。
 */
export type RoutineFrequency = 'daily' | 'weekly' | 'monthly';
export const ROUTINE_FREQUENCY_LABEL: Record<RoutineFrequency, string> = { daily: '每天', weekly: '每周', monthly: '每月' };
export const WEEKDAY_LABEL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

export interface RoutineRule {
  frequency: RoutineFrequency;
  /** 每周：1 = 周一 … 7 = 周日 */
  weekday?: number | null;
  /** 每月：1–28 号（不用 29–31，避免小月没有这一天） */
  monthDay?: number | null;
}

/** yyyy-mm-dd 是周几：1 = 周一 … 7 = 周日（按日历日期算，和时区无关）。 */
export function weekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

export function routineMatches(rule: RoutineRule, ymd: string): boolean {
  if (rule.frequency === 'daily') return true;
  if (rule.frequency === 'weekly') return weekdayOf(ymd) === rule.weekday;
  return Number(ymd.slice(8, 10)) === rule.monthDay;
}

export function validateRoutine(rule: RoutineRule, title: string, dueDays: number): string[] {
  const errors: string[] = [];
  if (!title.trim() || title.length > 150) errors.push('任务标题必填，不超过 150 字');
  if (!['daily', 'weekly', 'monthly'].includes(rule.frequency)) errors.push('请选择频率');
  if (rule.frequency === 'weekly' && !(Number.isInteger(rule.weekday) && (rule.weekday as number) >= 1 && (rule.weekday as number) <= 7)) errors.push('请选择周几');
  if (rule.frequency === 'monthly' && !(Number.isInteger(rule.monthDay) && (rule.monthDay as number) >= 1 && (rule.monthDay as number) <= 28)) errors.push('每月几号只能选 1 到 28 号');
  if (!Number.isInteger(dueDays) || dueDays < 1 || dueDays > 30) errors.push('完成期限是 1 到 30 天');
  return errors;
}

/** 北京时间 ymd 当天 23:59:59 之后再加 plusDays-1 天，作为截止时间。 */
export function dueEndOfDay(ymd: string, days: number): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days - 1, 23, 59, 59) - 8 * 3600_000);
}
