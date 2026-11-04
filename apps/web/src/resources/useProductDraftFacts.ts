import { useEffect, useMemo, useState } from 'react';
import { sumUnitCentsProducts, LOGISTICS_CENT_SCALE, type UnitCentsProduct } from '@kudesi/shared';
import type { BomDraftRow } from './BomDraft';
import { resourceApi, type ResourceDto } from './api';

const finite = (value: unknown): number | null => value === '' || value == null || !Number.isFinite(Number(value)) ? null : Number(value);
/** 与服务端构成汇总同口径：组件总成本含自身运装费，损耗只计成本，人工不计重量。 */
export function calculateDraftFacts(rows: BomDraftRow[], records: Map<string, ResourceDto>, canCost: boolean,pricingMode:'self'|'oem'='self') {
  type Terms={values:UnitCentsProduct[];known:boolean};
  const terms=():Terms=>({values:[],known:true});
  const total=terms(),freight=terms(),handling=terms();
  const groups:Record<string,{weightG:number;cost:number|null;purchaseCost:number|null}>={};
  const grouped=new Map<string,{cost:Terms;purchase:Terms}>();
  let weightG=0,complete=true,weightKnown=true;
  const add=(into:Terms,value:number|null,quantity:number,lossPercent=0)=>{if(value===null)into.known=false;else into.values.push({value,quantity,lossPercent});};
  const amount=(set:Terms,outputScale=pricingMode==='oem'?4:LOGISTICS_CENT_SCALE):number|null=>{if(!set.known)return null;try{return sumUnitCentsProducts(set.values,6,LOGISTICS_CENT_SCALE,outputScale);}catch{complete=false;return null;}};
  for(const row of rows){
    if(!row.id&&!row.importedLabor){complete=false;continue;}
    const quantity=Number(row.qty),loss=Number(row.loss||0);
    if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(loss)){complete=false;weightKnown=false;total.known=false;continue;}
    const group=groups[row.group]??={weightG:0,cost:0,purchaseCost:0};
    if(!grouped.has(row.group))grouped.set(row.group,{cost:terms(),purchase:terms()});
    const parts=grouped.get(row.group)!;
    if(row.importedLabor){const price=canCost?row.importedLabor.unitCost:null;add(total,price,quantity);add(parts.cost,price,quantity);add(parts.purchase,price,quantity);continue;}
    const record=records.get(`${row.kind}:${row.id}`),weight=row.kind==='labor'?0:finite(record?.data.weightG);
    if(!record||weight===null){complete=false;weightKnown=false;}
    const price=canCost?finite(record?.data[row.kind==='labor'?'unitPrice':pricingMode==='oem'?'purchasePrice':'totalCost']):null;
    const purchase=canCost?finite(record?.data[row.kind==='labor'?'unitPrice':'purchasePrice']):null;
    const effectiveLoss=row.kind==='labor'?0:loss;
    add(total,price,quantity,effectiveLoss);add(parts.cost,price,quantity,effectiveLoss);add(parts.purchase,purchase,quantity,effectiveLoss);
    if(row.kind!=='labor'){add(freight,canCost?finite(record?.data.freight):null,quantity,loss);add(handling,canCost?finite(record?.data.handlingFee):null,quantity,loss);}
    const partWeight=quantity*(weight??0);weightG+=partWeight;group.weightG+=partWeight;
  }
  for(const [key,parts]of grouped){groups[key].cost=amount(parts.cost);groups[key].purchaseCost=amount(parts.purchase,4);}
  const cost=rows.length?amount(total):null,componentFreight=amount(freight,LOGISTICS_CENT_SCALE),componentHandling=amount(handling,LOGISTICS_CENT_SCALE);
  return {componentFreight,componentHandling,weightG:weightKnown&&rows.length?Math.round(weightG*1e6)/1e6:null,cost,groups,complete};
}

export function useProductDraftFacts(rows: BomDraftRow[], canCost: boolean,pricingMode:'self'|'oem'='self') {
  const [records, setRecords] = useState(new Map<string, ResourceDto>());
  const ids = [...new Set(rows.filter(r => r.id).map(r => `${r.kind}:${r.id}`))].sort().join(',');
  useEffect(() => { let alive = true;
    Promise.all(ids.split(',').filter(Boolean).map(async key => { const [kind, id] = key.split(':'); try { return [key, await resourceApi.get(kind === 'labor' ? 'finance-labor-costs' : 'finance-products', Number(id))] as const; } catch { return null; } })).then(results => { if (alive) setRecords(new Map(results.filter((r): r is NonNullable<typeof r> => r !== null))); });
    return () => { alive = false; };
  }, [ids]);
  return useMemo(() => ({...calculateDraftFacts(rows, records, canCost,pricingMode), records}), [rows, records, canCost,pricingMode]);
}
