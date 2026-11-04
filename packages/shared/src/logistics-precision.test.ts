import {describe,expect,it} from 'vitest';
import {LOGISTICS_CENT_SCALE,UNIT_CENT_SCALE,multiplyUnitCents,quantizeUnitCents,settledLineCents,sumUnitCents,sumUnitCentsProducts,unitYuanText,validUnitCents,yuanToPreciseCents} from './unit-price';
import {RESOURCE_DEFS,validateResourceInput} from './resources';

describe('档案物流显式八位元与默认单价/结算边界',()=>{
 it('物流八位元转换与JSON往返，不改变普通六位元报价',()=>{
  const amount=yuanToPreciseCents('0.12345678',LOGISTICS_CENT_SCALE);
  expect(amount).toBe(12.345678);expect(unitYuanText(amount,6)).toBe('0.12345678');
  expect(unitYuanText(-amount,6)).toBe('-0.12345678');expect(unitYuanText(0.000001,6)).toBe('0.00000001');
  expect(validUnitCents(JSON.parse(JSON.stringify(amount)),6)).toBe(true);
  expect(validUnitCents(amount)).toBe(false);expect(()=>yuanToPreciseCents('0.12345678')).toThrow();
  expect(()=>yuanToPreciseCents('0.123456789',6)).toThrow(/精度/);
  expect(UNIT_CENT_SCALE).toBe(4);expect(unitYuanText(yuanToPreciseCents('0.123456'))).toBe('0.123456');
 });
 it('混合普通采购价与两项物流金额合计保留八位元，终点舍入必须显式',()=>{
  const fee=yuanToPreciseCents('0.12345678',6);
  const total=sumUnitCents([yuanToPreciseCents('1'),fee,fee],6);
  expect(total).toBe(124.691356);expect(unitYuanText(total,6)).toBe('1.24691356');
  // 原派生台账的四位元输出是独立终点，不能据此提前截断输入。
  expect(quantizeUnitCents(total,6,2)).toBe(124.69);
  expect(quantizeUnitCents(total,6,4)).toBe(124.6914);
  expect(quantizeUnitCents(-12.34565,6,4)).toBe(-12.3457);
  expect(quantizeUnitCents(12.3456,4,6)).toBe(12.3456);
 });
 it('数量六位与金额六位分开指定，所有组成乘积合计后才舍入',()=>{
  expect(multiplyUnitCents(12.345678,1.123456,0,6,6)).toBe(13.869826);
  expect(()=>multiplyUnitCents(12.345678,1.123456,0,6)).toThrow();
  const terms=[{value:0.000001,quantity:0.4},{value:0.000001,quantity:0.4}];
  expect(sumUnitCentsProducts(terms,6,6)).toBe(0.000001);
  expect(sumUnitCents(terms.map(t=>multiplyUnitCents(t.value,t.quantity,0,6,6)),6)).toBe(0);
  expect(sumUnitCentsProducts([{value:12.345678,quantity:2,lossPercent:5}],6,6)).toBe(25.925924);
  // 不能先把乘积舍入8位元再舍入报价6位：真实乘积略低于六位舍入中点。
  expect(sumUnitCentsProducts([{value:49.999999,quantity:0.000001}],6,6,4)).toBe(0);
  expect(multiplyUnitCents(49.999999,0.000001,0,6,6,4)).toBe(0);
  expect(()=>sumUnitCentsProducts([{value:1,quantity:0.1234567}],6,6)).toThrow();
  expect(settledLineCents(0.25,2)).toBe(1);expect(()=>settledLineCents(12.345678,1)).toThrow();
 });
 it('高精度转换/汇总/乘价拒绝不安全ticks，不将大值截成合法数字',()=>{
  expect(()=>yuanToPreciseCents('999999999.12345678',6)).toThrow(/安全/);
  expect(validUnitCents(99_999_999_999,6)).toBe(false);
  expect(()=>sumUnitCents([9_000_000_000,9_000_000_000],6)).toThrow(/安全/);
  expect(()=>multiplyUnitCents(1000000,1000000,0,6,6)).toThrow(/安全/);
  expect(()=>sumUnitCentsProducts([{value:1000000,quantity:1000000}],6,6)).toThrow(/安全/);
  expect(validUnitCents(1000000.123456,6)).toBe(true);
 });
 it('只有产品与物流历史两费字段启用新精度，其余金额元数据不扩展',()=>{
  for(const key of ['finance-products','finance-product-freight-history']){
   const def=RESOURCE_DEFS.find(d=>d.key===key)!;
   expect(def.fields.find(f=>f.key==='freight')?.scale).toBe(6);
   expect(def.fields.find(f=>f.key==='handlingFee')?.scale).toBe(6);
   expect(def.fields.find(f=>f.key==='purchasePrice')?.scale).toBe(4);
  }
  const product=RESOURCE_DEFS.find(d=>d.key==='finance-products')!;
  expect(product.fields.find(f=>f.key==='totalCost')).toMatchObject({scale:6,readonly:true});
  const existing={archiveType:'raw',name:'原料',categoryId:1,specQty:1,specUnit:'J'};
  const input={freight:12.345678,handlingFee:12.345678};
  expect(validateResourceInput(product,input,{existing,status:'active'}).errors).toEqual([]);
  expect(validateResourceInput(product,{freight:12.3456789},{existing,status:'active'}).errors.join()).toMatch(/8 位元/);
  expect(validateResourceInput(product,{purchasePrice:12.345678},{existing,status:'active'}).errors.join()).toMatch(/6 位元/);
  const bank=RESOURCE_DEFS.find(d=>d.key==='bank-accounts')!;
  expect(validateResourceInput(bank,{balance:0.25},{existing:{kind:'company_public',accountName:'测试',bank:'测试',accountNo:true},status:'normal'}).errors.join()).toMatch(/整数/);
 });
});
