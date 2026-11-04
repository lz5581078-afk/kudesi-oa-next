/** Display the inclusive shipping limits consistently in the list and details. */
export function versionWeightLabel(version: { shippingWeightMin?: number | null; shippingWeightMax?: number | null }): string {
  const min = version.shippingWeightMin ?? 0;
  const max = version.shippingWeightMax;
  if (max == null) return min === 0 ? '未限制' : `≥${min}kg`;
  return `${min}–${max}kg`;
}

export function expressDateTime(value?: string): string {
  if (!value) return '-';
  const local = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value);
  const date = new Date(local ? value.replace(' ', 'T') + '+08:00' : value);
  if (!Number.isFinite(date.getTime())) return '-';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(date).map(part => [part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
