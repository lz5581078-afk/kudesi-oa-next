/** 只解读登记时保存的字段；不查询当前商品/分类补写历史。 */
export type CostHistoryValue = string | number | null;
export type CostHistoryValues = Record<string, CostHistoryValue | undefined>;
export const COST_HISTORY_FIELDS = [
  ['code', 'SKU组合编码'], ['name', 'SKU名称'], ['productCostCents', '成本'], ['preShipCostCents', '预发货成本'],
  ['weightG', '计费重量（kg）'], ['categoryId', '分类ID'], ['carrierName', '使用快递'], ['freightCents', '历史固定运费'], ['marginPercent', '利润率'], ['minPriceCents', '最低售价'],
] as const;
const numeric = (raw: unknown): number | null => raw === null || raw === undefined ? null : Number.isFinite(Number(raw)) ? Number(raw) : null;
export function costHistoryValues(row: Record<string, unknown>): CostHistoryValues {
  let context: Record<string, unknown> | null = null;
  try {
    const parsed = typeof row.context_json === 'string' ? JSON.parse(row.context_json) : row.context_json;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) context = parsed;
  } catch { /* 旧记录无可读上下文时保留未记录。 */ }
  const out: CostHistoryValues = { code: String(row.code ?? ''), name: String(row.name ?? ''), preShipCostCents: numeric(row.pre_ship_cost_cents), weightG: numeric(row.weight_g), freightCents: numeric(row.freight_cents), marginPercent: numeric(row.margin_percent), minPriceCents: numeric(row.min_price_cents) };
  if (context) {
    for (const key of ['productCostCents', 'categoryId'] as const) if (Object.hasOwn(context, key)) out[key] = numeric(context[key]);
    if (Object.hasOwn(context, 'carrierName')) out.carrierName = context.carrierName === null ? null : String(context.carrierName ?? '');
  }
  return out;
}
