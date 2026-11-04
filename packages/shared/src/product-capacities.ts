/** 容量仍使用一行一项的既有存储格式；编辑中的单位可先于数量存在。 */
export function productCapacity(line: string): { quantityText: string; quantity: number | null; unit: string } {
  if (line.startsWith('\t') && line.trim()) return { quantityText: '', quantity: null, unit: line.trim() };
  const match = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(.*)$/.exec(line.trim());
  const quantityText = match?.[1] ?? '';
  const quantity = quantityText && Number.isFinite(Number(quantityText)) ? Number(quantityText) : null;
  return { quantityText, quantity, unit: match?.[2]?.trim() ?? line.trim() };
}

/** 易与数量或科学计数混淆的编码加分隔；仅单位的未完成草稿用制表符区分。 */
export function productCapacityText(quantity: string, unit: string): string {
  if (!quantity && /^\d/.test(unit)) return `\t${unit}`;
  return `${quantity}${quantity && /^[0-9eE]/.test(unit) ? ' ' : ''}${unit}`;
}
