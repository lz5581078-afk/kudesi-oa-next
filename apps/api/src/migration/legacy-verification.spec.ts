export {};
const { readonlyQuery, baseCostBasis, COST_BASIS } = require('../../../../scripts/migration/legacy-verification.cjs');
describe('旧商品验证只读核对入口', () => {
  it('只把SELECT交给只读快照连接，拒绝写入、事务控制和多语句', async () => {
    const c = { query: jest.fn().mockResolvedValue([[{ id: 1 }]]) };
    const read = readonlyQuery(c);
    expect(await read('SELECT * FROM x WHERE company_id=?', [3])).toEqual([{ id: 1 }]);
    for (const sql of ['UPDATE x SET id=2', 'COMMIT', 'SELECT 1; DELETE FROM x', 'CALL business_write()']) await expect(read(sql, [])).rejects.toThrow('只读');
    expect(c.query).toHaveBeenCalledTimes(1);
  });
  it('独立按生效成本记录加运杂费汇总，避开档案缓存价并保留元6位精度', () => {
    const tables = { finance_product_base_codes: [{ id: 80, source_product_id: 'p1' }], finance_products: [{ id: 'p1', payload_json: { purchasePrice: 2, freightAmount: 0.00002, handlingAmount: 0.00001 } }], finance_product_archive_costs: [{ id: 1, product_id: 'p1', cost_type: 'purchase', unit_cost: '0.3350', status: 'active', effective_from: '2026-01-01' }, { id: 2, product_id: 'p1', cost_type: 'purchase', unit_cost: '99.0000', status: 'active', effective_from: '2027-01-01' }], finance_product_code_links: [{ base_code_id: 80, product_id: 'p1', quantity: '2.000000' }] };
    const b = baseCostBasis(tables, tables.finance_product_base_codes[0], '2026-11-01');
    expect(b.policy).toBe(COST_BASIS); expect(b.costCents).toBe(67.006);
    expect(b.components).toEqual([expect.objectContaining({ quantity: '2.000000', node: expect.objectContaining({ recordId: '1', unitCost: '0.3350' }) })]);
    expect(tables.finance_products[0].payload_json.purchasePrice).toBe(2);
  });
  it('OEM的production_bom是汇总记录，按底层采购记录重新汇总，不重复加入旧汇总价', () => {
    const base = { id: 80, source_product_id: 'oem' };
    const tables = { finance_products: [{ id: 'oem', archive_key: 'purchased', supply_mode: 'supplier_oem', payload_json: { purchasePrice: 2, freightAmount: 0.004, handlingAmount: 0 } }, { id: 'package', archive_key: 'package', payload_json: { freightAmount: 0.065, handlingAmount: 0 } }], finance_product_archive_costs: [{ id: 1, product_id: 'oem', cost_type: 'purchase', unit_cost: '0.3350', source_type: 'production_bom', status: 'active', effective_from: '2026-01-01' }, { id: 2, product_id: 'package', cost_type: 'purchase', unit_cost: '0.3350', source_type: 'archive_purchase_price', status: 'active', effective_from: '2026-01-01' }], finance_product_archive_boms: [{ id: 1, owner_product_id: 'oem', status: 'active' }], finance_product_archive_bom_lines: [{ id: 1, bom_id: 1, component_product_id: 'package', quantity: '1.000000', loss_rate: '0.000000', cost_treatment: 'include' }] };
    const b = baseCostBasis(tables, base, '2026-11-01'); expect(b.costCents).toBe(40.4);
    expect(b.components[0].node.includePurchase).toBe(false);
    expect(b.components[0].node.children[0].node.recordId).toBe('2');
  });
});
