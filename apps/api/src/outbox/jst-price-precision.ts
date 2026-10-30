/** 线上回查确认聚水潭普通商品成本/采购价只保存元后四位；禁止静默损失本地单价精度。 */
export class JstPricePrecisionError extends Error { readonly permanentFailure = true; }
export function assertJstNormalPricePrecision(payload: Record<string, unknown>): void {
  for (const [key, camel, label] of [['cost_price', 'costPrice', '成本价'], ['purchase_price', 'purchasePrice', '采购价']]) {
    const value = payload[key] ?? payload[camel];
    if (value == null) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || Math.abs(n - Math.round(n * 10000) / 10000) > 1e-9) {
      throw new JstPricePrecisionError(`聚水潭${label}只保留元后 4 位；原单价仍保留在新系统，请人工确认同步口径，不会自动舍入上传`);
    }
  }
}
