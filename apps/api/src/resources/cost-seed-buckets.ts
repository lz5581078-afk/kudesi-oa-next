import { multiplyUnitCents,sumUnitCents } from '@kudesi/shared';
import type { CostData } from './cost.service';
import type { ResourceRecord } from '../entities';

type Buckets=Record<string,number>;
export type VersionSeedData=CostData & {archiveCosts:ResourceRecord[];freightHistories:ResourceRecord[];laborVersions:ResourceRecord[]};
const empty=():Buckets=>({purchase:0,transfer:0,pre_ship_package:0,production:0,shipping_package:0,express:0});
const add=(target:Buckets,source:Buckets,qty=1,loss=0)=>{for(const key of Object.keys(target))target[key]=sumUnitCents([target[key],multiplyUnitCents(source[key],qty,loss)]);};
const valid=(data:Record<string,unknown>,day:string)=> (!data.effectiveFrom || String(data.effectiveFrom)<=day) && (!data.effectiveTo || String(data.effectiveTo)>=day);
const historyDay=(value:unknown)=>{const date=new Date(String(value));return Number.isFinite(date.getTime())?date.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}):String(value || '').slice(0,10);};

/** 以业务日期选择各科目最新有效档案成本；单位不一致只提醒，不擅自换算数量。 */
export function costSeedBuckets(d:VersionSeedData,baseId:number,day:string,warnings:string[]=[]):Buckets {
  const selected=d.baseCodes.get(baseId),base=selected?.data.canonicalId?d.baseCodes.get(Number(selected.data.canonicalId)):selected,out=empty();
  if(!base){warnings.push(`基础编码 #${baseId} 不存在`);return out;}
  const links=base.data.origin==='composed'?d.baseCodeLines.filter(l=>l.data.baseCodeId===base.id):[{data:{productId:base.data.productId,qty:1}}];
  if(!links.length)warnings.push(`${base.title} 没有关联商品组成，当前按 0 计算`);
  for(const link of links){
    const line:Record<string,unknown>=link.data;
    if(!valid(line,day) || (line.costTreatment && line.costTreatment!=='include'))continue;
    const id=Number(line.productId),product=d.products.get(id),amounts=empty();
    const active=d.archiveCosts.filter(r=>r.data.productId===id && r.status==='active' && valid(r.data,day)).sort((a,b)=>String(b.data.effectiveFrom).localeCompare(String(a.data.effectiveFrom)) || b.id-a.id);
    const picked=new Map<string,ResourceRecord>();for(const row of active)if(!picked.has(String(row.data.costType)))picked.set(String(row.data.costType),row);
    if(!picked.size)warnings.push(`档案「${product?.title || id}」在 ${day} 没有有效成本，缺少科目按 0 计算`);
    for(const [bucket,row] of picked){
      const target=typeof line.costBucket==='string' && line.costBucket in amounts?line.costBucket:bucket;
      if(target in amounts)amounts[target]=sumUnitCents([amounts[target],Number(row.data.unitCost || 0)]);
      if(line.unit && row.data.unitName && line.unit!==row.data.unitName)warnings.push(`档案「${product?.title || id}」组成单位与成本单位不同，按数量直接计算，请核对`);
    }
    // 新系统把调运费用保存在运费历史中；已有独立调运成本记录时以记录为准。
    if(!picked.has('transfer') && picked.get('purchase')?.data.sourceType!=='production_bom'){
      const history=d.freightHistories.filter(r=>r.data.productId===id && historyDay(r.data.recordedAtKey)<=day).sort((a,b)=>String(b.data.recordedAtKey).localeCompare(String(a.data.recordedAtKey)) || b.id-a.id)[0];
      if(history)amounts.transfer=sumUnitCents([Number(history.data.freight || 0),Number(history.data.handlingFee || 0)]);
    }
    add(out,amounts,Number(line.qty || 0),Number(line.lossRate || 0));
  }
  return out;
}

export function bundleSeedBuckets(d:VersionSeedData,bundleId:number,day:string,warnings:string[]=[]):Buckets {
  const out=empty();
  for(const line of d.lines.filter(l=>l.data.bundleId===bundleId)){
    const part=line.data;
    if(!valid(part,day) || (part.costTreatment && part.costTreatment!=='include'))continue;
    const amounts=empty();
    if(part.role==='labor')continue;
    else Object.assign(amounts,costSeedBuckets(d,Number(part.baseCodeId),day,warnings));
    add(out,amounts,Number(part.qty || 0),Number(part.lossRate || 0));
  }
  out.production=sumUnitCents([out.production,bundleLaborCost(d,bundleId,day,warnings)]);
  return out;
}

export function bundleLaborCost(d:VersionSeedData,bundleId:number,day:string,warnings:string[]=[],issues:string[]=[]):number {
  const amounts:number[]=[];
  for(const line of d.lines.filter(l=>l.data.bundleId===bundleId && l.data.role==='labor')){
    const data=line.data,item=d.labor.get(Number(data.laborId)),version=item && d.laborVersions.find(v=>v.id===item.data.versionId);
    if(!valid(data,day) || (data.costTreatment && data.costTreatment!=='include'))continue;
    if(!item || item.status!=='active' || !version || version.status!=='active' || !valid(version.data,day)) {issues.push('组合人工项目或其人力成本版本失效，请维护后重算');continue;}
    amounts.push(multiplyUnitCents(Number(item.data.unitPrice || 0),Number(data.qty || 0),Number(data.lossRate || 0)));
  }
  return sumUnitCents(amounts);
}
