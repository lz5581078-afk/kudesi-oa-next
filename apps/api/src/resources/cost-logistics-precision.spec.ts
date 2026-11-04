import {ResourceRecord} from '../entities';
import {calculateCostComponents} from './cost-components';
import {costSeedBuckets,type VersionSeedData} from './cost-seed-buckets';
import {computeVersion,describeCostVersion,type CostSeed} from './cost-version-engine';
import type {CostRow} from './cost.service';
const r=(id:number,data:Record<string,unknown>,type='finance-products')=>Object.assign(new ResourceRecord(),{id,companyId:1,type,data,status:'active',title:'合成'});
const context=(prices:number[])=>({products:new Map(prices.map((price,i)=>[i+1,r(i+1,{totalCost:price,weightG:1000})])),lines:prices.map((_price,i)=>r(i+100,{bundleId:7,productId:i+1,role:'main',qty:1},'finance-bundle-lines')),baseCodeLines:[] as ResourceRecord[],baseCodes:new Map<number,ResourceRecord>(),labor:new Map<number,ResourceRecord>()});
describe('物流来源八位元到独立报价终点',()=>{
 it('活成本登记全部真实组成累计后一次保留六位元，明细保留原始单位价',()=>{
  const d=context([124.691356]),result=calculateCostComponents(d,7);expect(result.cost).toBe(124.6914);expect(result.lines[0]).toMatchObject({unitCostCents:124.691356,subtotalCents:124.6914});expect(d.products.get(1)!.data.totalCost).toBe(124.691356);
  // 真24 bundle-current-values: 总和最后toFixed6，不能把每行先舍入后的0相加。
  const tiny=calculateCostComponents(context([0.000049,0.000049]),7);expect(tiny.lines.map(line=>line.subtotalCents)).toEqual([0,0]);expect(tiny.cost).toBe(0.0001);
 });
 it('基础编码读取原schema四位元的真实保存报价，不以档案八位总额或普通容量六位猜派生终点',()=>{
  const d=context([124.691356]);d.baseCodes.set(8,r(8,{productId:1,cost:124.69},'finance-base-codes'));d.lines[0].data={bundleId:7,baseCodeId:8,role:'main',qty:1};expect(calculateCostComponents(d,7).lines[0].unitCostCents).toBe(124.69);
  d.baseCodes.get(8)!.data={origin:'composed',cost:124.69};d.baseCodeLines=[r(99,{baseCodeId:8,productId:1,qty:1})];expect(calculateCostComponents(d,7).cost).toBe(124.69);
  delete d.baseCodes.get(8)!.data.cost;expect(calculateCostComponents(d,7).cost).toBeNull();
 });
 it('派生mirror元4、档案元8和外部手填元6是三个来源，不在数量乘价前误截直接档案',()=>{
  const d=context([1.234499]);d.lines[0].data.qty=100;expect(calculateCostComponents(d,7).cost).toBe(123.4499);
  d.baseCodes.set(8,r(8,{productId:1,cost:1.23},'finance-base-codes'));d.lines[0].data={bundleId:7,baseCodeId:8,role:'main',qty:100};expect(calculateCostComponents(d,7).cost).toBe(123);
  d.baseCodes.get(8)!.data={origin:'external_import',externalCost:1.2345,weightG:1000};expect(calculateCostComponents(d,7).lines[0].unitCostCents).toBe(1.2345);
 });
 it('独立版本来源物流八位元先真实乘数量，再按源amount四位元终点，不改历史',()=>{
  const d={...context([124.691356]),baseCodes:new Map([[8,r(8,{productId:1},'finance-base-codes')]]),archiveCosts:[r(10,{productId:1,costType:'purchase',unitCost:100,effectiveFrom:'2026-01-01'},'finance-product-costs')],freightHistories:[r(11,{productId:1,freight:12.345678,handlingFee:12.345678,recordedAtKey:'2026-01-01'},'finance-product-freight-history')],laborVersions:[]} as unknown as VersionSeedData;
  const before=JSON.stringify(d.freightHistories);expect(costSeedBuckets(d,8,'2026-11-04')).toMatchObject({purchase:100,transfer:24.69});expect(JSON.stringify(d.freightHistories)).toBe(before);
 });
 it('原cost-calculator桶/合计四位元输出不缩减普通输入容量，不回写锁定快照',()=>{
  const version=r(1,{defaultMarkupPercent:0},'finance-cost-versions'),setting=r(2,{versionId:1,skuType:'base_code',baseCodeId:8,purchaseCost:100.1234,transferCost:24.6913},'finance-cost-skus');const seed:CostSeed={skuType:'base_code',skuId:8,productIds:[1],categoryIds:[],row:{bundleId:8,code:'HC',name:'合成',preShipCostCents:124.8147,weightG:1000,issues:[],lines:[]} as unknown as CostRow};
  const before=JSON.stringify(setting.data),result=computeVersion(version,[setting],[seed],()=>null).rows[0];expect(result.buckets).toMatchObject({purchase:100.12,transfer:24.69});expect(result.preShipCostCents).toBe(124.81);expect(JSON.stringify(setting.data)).toBe(before);
  version.data.lockedAt='2026-10-24';setting.data.snapshot={...result,preShipCostCents:124.8147};const snapshot=JSON.stringify(setting.data.snapshot);expect(describeCostVersion(version,[setting],[seed],()=>null).rows[0].preShipCostCents).toBe(124.8147);expect(JSON.stringify(setting.data.snapshot)).toBe(snapshot);
 });
});
