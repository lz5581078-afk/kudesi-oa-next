import { ResourceRecord } from '../entities';
import { computeVersion, markedUpPrice, perKgCost, recalculationPreview, type CostSeed } from './cost-version-engine';
import type { CostRow } from './cost.service';

const record = (id:number,type:string,data:Record<string,unknown>,status='active') => Object.assign(new ResourceRecord(),{id,type,companyId:1,status,title:String(data.skuName || data.versionName || '测试'),data});
const version=record(1,'finance-cost-versions',{versionName:'秋季',defaultMarkupPercent:20},'draft');
const setting=()=>record(10,'finance-cost-skus',{versionId:1,skuType:'bundle',bundleId:100});
const seed:CostSeed={skuType:'bundle',skuId:100,productIds:[2],categoryIds:[3],row:{bundleId:100,code:'ZH-100',name:'组合',status:'verified',categoryId:3,categoryName:'果品',preShipCostCents:1000.1234,freightCents:200,weightG:1000,lines:[],issues:[],carrierName:'快递',updatedAtMs:0} as unknown as CostRow};
const run=(records:ResourceRecord[],v=version)=>computeVersion(v,records,[seed],()=>300,true);

describe('版本成本计算',()=>{
  it('使用加价率而不是利润率，原单价精度保留，最后才向上结算到分',()=>{
    expect(markedUpPrice(1000,20)).toBe(1200);
    expect(markedUpPrice(1000.0001,20)).toBe(1201);
    expect(markedUpPrice(100,0.000001)).toBe(101);
    expect(perKgCost(100,123.456789)).toBe(12.3457);
  });
  it('手工科目优先，未手工维护时从来源取值；重量改变才重新估快递',()=>{
    const first=run([setting()]).rows[0];
    expect(first.buckets.purchase).toBe(1000.1234);expect(first.freightCents).toBe(200);
    const row=setting();row.data.estimatedWeightG=2000;row.data.purchaseCost=99.9999;row.data.markupPercent=0;
    const changed=run([row]).rows[0];expect(changed.freightCents).toBe(300);expect(changed.minPriceCents).toBe(400);
  });
  it('辅助成本按数量归集，兜底不覆盖已有成本，之后再应用单品调整',()=>{
    const type=record(20,'finance-cost-aux-types',{versionId:1,calculationMethod:'fixed_per_item'});
    const aux=record(21,'finance-cost-auxiliary',{versionId:1,auxTypeId:20,costBucket:'production',amount:12.3456});
    const assignment=record(22,'finance-cost-assignments',{versionId:1,skuSettingId:10,auxiliaryId:21,qty:2,mode:'add'});
    const fallback=record(23,'finance-cost-overrides',{versionId:1,skuSettingId:10,costBucket:'production',amount:50,mode:'fallback'});
    const row=run([setting(),type,aux,assignment,fallback]).rows[0];expect(row.buckets.production).toBe(24.6912);
    fallback.data.mode='replace';expect(run([setting(),type,aux,assignment,fallback]).rows[0].buckets.production).toBe(50);
  });
  it('辅助类型的计价方式不改变已维护辅助单价，分摊仍按单价乘数量',()=>{
    const s=setting();s.data.estimatedWeightG=123.456789;
    const type=record(20,'finance-cost-aux-types',{versionId:1,calculationMethod:'per_kg'}),aux=record(21,'finance-cost-auxiliary',{versionId:1,auxTypeId:20,costBucket:'production',amount:100}),assignment=record(22,'finance-cost-assignments',{versionId:1,skuSettingId:10,auxiliaryId:21,qty:2,mode:'add'});
    expect(run([s,type,aux,assignment]).rows[0].buckets.production).toBe(200);
  });
  it('生产标准按仓库、范围和重量匹配，按优先级顺序累加到生产成本',()=>{
    const standard=record(30,'finance-cost-production-rates',{versionId:1,targetType:'category',categoryId:3,warehouseName:'一号仓',calculationMethod:'fixed_plus_kg',fixedAmount:50,unitAmount:100,priority:100});
    expect(run([setting(),standard]).rows[0].buckets.production).toBe(0);
    const s=setting();s.data.warehouseName='一号仓';expect(run([s,standard]).rows[0].buckets.production).toBe(150);
    s.data.productionCost=20;expect(run([s,standard]).rows[0].buckets.production).toBe(170);
    const preferred=record(31,'finance-cost-production-rates',{...standard.data,priority:1,fixedAmount:10,unitAmount:0});
    expect(run([s,standard,preferred]).rows[0].buckets.production).toBe(30);
  });
  it('发货包装计入快递前成本，投产试算不会漏掉这笔成本',()=>{
    const s=setting();s.data.shippingPackageCost=50;const row=run([s]).rows[0];
    expect(row.preShipCostCents).toBe(1050.1234);expect(row.costIncludingFreightCents).toBe(1250.1234);
  });
  it('空版本不能启用，来源缺失和零值以警告提示而不阻断',()=>{
    expect(run([]).ready).toBe(false);
    const s=setting();s.data.bundleId=999;
    expect(run([s]).warnings.join()).toMatch(/来源SKU/);
    expect(run([s]).ready).toBe(true);
  });
  it('停用分摊不会计入成本，引用停用类型给出警告',()=>{
    const type=record(20,'finance-cost-aux-types',{versionId:1,calculationMethod:'fixed_per_item'},'inactive'),aux=record(21,'finance-cost-auxiliary',{versionId:1,auxTypeId:20,costBucket:'production',amount:100}),assignment=record(22,'finance-cost-assignments',{versionId:1,skuSettingId:10,auxiliaryId:21,qty:1,mode:'add'});
    expect(run([setting(),type,aux,assignment]).warnings.join()).toMatch(/类型已停用/);
    assignment.status='inactive';expect(run([setting(),type,aux,assignment]).ready).toBe(true);
  });
  it('保存快照不因辅助规则修改而自动重算',()=>{
    const s=setting();s.data.productionCost=25;
    const adjustment=record(30,'finance-cost-overrides',{versionId:1,skuSettingId:10,costBucket:'production',amount:50,mode:'add'});
    expect(computeVersion(version,[s,adjustment],[seed],()=>300).rows[0].buckets.production).toBe(25);
    expect(recalculationPreview(version,[s,adjustment],[seed],()=>300).writes[0].data.productionCost).toBe(50);
  });
  it('预检签名随实际成本及配置变化，支持过期预检拒绝',()=>{
    const s=setting(),one=run([s]);s.data.purchaseCost=100;
    expect(run([s]).signature).not.toBe(one.signature);
  });
  it('重算应用人工调整后保存最终六科目，读取已保存成本不会重复分摊',()=>{
    const s=setting();s.data.purchaseCost=900;s.data.estimatedExpressCost=200;
    const adjustment=record(30,'finance-cost-overrides',{versionId:1,skuSettingId:10,costBucket:'production',amount:50,mode:'add'});
    const result=recalculationPreview(version,[s,adjustment],[seed],()=>300);
    expect(result.rows[0]).toMatchObject({previous:1100,proposed:1250.1234});
    const saved=record(10,'finance-cost-skus',result.writes[0].data);
    expect(computeVersion(version,[saved,adjustment],[seed],()=>300).rows[0].costIncludingFreightCents).toBe(1250.1234);
  });
  it('重量特殊调整保留到重算结果，并按调整后的重量估快递',()=>{
    const s=setting();s.data.estimatedWeightG=2000;s.data.weightManual=true;
    const result=recalculationPreview(version,[s],[seed],()=>300);
    const saved=record(10,'finance-cost-skus',result.writes[0].data),row=run([saved]).rows[0];
    expect(row.weightG).toBe(2000);expect(row.freightCents).toBe(300);
  });
});
