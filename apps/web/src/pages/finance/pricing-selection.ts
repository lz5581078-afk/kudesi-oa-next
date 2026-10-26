import type { DebugRow } from './financeApi';

const weight = (r: DebugRow) => (r.weightG !== null && r.weightG > 0 ? r.weightG : Infinity);

/** 按计费重量由轻到重；没有重量的排最后；再按名称、编号 */
export function sortPricingRows<T extends DebugRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (weight(a) === weight(b) ? 0 : weight(a) < weight(b) ? -1 : 1) || a.skuName.localeCompare(b.skuName, 'zh-CN') || a.id - b.id);
}

/** 全选/取消全选当前页，已选的其它页不受影响 */
export function selectPricingPage<T extends DebugRow>(selected: Record<number, T>, rows: readonly T[], checked: boolean): Record<number, T> {
  const next = { ...selected };
  for (const row of rows) {
    if (checked) next[row.id] = selected[row.id] ?? row;
    else delete next[row.id];
  }
  return next;
}
