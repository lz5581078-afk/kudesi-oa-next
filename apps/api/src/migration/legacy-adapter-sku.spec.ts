import { readFakeLegacy } from './fake-legacy';
const mapping = require('../../../../scripts/migration/sku-mapping.cjs');

describe('SKU 迁移口径', () => {
  it('包装称重支持旧中文单位，缺省按旧源码的千克解释，未知单位拒绝猜测',()=>{
    expect(mapping.packageWeight('13','克')).toEqual({weightG:13,weightUnit:'g'});
    expect(mapping.packageWeight('0.2','千克')).toEqual({weightG:200,weightUnit:'kg'});
    expect(mapping.packageWeight('0.2',undefined).weightG).toBe(200);
    expect(mapping.packageWeight('2','斤').weightG).toBe(1000);expect(mapping.packageWeight('5','毫克').weightG).toBe(0.005);
    expect(()=>mapping.packageWeight('13','袋')).toThrow(/禁止猜测/);
  });
  it('旧V01与新01同义；只给历史上已用作赠品且缺字段的商品生成有来源的简称',()=>{
    expect(mapping.configNo('V01')).toBe('01');expect(mapping.configNo('V2')).toBe('02');expect(mapping.configNo('CUSTOM')).toBe('CUSTOM');
    const aliases=mapping.giftAliases({finance_products:[{id:'gift',brand:'某品牌',product_name:'水溶肥',payload_json:{}},{id:'unused',product_name:'不作赠品',payload_json:{}}],finance_product_base_codes:[{id:9,source_product_id:'gift'}],finance_product_bundle_bom_lines:[{role:'gift',component_type:'base_code',base_code_id:9}]},()=> 'MPP-SRF'.replace(/-/g,''));
    expect(aliases.get('gift')).toEqual({giftShortName:'某品牌水溶肥',giftCodeShortName:'MPPSRF'});expect(aliases.has('unused')).toBe(false);
  });
  it('按显式分类关联迁入命名规则，保留旧分类显示名与组合品牌；派生BOM不是额外采购价', async () => {
    const out = await readFakeLegacy({
      companies: [{ id: 7, name: '测试公司' }],
      finance_products: [{ id: 'oem', company_id: 7, archive_key: 'purchased', supply_mode: 'supplier_oem', category_id: 'c', product_code: 'TEST-OEM', product_name: '商品', brand: '来源品牌', amount: 1, unit: '克', status: 'normal', payload_json: { purchasePrice: 99, giftShortName: '小赠', giftCodeShortName: 'XZ' } }],
      finance_product_archive_costs: [{ id: 1, company_id: 7, product_id: 'oem', status: 'active', cost_type: 'purchase', source_type: 'production_bom', unit_cost: '0.3350', effective_from: '2026-01-01' }],
      finance_product_categories: [{ id: 'c', company_id: 7, archive_key: 'purchased', status: 'normal', name: '档案分类', payload_json: { productCodeCategoryId: 11, supplyModeScope: 'supplier_oem' } }],
      finance_product_code_dictionary: [{ id: 11, company_id: 7, dictionary_type: 'product_category', item_name: '旧编码分类', item_code: 'OLD', status: 'active' }, { id: 22, company_id: 7, dictionary_type: 'brand', item_name: '组合品牌', item_code: 'PP', status: 'active' }],
      finance_bundle_naming_rules: [{ company_id: 7, category_id: 11, rule_json: { prefix: 'ZH-', namePrefix: '组合-', stylePrefix: false, codeFields: ['brand', 'variety', 'totalSpec'], nameFields: ['category', 'variety'] } }],
      finance_product_bundle_codes: [{ id: 30, company_id: 7, status: 'active', bundle_definition_id: 31 }],
      finance_product_bundle_definitions: [{ id: 31, company_id: 7, brand_dictionary_id: 22 }],
    });
    const product = out.records.find(r => r.type === 'finance-products')!;
    expect(product.data.purchasePrice).toBeUndefined();
    expect(product.data).toMatchObject({ giftShortName: '小赠', giftCodeShortName: 'XZ' });
    const rule = out.records.find(r => r.type === 'finance-bundle-naming-rules')!;
    expect(rule.data).toMatchObject({ categoryId: { legacyRef: { type: 'finance-categories', id: 'c:supplier_oem' } }, codeFields: 'brand,variety,totalSpec', stylePrefix: '', nameOverrides: 'category=旧编码分类' });
    expect(out.records.find(r => r.type === 'finance-bundles')?.data.brandId).toEqual({ legacyRef: { type: 'finance-brands', id: 'brand:组合品牌' } });
  });
});
