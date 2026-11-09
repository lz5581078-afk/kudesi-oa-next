import { describe, expect, it } from 'vitest';
import { combineWeights, fillSpecs, parseWeightGrams } from './sku-spec-fill';

describe('读重量', () => {
  it('各种单位', () => {
    expect(parseWeightGrams('200g')).toBe(200);
    expect(parseWeightGrams('25千克')).toBe(25000);
    expect(parseWeightGrams('5斤')).toBe(2500);
    expect(parseWeightGrams('1.5公斤')).toBe(1500);
    expect(parseWeightGrams('蛇皮袋-花育25 50斤-铁胖墩-1180*580*110-毫米-25千克')).toBe(25000);
  });
  it('没有或互相矛盾就不猜', () => {
    expect(parseWeightGrams('1180*580*110-毫米')).toBeNull();
    expect(parseWeightGrams('50斤 10kg')).toBeNull();
    expect(parseWeightGrams('')).toBeNull();
  });
});

describe('凑重量', () => {
  it('500g 用 200g 和 100g：2 个 200 + 1 个 100', () => {
    const c = combineWeights(500, [{ id: 1, grams: 200 }, { id: 2, grams: 100 }])!;
    expect(c.lines).toEqual([{ id: 1, qty: 2 }, { id: 2, qty: 1 }]);
    expect(c.pieces).toBe(3);
    expect(c.ambiguous).toBe(false);
  });
  it('凑不出来返回 null', () => {
    expect(combineWeights(450, [{ id: 1, grams: 200 }, { id: 2, grams: 100 }])).toBeNull();
    expect(combineWeights(500, [])).toBeNull();
  });
  it('件数一样的多种凑法要提示', () => {
    expect(combineWeights(600, [{ id: 1, grams: 300 }, { id: 2, grams: 200 }, { id: 3, grams: 100 }])!.ambiguous).toBe(false); // 2×300 唯一最少
    expect(combineWeights(500, [{ id: 1, grams: 300 }, { id: 2, grams: 250 }, { id: 3, grams: 200 }])!.ambiguous).toBe(true); // 300+200 与 2×250
  });
});

describe('按规格名称填', () => {
  it('主商品和赠品各自凑，凑不出来留空并提示', () => {
    const [a, b, c] = fillSpecs([
      { name: '500g', mainGrams: 500, giftGrams: 200 },
      { name: '450g', mainGrams: 450, giftGrams: null },
      { name: '没写重量', mainGrams: null, giftGrams: null },
    ], [{ id: 1, spec: '200g' }, { id: 2, spec: '100g' }], [{ id: 9, spec: '100g' }]);
    expect(a).toMatchObject({ main: [{ baseCodeId: 1, qty: 2 }, { baseCodeId: 2, qty: 1 }], gift: [{ baseCodeId: 9, qty: 2 }], warnings: [] });
    expect(b.main).toEqual([]);
    expect(b.warnings[0]).toContain('凑不出来');
    expect(c.warnings[0]).toContain('没读到重量');
  });
  it('规格名称写了赠品但没选赠品', () => {
    const [r] = fillSpecs([{ name: 'x', mainGrams: 200, giftGrams: 100 }], [{ id: 1, spec: '200g' }], []);
    expect(r.main).toEqual([{ baseCodeId: 1, qty: 1 }]);
    expect(r.warnings.join()).toContain('没有选赠品');
  });
});
