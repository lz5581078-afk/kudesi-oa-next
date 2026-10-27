/** 对账提醒日的录入规范（到期计算在 expiry.ts）：月 "15"、季 "Q-END-15"（季度末月的第 15 天）、年 "MM-DD"。 */

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
