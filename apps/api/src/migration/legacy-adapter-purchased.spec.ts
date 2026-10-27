/** 迁移适配器：外购成品的两个入口（原装采购 / 供应商 OEM）——页签归属、分类树归属都能由旧字段推出（假旧库） */
import { resourceTabOf, getResourceDef } from '@kudesi/shared';
import { FakeOut, readFakeLegacy } from './fake-legacy';

const cat = (id: number, scope: string | null, name: string, extra: Record<string, unknown> = {}) => ({ id, company_id: 7, archive_key: 'purchased', parent_id: null, name, category_code: `C${id}`, sort_order: id, status: 'active', payload_json: JSON.stringify(scope ? { supplyModeScope: scope } : {}), ...extra });
const prod = (id: string, mode: string | null, category: number) => ({ id, company_id: 7, archive_key: 'purchased', supply_mode: mode, category_id: category, product_code: `P-${id}`, product_name: `商品${id}`, brand: '', amount: '1', unit: '千克', status: 'normal', payload_json: '{}' });

describe('迁移适配器：外购成品两个入口', () => {
  let out: FakeOut;
  beforeAll(async () => {
    out = await readFakeLegacy({
      companies: [{ id: 7, name: '测试公司' }],
      finance_product_categories: [
        cat(1, 'original_purchase', '原装树'),
        cat(2, 'supplier_oem', 'OEM树'),
        cat(3, null, '没标范围的老分类'), // 旧系统视为原装采购
        { ...cat(4, null, '老OEM分类'), payload_json: JSON.stringify({ productCodeCategoryScope: 'supplier_oem' }) },
      ],
      finance_products: [prod('a', 'original_purchase', 1), prod('b', 'supplier_oem', 2), prod('c', null, 3), prod('d', '', 1)],
    });
  });
  const cats = () => out.records.filter((r) => r.type === 'finance-categories');
  const prods = () => out.records.filter((r) => r.type === 'finance-products');

  it('分类树：按 supplyModeScope / productCodeCategoryScope 分到原装采购或供应商 OEM，没标的算原装采购', () => {
    const by = Object.fromEntries(cats().map((c) => [String(c.data.code), c.data.archiveType]));
    expect(by).toMatchObject({ C1: 'original_purchase', C2: 'supplier_oem', C3: 'original_purchase', C4: 'supplier_oem' });
  });

  it('商品：采购方式不是供应商 OEM 的（含旧数据为空）都迁成原装采购，页签归属由采购方式推出，且挂在同一棵树的分类上', () => {
    const def = getResourceDef('finance-products')!;
    const tabs = Object.fromEntries(prods().map((p) => [p.id, resourceTabOf(def, p.data)]));
    expect(tabs).toEqual({ a: 'original_purchase', b: 'supplier_oem', c: 'original_purchase', d: 'original_purchase' });
    for (const p of prods()) {
      expect(p.data.archiveType).toBe('purchased');
      const ref = (p.data.categoryId as { legacyRef: { id: string } }).legacyRef.id;
      const target = cats().find((c) => c.id === ref)!;
      expect(target.data.archiveType).toBe(p.data.supplyMode);
    }
  });
});
