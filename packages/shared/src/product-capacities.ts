/** 容量仍使用一行一项的既有存储格式；编辑中的单位可先于数量存在。 */
export function productCapacity(line: string): { quantityText: string; quantity: number | null; unit: string } {
  const match = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(.*)$/.exec(line.trim());
  const quantityText = match?.[1] ?? '';
  const quantity = quantityText && Number.isFinite(Number(quantityText)) ? Number(quantityText) : null;
  return { quantityText, quantity, unit: match?.[2]?.trim() ?? line.trim() };
}
