/** Only strip monetary values; identifiers, quantities and delivery states remain readable. */
export function restrictOutboundPayload(payload: Record<string, unknown>, canCost: boolean, canPrice: boolean): Record<string, unknown> {
  const cost = new Set(['cost', 'costprice', 'costpricecents', 'totalcost', 'unitcost', 'purchaseprice', 'purchasepricecents', 'freight', 'handlingfee', 'importlaboramounts']);
  const price = new Set(['price', 'pricecents', 'saleprice', 'sprice', 'marketprice', 'composesaleprice', 'minprice', 'minpricecents', 'basicprice', 'baseprice']);
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => {
      const normalized = key.replace(/_/g, '').toLowerCase();
      return (canCost || !cost.has(normalized)) && (canPrice || !price.has(normalized) && !/^otherprice[1-5]$/.test(normalized));
    }).map(([key, item]) => [key, visit(item)]));
    if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
      try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === 'object') return JSON.stringify(visit(parsed)); } catch { /* plain text */ }
    }
    return value;
  };
  return visit(payload) as Record<string, unknown>;
}
