/** 最新供货成本按采购价更新时间选择；改联系人、产区等资料不应改变采用哪一条报价。 */
export function sourcePriceTime(priceUpdatedAt: unknown, updatedAt?: string | Date): number {
  const parse = (value: unknown) => typeof value === 'string' || value instanceof Date ? new Date(value).getTime() : NaN;
  const price = parse(priceUpdatedAt);
  if (Number.isFinite(price)) return price;
  const fallback = parse(updatedAt);
  return Number.isFinite(fallback) ? fallback : 0;
}
