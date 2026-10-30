import { DEFAULT_RULE, NamingItem, composeBundle } from './bundle-naming';

const item = (over: Partial<NamingItem>): NamingItem => ({
  id: 1, code: 'SG-HFS-5J', name: '红富士苹果5斤', shortName: '红富士', styleCode: 'SG-HFS', spec: '5斤', qty: 1,
  categoryCode: 'PG', categoryName: '苹果', brandCode: 'KDS', brandName: '酷得斯', varietyInitials: 'HFS', varietyName: '红富士苹果',
  packageType: '', supplyMode: '', weightG: 2500, amount: 5, unitName: '斤', unitCode: 'J', identity: 'p1', ...over,
});
const input = (mains: NamingItem[], gifts: NamingItem[] = []) => ({
  mains, gifts, platformCode: 'TB', platformName: '淘宝', scenarioSegment: '', scenarioName: '', configNo: '01', bundleBrand: null,
});

describe('组合命名（旧系统规则）', () => {
  it('显式关闭款式前缀与编码前缀分离；采购方式和包装的名称、短码分别取值',()=>{
    const result=composeBundle({...DEFAULT_RULE,stylePrefix:'',codeFields:['supplyMode','packageType','totalSpec'],nameFields:['supplyMode','packageType','totalSpec']},input([item({supplyMode:'原装采购',supplyModeCode:'YZCG',packageType:'袋',packageTypeCode:'D'})]));
    expect(result.errors).toEqual([]);expect(result.code).toBe('ZH-TB-YZCG-D-5J');expect(result.styleCode).toBe('YZCG-D');expect(result.name).toBe('组合-原装采购-袋-5斤');
  });
  it('同一商品按单位累加：5斤×2 合并成 10斤', () => {
    const a = composeBundle(null, input([item({ id: 1, qty: 1 }), item({ id: 2, qty: 1 })]));
    expect(a.name).toContain('10斤');
    expect(a.code).toBe('ZH-TB-KDS-HFS-10J');
  });
  it('赠品没有别名时给出错误', () => {
    const r = composeBundle(null, input([item({})], [item({ id: 9, code: 'G-1', name: '赠品' })]));
    expect(r.errors.join()).toContain('赠品简称');
  });
  it('赠品用别名：+ZP-别名编码*数量', () => {
    const r = composeBundle(null, input([item({})], [item({ id: 9, code: 'G-1', name: '赠品', giftName: '小赠', giftCode: 'XZ', qty: 2, identity: 'g' })]));
    expect(r.errors).toEqual([]);
    expect(r.code).toContain('+ZP-XZ*2');
  });
});
