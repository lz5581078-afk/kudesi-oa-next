/** 系统规格换算成克：如“斤”=500、“500克”=500、“2千克”=2000；认不出返回 null。 */
export function systemWeightG(spec: string): number | null {
  const m = spec.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)?\s*(千克|公斤|kg|克|g|斤|j|两|毫克|mg|吨|t)(?:\s*\([^)]*\))?$/i);
  if (!m) return null;
  const f: Record<string, number> = { 千克: 1000, 公斤: 1000, kg: 1000, 克: 1, g: 1, 斤: 500, j: 500, 两: 50, 毫克: 0.001, mg: 0.001, 吨: 1_000_000, t: 1_000_000 };
  return Math.round(Number(m[1] ?? 1) * f[m[2]] * 1e6) / 1e6;
}

/** 名称规格按编码单位换算，不能识别的计数、体积单位返回 null。 */
export function specificationWeightG(qty: unknown, unit: unknown): number | null {
  const text = String(qty ?? '').trim();
  if (!text) return null;
  // 名称规格中的重量文字优先，如“净含量500g”；尺寸25*33不能当成数量。
  const embedded = text.match(/(\d+(?:\.\d+)?)\s*(千克|公斤|kgs?|克|g|斤|两|吨|t|毫克|mg)(?![a-z])/i);
  if (embedded) return systemWeightG(`${embedded[1]}${embedded[2].toLowerCase().replace('kgs', 'kg')}`);
  const factors: Record<string, number> = { G: 1, KG: 1000, J: 500, T: 1_000_000 };
  const factor = factors[String(unit)];
  if (factor === undefined || !/^\d+(?:\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n * factor * 1e6) / 1e6 : null;
}
