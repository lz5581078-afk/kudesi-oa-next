import { describe, expect, it } from 'vitest';
import { settledLineCents, sumUnitCents, multiplyUnitCents, yuanToPreciseCents, validUnitCents } from './unit-price';
import { minSalePriceCentsByMicroPercent } from './pricing';
import { validateResourceInput, RESOURCE_DEFS } from './resources';
import { lineAmount, validateDoc } from './finance-documents';

describe('精细单价与整数分结算边界',()=>{
  it('保留旧单价小数；普通金额继续拒绝分以下值',()=>{
    expect(yuanToPreciseCents('0.0025')).toBe(0.25);
    expect(yuanToPreciseCents('0.000001')).toBe(0.0001);
    expect(()=>yuanToPreciseCents('0.0000001')).toThrow();
    expect(()=>yuanToPreciseCents('0.001',0)).toThrow();
    expect(validUnitCents(0.25)).toBe(true);expect(validUnitCents(0.25,0)).toBe(false);
  });
  it('不逐个先舍入单价；数量乘完才结算',()=>{
    expect(settledLineCents(0.25,100)).toBe(25);
    expect(settledLineCents(0.25,2)).toBe(1);
    expect(settledLineCents(100.5,1)).toBe(101);
    expect(settledLineCents(-100.5,1)).toBe(-101);
    expect(lineAmount({unitPriceCents:0.25,qty:100})).toBe(25);
  });
  it('成本明细保留小数并定点求和，最低售价最后向上取整到分',()=>{
    expect(sumUnitCents([0.1,0.2])).toBe(0.3);
    expect(multiplyUnitCents(0.25,3)).toBe(0.75);
    expect(multiplyUnitCents(100,2,5)).toBe(210);
    expect(minSalePriceCentsByMicroPercent({preShipCostCents:0.75,freightCents:0,marginMicroPercent:0})).toBe(1);
    expect(minSalePriceCentsByMicroPercent({preShipCostCents:100.25,freightCents:100,marginMicroPercent:25_000_000})).toBe(267);
  });
  it('财务档案允许精细单价，银行余额等金额不放开',()=>{
    const product=RESOURCE_DEFS.find(d=>d.key==='finance-products')!;
    expect(validateResourceInput(product,{purchasePrice:0.25},{status:'active',existing:{archiveType:'raw',name:'原料',categoryId:1,specQty:1,specUnit:'J'}}).errors).toEqual([]);
    const bank=RESOURCE_DEFS.find(d=>d.key==='bank-accounts')!;
    expect(validateResourceInput(bank,{balance:0.25},{status:'normal',existing:{kind:'company_public',accountName:'测试',bank:'测试',accountNo:true}}).errors.join()).toMatch(/整数/);
  });
});
