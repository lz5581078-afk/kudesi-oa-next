import { createHash } from 'crypto';
import { In, type EntityManager } from 'typeorm';
import { multiplyUnitCents, sumUnitCents, unitCentsTicks, scaledDecimal, todayInChina } from '@kudesi/shared';
import { ResourceRecord } from '../entities';
import type { CostRow } from './cost.service';
import { costVersionActivationPlan } from './cost-version-dates';
import { ConflictException, NotFoundException } from '@nestjs/common';

export const COST_VERSION_TYPES = ['finance-cost-versions','finance-cost-skus','finance-cost-aux-types','finance-cost-auxiliary','finance-cost-assignments','finance-cost-overrides','finance-cost-production-rates'];
export const COST_GLOBAL_TYPES = ['finance-cost-aux-types','finance-cost-production-rates'];
export const COST_BUCKET_FIELDS = { purchase:'purchaseCost', transfer:'transferCost', pre_ship_package:'preShipPackageCost', production:'productionCost', shipping_package:'shippingPackageCost', express:'estimatedExpressCost' } as const;
export type VersionCostRow = CostRow & { settingId: number; skuType: string; skuId: number; buckets: Record<string, number | null>; markupPercent: number; costVersionId: number; costVersionName: string; warnings: string[] };
export interface CostSeed { skuType: string; skuId: number; row: CostRow; productIds: number[]; categoryIds: number[]; buckets?: Record<string,number | null>; warnings?:string[];issues?:string[];components?:Array<{baseId:number;qty:number;lossRate:number;include:boolean;effectiveFrom:string;effectiveTo:string}>;laborCostCents?:number }
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const validDay = (data: Record<string, unknown>, day: string) => (!data.effectiveFrom || String(data.effectiveFrom) <= day) && (!data.effectiveTo || String(data.effectiveTo) >= day);
export const versionSignature = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 以分的万分位相乘，最后向上结算到分；旧版加价率与利润率分别保留语义。 */
export function markedUpPrice(totalCents: number, markupPercent: number): number {
  const numerator = unitCentsTicks(totalCents) * (100_000_000n + scaledDecimal(markupPercent, 6));
  const denominator = 1_000_000_000_000n;
  return Number((numerator + denominator - 1n) / denominator);
}

export function describeCostVersion(version:ResourceRecord,records:ResourceRecord[],seeds:CostSeed[],freight:(weightG:number)=>number | null) {
  const computed=computeVersion(version,records,seeds,freight),locked=!!version.data.lockedAt;
  const stored=records.filter(r=>r.type==='finance-cost-skus' && r.data.versionId===version.id && r.status==='active');
  const rows=locked?stored.flatMap(r=>r.data.snapshot?[r.data.snapshot as unknown as VersionCostRow]:[]):computed.rows;
  const signature=locked?versionSignature([version.id,version.data.versionCode,version.data.defaultMarkupPercent,stored.map(r=>[r.id,r.data.snapshot])]):computed.signature;
  const plan=costVersionActivationPlan(version,records);
  const issues=[...(!rows.length?['版本至少需要一条SKU成本才能启用']:[]),...(locked?[]:computed.issues),...plan.issues];
  return {...computed,rows,signature,locked,issues,ready:rows.length>0 && !issues.length,transition:plan.transition,activationSignature:versionSignature([signature,plan.fingerprint])};
}

/** 克保留六位，按公斤计价后舍入到万分之一分，不先把公斤重量截成四位。 */
export function perKgCost(cents: number, weightG: number): number {
  const ticks = unitCentsTicks(cents) * scaledDecimal(weightG,6);
  return Number((ticks + 500_000_000n) / 1_000_000_000n) / 10_000;
}

export async function loadVersionRecords(em: EntityManager, companyId: number, lock=false) {
  // 写操作在公司锁之后使用当前读，避免 REPEATABLE READ 仍读到等待锁之前的草稿。
  return em.find(ResourceRecord, { where: { companyId, type: In(COST_VERSION_TYPES) }, order: { id:'ASC' },...(lock?{lock:{mode:'pessimistic_write' as const}}:{}) });
}

