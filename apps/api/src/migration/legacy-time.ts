/** Legacy DATETIME/TIMESTAMP strings represent Asia/Shanghai wall time. */
export function legacyWallTime(v: unknown, required = false): Date | null {
  if (v == null || v === '') { if (required) throw new Error('旧流程缺少原始时间'); return null; }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) throw new Error('旧流程时间必须保持东八区原始字符串');
  const d = new Date(v.replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(d.getTime()) || new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') !== v) throw new Error('旧流程时间无效');
  return d;
}
