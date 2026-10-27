import { LIVE_ROLE_LABEL } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { money } from '../finance/common';

export { money };
export const errText = (e: unknown, fallback = '操作失败') => (e instanceof ApiError || e instanceof Error ? e.message : fallback);
/** 'YYYY-MM-DD HH:mm:ss' → 'HH:mm'；跨日时带日期 */
export const hm = (t: string | null | undefined, day?: string) => (t ? (day && t.slice(0, 10) !== day ? `${t.slice(5, 10)} ${t.slice(11, 16)}` : t.slice(11, 16)) : '—');
export const dt = (t: string | null | undefined) => (t ? t.slice(0, 16) : '—');
/** 比例点（3.5% = 350）→ '3.5%' */
export const ratePct = (units: number | null | undefined) => (units === null || units === undefined ? '—' : `${units / 100}%`);
/** 投产 ×10000 → '2.50' */
export const roi = (scaled: number | null | undefined) => (scaled === null || scaled === undefined ? '—' : (scaled / 10000).toFixed(2));
export const minutesText = (m: number) => `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
export const roleLabel = (r: string) => LIVE_ROLE_LABEL[r] ?? r;
export const SESSION_TONE: Record<string, string> = { live: 'bad', pending_report: 'warn', submitted: 'warn', returned: 'bad', approved: 'ok' };
export const SCHEDULE_TONE: Record<string, string> = { scheduled: '', live: 'bad', finished: 'ok', cancelled: 'muted' };

/** 本地「现在」按北京时间写成 'YYYY-MM-DD HH:mm' */
export function nowText(d = new Date()): string {
  const s = new Date(d.getTime() + 8 * 3600000).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
}
export const todayText = () => nowText().slice(0, 10);
/** 金额文字（元）→ 分；空串 null；非法 NaN。支持最多 2 位小数 */
export function yuanCents(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}
export const yuanText = (cents: number | null | undefined) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2));
