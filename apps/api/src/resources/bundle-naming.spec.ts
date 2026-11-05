import { DEFAULT_RULE, NamingItem, composeBundle, resolvedMainStyleCode } from './bundle-naming';

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
    expect(r.mainStyleCode).toBe('ZH-KDS-HFS');
    expect(r.styleCode).toBe(r.mainStyleCode+'+ZP-XZ*2');
  });
  it('主款式按当前最终手改款式的原公式取得，不用自动结果覆盖手改或猜资料不全值',()=>{
    const automatic=composeBundle(null,input([item({})]));
    expect(resolvedMainStyleCode(automatic,'CUSTOM+ZP-XZ*2')).toBe('CUSTOM');
    expect(resolvedMainStyleCode(automatic,'import_style+ZP-X')).toBe('import_style');
    expect(resolvedMainStyleCode(automatic,'')).toBe(automatic.mainStyleCode);
    const incomplete=composeBundle(null,input([item({})],[item({id:9,code:'GIFT',giftCode:undefined,giftName:undefined})]));
    expect(incomplete.errors.length).toBeGreaterThan(0);
    expect(resolvedMainStyleCode(incomplete,'')).toBeUndefined();
    expect(resolvedMainStyleCode(incomplete,'KNOWN+ZP-G')).toBe('KNOWN');
  });

});

describe('独立编码来源逐商品命名（默认旧分支不变）',()=>{
 it('已填写的赠品简称优先于来源规则，数量和多个不同赠品不被同规格合并',()=>{
  const main=item({id:401,identity:'main'}),a=item({id:402,identity:'same-spec',giftName:'农管家拌种剂',giftCode:'NGJBZJ',qty:2}),b=item({id:403,identity:'same-spec',giftName:'花生合同',giftCode:'HSHT',qty:1});
  const own={...DEFAULT_RULE,codeFields:['baseCode','quantity'],nameFields:['name','quantity']};
  const result=composeBundle(null,{...input([main],[a,b]),itemRules:{401:DEFAULT_RULE,402:own,403:own}});
  expect(result.errors).toEqual([]);expect(result.code).toBe('ZH-TB-KDS-HFS-5J+ZP-NGJBZJ*2+HSHT*1');
  expect(result.styleCode).toBe('ZH-KDS-HFS+ZP-NGJBZJ*2+HSHT*1');expect(result.mainStyleCode).toBe('ZH-KDS-HFS');
  expect(result.name).toContain('+赠:农管家拌种剂×2+花生合同×1');expect(result.shortName).toContain('+赠:农管家拌种剂×2+花生合同×1');
 });
 it('主品各用自己的字段规则，赠品可信配置不用虚构赠品简称，缺字段仍给真实问题',()=>{
  const first=item({id:101,identity:'main-a',code:'MAIN-A'}),second=item({id:102,identity:'main-b',varietyInitials:'SECOND',varietyName:'第二主品'}),gift=item({id:103,identity:'gift-a',code:'GIFT-CODE',giftName:undefined,giftCode:undefined});
  const rules={101:{...DEFAULT_RULE,codeFields:['baseCode'],nameFields:['name']},102:{...DEFAULT_RULE,codeFields:['variety'],nameFields:['variety']},103:{...DEFAULT_RULE,codeFields:['baseCode','quantity'],nameFields:['name','quantity']}};
  const result=composeBundle(null,{...input([first,second],[gift]),itemRules:rules});expect(result.errors).toEqual([]);expect(result.code).toBe('ZH-TB-MAIN-A+SECOND+ZP-GIFT-CODE-1');expect(result.name).toContain('第二主品+赠:');
  expect(composeBundle(null,{...input([first],[gift]),itemRules:{...rules,103:{...rules[103],codeFields:['custom'],customCode:''}}}).errors.join('；')).toContain('自定义');
 });
 it('多主品前缀/名称前缀/款式前缀不一致明确阻断，配置未选场景不私加新段',()=>{
  const first=item({id:201,identity:'one'}),second=item({id:202,identity:'two'});
  const result=composeBundle(null,{...input([first,second]),scenarioSegment:'GYL',itemRules:{201:{...DEFAULT_RULE},202:{...DEFAULT_RULE,prefix:'OTHER-',namePrefix:'另一种-',stylePrefix:'STYLE-'}}});
  expect(result.errors).toEqual(expect.arrayContaining(['多个主商品的组合编码前缀不一致，请统一配置','多个主商品的组合名称前缀不一致，请统一配置','多个主商品的款式编码前缀设置不一致，请统一配置']));expect(result.code).not.toContain('GYL');
 });
 it('可信配置的同身份赠品按原可加总规格合并，旧无配置gift仍走旧简称校验',()=>{
  const first=item({id:301,identity:'main'}),a=item({id:302,identity:'gift',giftName:undefined,giftCode:undefined}),b=item({id:303,identity:'gift',giftName:undefined,giftCode:undefined});
  const rule={...DEFAULT_RULE,codeFields:['totalSpec'],nameFields:['totalSpec']};const result=composeBundle(null,{...input([first],[a,b]),itemRules:{301:DEFAULT_RULE,302:rule,303:rule}});expect(result.errors).toEqual([]);expect(result.code).toContain('+ZP-10J');
  expect(composeBundle(null,input([first],[a])).errors.join('；')).toContain('赠品简称');
 });
});
