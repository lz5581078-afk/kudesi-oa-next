import { restrictOutboundPayload } from './outbound-payload-permissions';

describe('出站记录成本与价格独立投影', () => {
  const input = { sku_id: 'A', qty: 2, status: 'pending', cost_price: 1, costPrice: 1, purchase_price: 2, purchasePrice: 2, sale_price: 3, s_price: 3, salePrice: 3, marketPrice: 4, other_price_1: 5, otherPrice5: 6, nested: { children: [{ name: '子项', costPrice: 1, compose_sale_price: 9 }] }, encoded: JSON.stringify({ costPrice: 1, sale_price: 3, skuId: 'B' }) };
  it.each([[false, false], [true, false], [false, true], [true, true]])('成本=%s 价格=%s时只清除相应金额和别名/嵌套', (cost, price) => {
    const result = restrictOutboundPayload(input, cost, price);
    expect(result).toMatchObject({ sku_id: 'A', qty: 2, status: 'pending' });
    expect('cost_price' in result).toBe(cost); expect('purchasePrice' in result).toBe(cost);
    expect('salePrice' in result).toBe(price); expect('s_price' in result).toBe(price); expect('otherPrice5' in result).toBe(price);
    const nested = result.nested as { children: Array<Record<string, unknown>> }; expect('costPrice' in nested.children[0]).toBe(cost); expect('compose_sale_price' in nested.children[0]).toBe(price);
    const encoded = JSON.parse(String(result.encoded)); expect('costPrice' in encoded).toBe(cost); expect('sale_price' in encoded).toBe(price);
    expect(input.cost_price).toBe(1); expect(input.nested.children[0].costPrice).toBe(1);
  });
});