export function computeVersion(version: ResourceRecord, records: ResourceRecord[], seeds: CostSeed[], freight: (weightG: number) => number | null, applyRules=false) {
  const day=String(version.data.effectiveFrom || todayInChina());
  const by=(type:string)=>records.filter(r=>r.type===type && (COST_GLOBAL_TYPES.includes(type) || r.data.versionId===version.id) && r.status==='active');
  const settings=by('finance-cost-skus').sort((a,b)=>Number(a.data.skuType!=='base_code')-Number(b.data.skuType!=='base_code') || a.id-b.id);
  const auxiliary=by('finance-cost-auxiliary'),types=by('finance-cost-aux-types');
  const assignments=by('finance-cost-assignments').filter(r=>validDay(r.data,day)).sort((a,b)=>(num(a.data.priority) ?? 100)-(num(b.data.priority) ?? 100) || a.id-b.id);
  const overrides=by('finance-cost-overrides').filter(r=>validDay(r.data,day));
  const standards=by('finance-cost-production-rates').filter(r=>validDay(r.data,day)).sort((a,b)=>(num(a.data.priority) ?? 100)-(num(b.data.priority) ?? 100) || a.id-b.id);
  const baseRows=new Map<number,VersionCostRow>();
  const rows:VersionCostRow[]=settings.map(setting=>{
    const skuType=String(setting.data.skuType),skuId=Number(setting.data[skuType==='base_code'?'baseCodeId':'bundleId']);
    const seed=seeds.find(s=>s.skuType===skuType && s.skuId===skuId),source=seed?.row;
    const warnings=[...(seed?.warnings ?? [])],issues:string[]=[...(seed?.issues ?? [])];
    if(!source)warnings.push('来源SKU已停用或不存在，历史成本保留');
    const weightG=num(setting.data.estimatedWeightG) ?? source?.weightG ?? 0;
    const buckets:Record<string,number | null>={purchase:source?.preShipCostCents ?? 0,transfer:0,pre_ship_package:0,production:0,shipping_package:0,express:0};
    if(seed?.buckets)for(const key of Object.keys(buckets))buckets[key]=seed.buckets[key] ?? 0;
    if(applyRules && skuType==='bundle' && seed?.components){
      for(const key of Object.keys(buckets))buckets[key]=0;
      for(const component of seed.components){
        if(!component.include || (component.effectiveFrom && component.effectiveFrom>day) || (component.effectiveTo && component.effectiveTo<day))continue;
        const base=baseRows.get(component.baseId);
        if(!base){warnings.push(`缺少组成基础编码 #${component.baseId} 的候选成本，当前按 0 计算`);continue;}
        for(const key of Object.keys(buckets))buckets[key]=sumUnitCents([buckets[key] ?? 0,multiplyUnitCents(base.buckets[key] ?? 0,component.qty,component.lossRate)]);
      }
      buckets.production=sumUnitCents([buckets.production ?? 0,seed.laborCostCents ?? 0]);
    }
    if(skuType==='bundle'){
      const express=source && weightG===source.weightG?source.freightCents:weightG>0?freight(weightG):null;
      buckets.express=sumUnitCents([buckets.express ?? 0,express ?? 0]);
      if(express===null)warnings.push('没有匹配的快递预估，快递成本暂按 0 计算');
    }
    for(const [bucket,field]of Object.entries(COST_BUCKET_FIELDS))if(num(setting.data[field])!==null)buckets[bucket]=num(setting.data[field]);
    const apply=(bucket:string,amount:number,mode:unknown)=>{
      if(!(bucket in buckets)){issues.push('成本科目不合法');return;}
      if(mode==='replace')buckets[bucket]=amount;
      else if(mode==='fallback'){if(!buckets[bucket])buckets[bucket]=amount;}
      else buckets[bucket]=sumUnitCents([buckets[bucket] ?? 0,amount]);
    };
    if(applyRules){
      for(const assignment of assignments.filter(r=>r.data.skuSettingId===setting.id)){
        const item=auxiliary.find(r=>r.id===assignment.data.auxiliaryId),kind=item && types.find(r=>r.id===item.data.auxTypeId);
        if(!item || !kind){warnings.push('分摊引用的辅助成本或类型已停用');continue;}
        apply(String(item.data.costBucket),multiplyUnitCents(Number(assignment.data.unitAmount ?? item.data.amount ?? 0),Number(assignment.data.qty || 0)),assignment.data.mode);
      }
      const standard=standards.find(r=>{
        const d=r.data;
        if(d.warehouseName && d.warehouseName!==setting.data.warehouseName)return false;
        if(num(d.minWeightG)!==null && weightG<Number(d.minWeightG))return false;
        if(num(d.maxWeightG)!==null && weightG>Number(d.maxWeightG))return false;
        return d.targetType==='general' || (d.targetType==='base_code' && skuType==='base_code' && d.baseCodeId===skuId) || (d.targetType==='product' && seed?.productIds.includes(Number(d.productId))) || (d.targetType==='category' && seed?.categoryIds.includes(Number(d.categoryId)));
      });
      if(standard){const d=standard.data,fixed=Number(d.fixedAmount || 0),unit=Number(d.unitAmount || 0);const amount=d.calculationMethod==='per_kg'?perKgCost(unit,weightG):d.calculationMethod==='fixed_plus_kg'?sumUnitCents([fixed,perKgCost(unit,weightG)]):fixed || unit;apply('production',amount,'add');}
      for(const override of overrides.filter(r=>r.data.skuSettingId===setting.id))apply(String(override.data.costBucket),Number(override.data.amount || 0),override.data.mode);
    }
    const pre=sumUnitCents(['purchase','transfer','pre_ship_package','production','shipping_package'].map(k=>buckets[k] ?? 0)),total=sumUnitCents(Object.values(buckets).map(v=>v ?? 0));
    const markup=num(setting.data.markupPercent) ?? Number(version.data.defaultMarkupPercent),minimum=markedUpPrice(total,markup);
    if(total===0)warnings.push('总成本为 0，请确认实际情况');
    if(weightG===0)warnings.push('预计重量为 0，请确认实际情况');
    if(buckets.express===0)warnings.push('预计快递成本为 0，请确认实际情况');
    const row={...(source ?? {bundleId:skuId,code:String(setting.data.skuCode || ''),name:String(setting.data.skuName || ''),status:'pending',categoryId:null,categoryName:'',carrierName:'',lines:[],updatedAtMs:0}),bundleId:skuId,settingId:setting.id,skuType,skuId,buckets,costVersionId:version.id,costVersionName:version.title,markupPercent:markup,preShipCostCents:pre,weightG,freightCents:buckets.express,freightMethod:'版本成本',costIncludingFreightCents:total,minPriceCents:minimum,marginPercent:total && minimum?Number(((minimum-total)/minimum*100).toFixed(6)):0,marginSource:'版本加价率',marginOverride:false,inheritedMargin:{percent:null,source:'版本加价率'},revision:versionSignature([version.id,setting.id,buckets,markup]),issues,warnings:[...new Set(warnings)]} as VersionCostRow;
    if(skuType==='base_code')baseRows.set(skuId,row);
    return row;
  });
  const signature=versionSignature([version.id,version.data.versionName,version.data.defaultMarkupPercent,version.data.effectiveFrom,version.data.effectiveTo,records.filter(r=>COST_GLOBAL_TYPES.includes(r.type) || r.data.versionId===version.id).map(r=>[r.id,r.status,r.data]),rows]);
  return {rows,signature,issues:rows.flatMap(r=>r.issues.map(issue=>`${r.code || r.skuId}：${issue}`)),warnings:rows.flatMap(r=>r.warnings.map(warning=>`${r.code || r.skuId}：${warning}`)),ready:rows.length>0 && rows.every(r=>!r.issues.length)};
}

