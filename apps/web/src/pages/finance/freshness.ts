/** 余额“多新”：按距离最后更新过了多久分档，档位越久颜色越重（沿用旧系统的 1/2/3/7/15/30 天档位）。 */
export type Freshness = 'fresh' | 'two-days' | 'three-days' | 'seven-days' | 'fifteen-days' | 'thirty-days' | 'stale' | 'unknown';

export function freshnessTone(updatedAt: string | null | undefined, now: number): Freshness {
  if (!updatedAt) return 'unknown';
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return 'unknown';
  const hours = Math.max(0, now - t) / 3_600_000;
  if (hours <= 24) return 'fresh';
  if (hours <= 48) return 'two-days';
  if (hours <= 72) return 'three-days';
  if (hours <= 24 * 7) return 'seven-days';
  if (hours <= 24 * 15) return 'fifteen-days';
  if (hours <= 24 * 30) return 'thirty-days';
  return 'stale';
}

/** 档位对应的标签颜色（pill 的 ok / warn / bad，没有记录用灰色） */
export const FRESH_PILL: Record<Freshness, string> = {
  fresh: 'ok', 'two-days': 'warn', 'three-days': 'warn', 'seven-days': 'bad', 'fifteen-days': 'bad', 'thirty-days': 'bad', stale: 'bad', unknown: '',
};
export const FRESH_HINT: Record<Freshness, string> = {
  fresh: '24 小时内更新', 'two-days': '1 到 2 天前更新', 'three-days': '2 到 3 天前更新', 'seven-days': '3 到 7 天前更新', 'fifteen-days': '7 到 15 天前更新', 'thirty-days': '15 到 30 天前更新', stale: '超过 30 天没更新', unknown: '没有更新记录',
};

export function fmtUpdated(updatedAt: string | null | undefined): string {
  if (!updatedAt) return '未记录';
  const d = new Date(updatedAt);
  if (Number.isNaN(d.getTime())) return '未记录';
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', year: 'numeric' });
}
