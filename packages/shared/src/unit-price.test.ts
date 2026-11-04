import { describe, expect, it } from 'vitest';
import { settledLineCents, averageUnitCents, sumUnitCents, multiplyUnitCents, yuanToPreciseCents, validUnitCents } from './unit-price';
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
  it('组成明确采用六位数量，默认四位与单据结算边界不变',()=>{expect(multiplyUnitCents(212.5681,1.123456,0,6)).toBe(238.8109);expect(()=>multiplyUnitCents(100,1.123456)).toThrow();expect(()=>multiplyUnitCents(100,1.1234567,0,6)).toThrow();expect(()=>settledLineCents(100,1.123456)).toThrow();});
  it('极小单价与六位组成数量精确相乘，结算及新精度转换拒绝不安全整数',()=>{expect(multiplyUnitCents(0.0001,999999.999999,0,6)).toBe(100);expect(multiplyUnitCents(0.0001,0.000001,0,6)).toBe(0);expect(settledLineCents(Number.MAX_SAFE_INTEGER,1)).toBe(Number.MAX_SAFE_INTEGER);expect(settledLineCents(Number.MIN_SAFE_INTEGER,1)).toBe(Number.MIN_SAFE_INTEGER);expect(()=>settledLineCents(Number.MAX_SAFE_INTEGER,2)).toThrow(/安全整数/);expect(()=>multiplyUnitCents(1000000000,1000000,0,6)).toThrow(/安全整数/);});
  it('财务档案允许精细单价，银行余额等金额不放开',()=>{
    const product=RESOURCE_DEFS.find(d=>d.key==='finance-products')!;
    expect(validateResourceInput(product,{purchasePrice:0.25},{status:'active',existing:{archiveType:'raw',name:'原料',categoryId:1,specQty:1,specUnit:'J'}}).errors).toEqual([]);
    const bank=RESOURCE_DEFS.find(d=>d.key==='bank-accounts')!;
    expect(validateResourceInput(bank,{balance:0.25},{status:'normal',existing:{kind:'company_public',accountName:'测试',bank:'测试',accountNo:true}}).errors.join()).toMatch(/整数/);
  });
});

it('库存平均报价由整数分总额定点相除，保留6位元精度及负金额，零数量无报价',()=>{
 expect(averageUnitCents(1,3)).toBe(0.3333);expect(averageUnitCents(-1,3)).toBe(-0.3333);
 expect(averageUnitCents(275,2.5)).toBe(110);expect(averageUnitCents(1,0.0001)).toBe(10000);
 expect(averageUnitCents(0,3)).toBe(0);expect(averageUnitCents(100,0)).toBeNull();expect(averageUnitCents(100,-1)).toBeNull();
 expect(()=>averageUnitCents(0.1,1)).toThrow();expect(()=>averageUnitCents(100,0.00001)).toThrow();
});

it('库存分录和红冲保留明细的自由单位，金额科目不携带库存单位',async()=>{
  const {buildEntries,negateEntries}=await import('./finance-documents');
  for(const type of ['sale','online-sale','sale-return','purchase-in','purchase-return'] as const){
    const entries=buildEntries({type,date:'2026-11-03',partyId:1,storeId:1,warehouseId:1,lines:[{productId:1,unit:'原计价单位',qty:2,unitPriceCents:1000,unitCostCents:500}]},()=>500);
    expect(entries.find(entry=>entry.kind==='inventory')?.unit).toBe('原计价单位');
    expect(negateEntries(entries).find(entry=>entry.kind==='inventory')?.unit).toBe('原计价单位');
    expect(entries.filter(entry=>entry.kind!=='inventory').every(entry=>entry.unit===undefined)).toBe(true);
  }
});
