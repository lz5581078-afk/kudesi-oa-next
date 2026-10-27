/** 包装方案匹配规则（沿用旧系统口径）：通用规则适用所有对象；指定编码/分类/品牌/场景则必须一致；指定重量或重量区间则必须落在其中。 */
export interface PackagingRule {
  targetType: 'general' | 'base_code' | 'bundle' | 'product_archive';
  targetCode?: string | null;
  categoryId?: number | null;
  brandId?: number | null;
  scenarioId?: number | null;
  minWeightKg?: number | null;
  maxWeightKg?: number | null;
  discreteWeights?: number[];
  priority: number;
}

export interface PackagingTarget {
  targetType: 'base_code' | 'bundle' | 'product_archive';
  targetCode?: string | null;
  categoryId?: number | null;
  brandId?: number | null;
  scenarioId?: number | null;
  weightKg?: number | null;
}

export function parseDiscreteWeights(text: unknown): number[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  return text.split(/[,，\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

export function packagingRuleMatches(rule: PackagingRule, t: PackagingTarget): boolean {
  if (rule.targetType !== 'general' && rule.targetType !== t.targetType) return false;
  if (rule.targetCode && rule.targetCode.trim().toUpperCase() !== (t.targetCode ?? '').trim().toUpperCase()) return false;
  if (rule.categoryId && rule.categoryId !== t.categoryId) return false;
  if (rule.brandId && rule.brandId !== t.brandId) return false;
  if (rule.scenarioId && rule.scenarioId !== t.scenarioId) return false;
  const w = t.weightKg;
  const discrete = rule.discreteWeights ?? [];
  if (discrete.length) return w != null && Number.isFinite(w) && discrete.some((d) => Math.abs(d - w) < 1e-6);
  if (rule.minWeightKg != null && (w == null || w < rule.minWeightKg)) return false;
  if (rule.maxWeightKg != null && (w == null || w > rule.maxWeightKg)) return false;
  return true;
}
