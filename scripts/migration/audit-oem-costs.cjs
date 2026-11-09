'use strict';
// Offline, read-only analysis of scoped source evidence and target records.
const { yuanToPreciseCents } = require('@kudesi/shared');
const { oemRawPurchase } = require('./sku-mapping.cjs');
function auditOemCosts({tables,rows,links}) {
  const parse=v=>typeof v==='string'?JSON.parse(v):v||{};
  const live=rows.filter(r=>!r.archived_at).map(r=>({...r,data:parse(r.data)}));
  const products=live.filter(r=>r.type==='finance-products');
  const patches=[],conflicts=[],missingInputs=[],rebased=[];
  for(const p of products){
    if(p.data.totalCost==null || (p.data.supplyMode==='supplier_oem' && p.data.purchasePrice==null)) missingInputs.push({id:p.id,companyId:p.company_id,code:p.data.code,type:p.data.archiveType});
    if(p.data.supplyMode!=='supplier_oem')continue;
    const link=links.find(l=>l.company_id===p.company_id&&Number(l.target_id)===p.id&&l.source_key.startsWith('finance-products:'));
    const source=link&&(tables.finance_products||[]).find(s=>String(s.id)===link.source_key.slice('finance-products:'.length) && (link.source_company_id==null || Number(s.company_id)===Number(link.source_company_id)));
    const common={id:p.id,companyId:p.company_id,code:p.data.code};
    if(!source){conflicts.push({...common,reason:'缺少原始来源'});continue;}
    const payload=parse(source.payload_json);
    try {
      const raw=oemRawPurchase(payload);
      if(raw===undefined)throw Error('缺少明确原料采购价');
      const expected=yuanToPreciseCents(raw);
      if(p.data.purchasePrice===expected)continue;
      if(p.data.purchasePrice!=null || !String(p.data.migrationNotice||'').includes('不作为额外采购价重复加入'))throw Error('不符合已知迁移漏项，禁止覆盖现值');
      const history=(payload.purchasePriceHistory||[]).slice().sort((a,b)=>String(b.recordedAt).localeCompare(String(a.recordedAt)))[0];
      if(!history || history.rawMaterialPurchasePrice==null || yuanToPreciseCents(history.rawMaterialPurchasePrice)!==expected)throw Error('当前原料价与最新采购历史缺失或不一致');
      patches.push({...common,beforePurchasePrice:p.data.purchasePrice??null,purchasePrice:expected,currentTotal:p.data.totalCost,sourceTotal:payload.totalCostPrice,sourceRaw:raw,sourcePackaging:payload.packagingCost,sourceHistoryAt:history.recordedAt});
    } catch(e){conflicts.push({...common,reason:e.message});}
  }
  const key=r=>`${r.company_id}:${r.id}`, affected=new Set(patches.map(p=>`${p.companyId}:${p.id}`));
  const lines=live.filter(r=>['finance-product-boms','finance-base-code-lines','finance-bundle-lines'].includes(r.type));
  let changed=true;
  while(changed){changed=false;for(const r of live){const d=r.data;
    const refs=r.type==='finance-products'?lines.filter(l=>l.type==='finance-product-boms'&&l.company_id===r.company_id&&l.data.productId===r.id).map(l=>l.data.componentId):r.type==='finance-base-codes'?[d.productId,d.canonicalId,...lines.filter(l=>l.type==='finance-base-code-lines'&&l.company_id===r.company_id&&l.data.baseCodeId===r.id).map(l=>l.data.productId)]:r.type==='finance-bundles'?lines.filter(l=>l.type==='finance-bundle-lines'&&l.company_id===r.company_id&&l.data.bundleId===r.id).flatMap(l=>[l.data.baseCodeId,l.data.productId,l.data.childBundleId]):[];
    if(!affected.has(key(r))&&refs.some(id=>id!=null&&affected.has(`${r.company_id}:${id}`))){affected.add(key(r));changed=true;}
  }}
  for(const r of live){const change=r.data._legacyCostChange;if(change&&change.fromCents!==change.toCents)rebased.push({id:r.id,companyId:r.company_id,type:r.type,code:r.data.code,...change});}
  const dependents=live.filter(r=>affected.has(key(r))&&!patches.some(p=>p.id===r.id&&p.companyId===r.company_id)).map(r=>({id:r.id,companyId:r.company_id,type:r.type,code:r.data.code,status:r.status}));
  return {summary:{products:products.length,oems:products.filter(r=>r.data.supplyMode==='supplier_oem').length,repairCandidates:patches.length,conflicts:conflicts.length,affectedBases:dependents.filter(r=>r.type==='finance-base-codes').length,affectedBundles:dependents.filter(r=>r.type==='finance-bundles').length,missingInputs:missingInputs.length,rebased:rebased.length},patches,conflicts,dependents,missingInputs,rebased};
}
module.exports={auditOemCosts};
if(require.main===module){const fs=require('node:fs');const input=process.argv[2];if(!input)throw Error('用法：node audit-oem-costs.cjs <只读快照.json>');process.stdout.write(JSON.stringify(auditOemCosts(JSON.parse(fs.readFileSync(input,'utf8'))),null,2)+'\n');}
