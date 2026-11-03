import { costHistoryValues } from './cost-history-values';
describe('历史字段解读', () => {
  const row = { code: 'SYNTHETIC', name: '合成', pre_ship_cost_cents: '123.4567', weight_g: '1023.2', freight_cents: 0, margin_percent: null, min_price_cents: null };
  it('旧记录仅返回已留存字段，没有上下文不虚构分类、快递或独立成本', () => {
    expect(costHistoryValues(row)).toMatchObject({ preShipCostCents: 123.4567, weightG: 1023.2, freightCents: 0, marginPercent: null });
    expect(costHistoryValues(row).categoryId).toBeUndefined();
    expect(costHistoryValues({ ...row, context_json: '{bad' }).carrierName).toBeUndefined();
  });
  it('对象或JSON文字上下文保留当时的零成本、空分类和空快递', () => {
    const context = { productCostCents: 0, categoryId: null, carrierName: '' };
    for (const context_json of [context, JSON.stringify(context)]) expect(costHistoryValues({ ...row, context_json })).toMatchObject(context);
  });
});