/** 从现行来源推导候选基础成本；分摊和人工调整在候选基础值之后重新应用。 */
export function recalculationPreview(version: ResourceRecord, records: ResourceRecord[], seeds: CostSeed[], freight: (weightG:number)=>number | null) {
  const existing=records.filter(r=>r.type==='finance-cost-skus' && r.data.versionId===version.id);
  const candidates=seeds.flatMap((seed,index)=>{
    const old=existing.find(r=>r.data.skuType===seed.skuType && r.data[seed.skuType==='base_code'?'baseCodeId':'bundleId']===seed.skuId);
    if(old && old.status!=='active')return [];
    const data:Record<string,unknown>={...(old?.data ?? {}),versionId:version.id,skuType:seed.skuType,[seed.skuType==='base_code'?'baseCodeId':'bundleId']:seed.skuId,skuName:seed.row.name,skuCode:seed.row.code,estimatedWeightG:old?.data.weightManual===true?old.data.estimatedWeightG:seed.row.weightG ?? 0};
    for(const field of Object.values(COST_BUCKET_FIELDS))delete data[field];
    delete data.snapshot;
    return [Object.assign(new ResourceRecord(),{...(old ?? {}),id:old?.id ?? -(index+1),type:'finance-cost-skus',companyId:version.companyId,status:'active',title:seed.row.name,data})];
  });
  const globalsAndAdjustments=records.filter(r=>r.type!=='finance-cost-skus');
  const proposed=computeVersion(version,[...globalsAndAdjustments,...candidates],seeds,freight,true);
  const previous=computeVersion(version,records,seeds,freight);
  const rows=proposed.rows.map(row=>({skuType:row.skuType,skuId:row.skuId,code:row.code,name:row.name,settingId:row.settingId>0?row.settingId:null,previous:previous.rows.find(p=>p.settingId===row.settingId)?.costIncludingFreightCents ?? null,proposed:row.costIncludingFreightCents,issues:row.issues}));
  const writes=candidates.map(candidate=>{const row=proposed.rows.find(r=>r.settingId===candidate.id)!;return {id:candidate.id>0?candidate.id:null,data:{...candidate.data,...Object.fromEntries(Object.entries(COST_BUCKET_FIELDS).map(([bucket,field])=>[field,row.buckets[bucket]]))}};});
  const signature=versionSignature([version.id,version.status,version.data,records.filter(r=>COST_GLOBAL_TYPES.includes(r.type) || r.data.versionId===version.id).map(r=>[r.id,r.status,r.data]),writes,rows]);
  const unavailable=existing.filter(r=>r.status==='active' && !candidates.some(c=>c.id===r.id)).map(r=>`${String(r.data.skuCode || r.id)}：来源SKU不存在、已停用或尚未验证`);
  return {rows,writes,signature,ready:proposed.ready,issues:proposed.issues,warnings:[...proposed.warnings,...unavailable],businessDate:String(version.data.effectiveFrom || todayInChina()),changed:rows.filter(r=>r.previous!==r.proposed).length};
}

export async function costVersionAtDate(em: EntityManager, companyId: number, day: string) {
  const records = await loadVersionRecords(em,companyId);
  const versions = records.filter(r => r.type === 'finance-cost-versions');
  const valid = versions.filter(v => v.status === 'active' && v.data.lockedAt && validDay(v.data,day));
  if(valid.length>1)throw new ConflictException('业务日期匹配到多个成本版本，请先处理生效日期冲突');
  const version = valid[0];
  if (!version) throw new NotFoundException(`${day}没有可用的成本版本`);
  const rows=records.filter(r => r.type === 'finance-cost-skus' && r.data.versionId === version.id && r.status === 'active').flatMap(r => r.data.snapshot ? [r.data.snapshot as unknown as VersionCostRow] : []);
  return {day,version:{id:version.id,name:version.title,effectiveFrom:version.data.effectiveFrom,effectiveTo:version.data.effectiveTo ?? null},rows};
}
