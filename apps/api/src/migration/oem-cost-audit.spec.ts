export {};
const {auditOemCosts}=require('../../../../scripts/migration/audit-oem-costs.cjs');
const fixture=()=>({
 tables:{finance_products:[{id:'old',company_id:3,payload_json:{rawMaterialPurchasePrice:1.6,packagingCost:0.335,purchasePrice:1.935,totalCostPrice:2.004,purchasePriceHistory:[{recordedAt:'2026-08-29',rawMaterialPurchasePrice:1.6}]}}]},
 links:[{company_id:1,source_company_id:3,source_key:'finance-products:old',target_id:1}],
 rows:[{id:1,company_id:1,type:'finance-products',data:{code:'OEM',supplyMode:'supplier_oem',totalCost:40.4,migrationNotice:'不作为额外采购价重复加入'}},{id:2,company_id:1,type:'finance-base-codes',data:{productId:1}},{id:3,company_id:1,type:'finance-base-codes',data:{canonicalId:2}},{id:4,company_id:1,type:'finance-bundles',data:{}},{id:5,company_id:1,type:'finance-bundle-lines',data:{bundleId:4,baseCodeId:3}},{id:6,company_id:2,type:'finance-base-codes',data:{productId:1}}]
});
describe('OEM成本只读影响核查',()=>{
 it('追踪基础、马甲和组合，隔离公司，输入保持不变',()=>{const f=fixture(),before=JSON.stringify(f),r=auditOemCosts(f);expect(r.summary).toMatchObject({repairCandidates:1,affectedBases:2,affectedBundles:1});expect(r.patches[0].purchasePrice).toBe(160);expect(r.dependents.map((d:any)=>d.id)).toEqual([2,3,4]);expect(JSON.stringify(f)).toBe(before);});
 it('人工现值、缺采购历史和跨来源公司拒绝修复',()=>{const f=fixture();(f.rows[0].data as any).purchasePrice=170;expect(auditOemCosts(f).summary).toMatchObject({repairCandidates:0,conflicts:1});delete (f.rows[0].data as any).purchasePrice;f.tables.finance_products[0].payload_json.purchasePriceHistory=[];expect(auditOemCosts(f).conflicts[0].reason).toContain('历史');f.links[0].source_company_id=4;expect(auditOemCosts(f).conflicts[0].reason).toContain('缺少原始来源');});
});
