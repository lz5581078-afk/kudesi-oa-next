import { ResourceRecord } from '../entities';
import { bundleLaborCost,costSeedBuckets,type VersionSeedData } from './cost-seed-buckets';

const r=(id:number,data:Record<string,unknown>,status='active')=>Object.assign(new ResourceRecord(),{id,title:`资料${id}`,data,status});
const source=():VersionSeedData=>({baseCodes:new Map([[1,r(1,{productId:2})]]),products:new Map([[2,r(2,{})]]),baseCodeLines:[],lines:[],labor:new Map(),laborVersions:[],archiveCosts:[],freightHistories:[]} as unknown as VersionSeedData);
describe('版本来源成本按业务日期取值',()=>{
  it('各科目选业务日期有效记录，未来价格和已停用价格不污染历史',()=>{
    const d=source();d.archiveCosts=[r(10,{productId:2,costType:'purchase',unitCost:100.1234,effectiveFrom:'2026-01-01',effectiveTo:'2026-06-30'}),r(11,{productId:2,costType:'purchase',unitCost:200,effectiveFrom:'2026-07-01'}),r(12,{productId:2,costType:'production',unitCost:30,effectiveFrom:'2026-01-01'}),r(13,{productId:2,costType:'purchase',unitCost:999,effectiveFrom:'2026-02-01'},'inactive')];
    expect(costSeedBuckets(d,1,'2026-03-01')).toMatchObject({purchase:100.1234,production:30});
    expect(costSeedBuckets(d,1,'2026-08-01').purchase).toBe(200);
    const warnings:string[]=[];expect(costSeedBuckets(d,1,'2025-01-01',warnings).purchase).toBe(0);expect(warnings.join()).toMatch(/没有有效成本/);
  });
  it('组成排除和单位不一致遵守旧规则，数量直接乘单价而不猜测换算',()=>{
    const d=source();d.baseCodes.set(1,r(1,{origin:'composed'}));d.baseCodeLines=[r(3,{baseCodeId:1,productId:2,qty:2,unit:'件',costTreatment:'include'}),r(4,{baseCodeId:1,productId:2,qty:100,costTreatment:'reference_only'})];
    d.archiveCosts=[r(10,{productId:2,costType:'purchase',unitCost:100,unitName:'千克',effectiveFrom:'2026-01-01'})];
    const warnings:string[]=[];expect(costSeedBuckets(d,1,'2026-03-01',warnings).purchase).toBe(200);expect(warnings.join()).toMatch(/数量直接计算/);
  });
  it('生产BOM汇总成本已含调运时不重复累加运费历史，独立调运科目优先',()=>{
    const d=source();d.archiveCosts=[r(10,{productId:2,costType:'purchase',unitCost:100,sourceType:'production_bom',effectiveFrom:'2026-01-01'})];d.freightHistories=[r(11,{productId:2,freight:20,handlingFee:5,recordedAtKey:'2026-01-01T00:00:00Z'}),r(12,{productId:2,freight:99,recordedAtKey:'2026-08-01T00:00:00Z'})];
    expect(costSeedBuckets(d,1,'2026-03-01').transfer).toBe(0);d.archiveCosts[0].data.sourceType='manual';expect(costSeedBuckets(d,1,'2026-03-01').transfer).toBe(25);
    d.archiveCosts.push(r(15,{productId:2,costType:'transfer',unitCost:10,effectiveFrom:'2026-01-01'}));expect(costSeedBuckets(d,1,'2026-03-01').transfer).toBe(10);
  });
  it('组合人工失效阻断重算；有效项目按数量和损耗汇总',()=>{
    const d=source();d.lines=[r(3,{bundleId:4,role:'labor',laborId:5,qty:2,lossRate:10})];d.labor.set(5,r(5,{versionId:6,unitPrice:100}));d.laborVersions=[r(6,{effectiveFrom:'2026-07-01'})];
    const issues:string[]=[];expect(bundleLaborCost(d,4,'2026-03-01',[],issues)).toBe(0);expect(issues.join()).toMatch(/失效/);
    expect(bundleLaborCost(d,4,'2026-08-01')).toBe(220);
  });
});
