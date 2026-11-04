import {ForbiddenException} from '@nestjs/common';
import {createChecker, LOGISTICS_CENT_SCALE, UNIT_CENT_SCALE, multiplyUnitCents, sumUnitCents, todayInChina} from '@kudesi/shared';
import {In,type EntityManager} from 'typeorm';
import {ResourceRecord} from '../entities';
import type {AuthUser} from '../common/auth.decorators';
import {CostService} from './cost.service';
import {calculateCostComponents} from './cost-components';
import {isWarehouseMode} from './warehouse-mode';

const text=(v:unknown)=>typeof v==='string'?v:'';
const amount=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
export interface BundleReferenceLine {
 id:number;role:string;name:string;code:string;spec:string;qty:number|null;unit:string;weightG:number|null;isRawFinishedName:boolean;
 cost?:number|null;costSubtotal?:number|null;costSource?:string;saleSubtotal?:number|null;
}
export interface BundleReferenceDetail {
 id:number;code:string;name:string;shortName:string;mainStyleCode:string;styleCode:string;platform:string;spec:string;
 costVersionName?:string;lines:BundleReferenceLine[];
}
/** Source detail reads the current BOM, not the pending revision. Persisted version costs never depend on live seed availability. */
export async function deriveBundleReferenceDetail(em:EntityManager,user:AuthUser,bundle:ResourceRecord,lines:ResourceRecord[]):Promise<BundleReferenceDetail>{
 const can=createChecker(user.permissions);
 if(bundle.companyId!==user.companyId||!can('resource.finance-bundles.view'))throw new ForbiddenException('没有权限查看组合编码');
 const warehouse=await isWarehouseMode(em,user),cost=can('product.cost.view')&&!warehouse,sale=can('product.price.view')&&!warehouse;
 const data=await new CostService(em.connection).load(user.companyId,em);
 const current=calculateCostComponents({...data,lines},bundle.id),currentById=new Map(lines.slice().sort((a,b)=>a.id-b.id).map((line,i)=>[line.id,current.lines[i]]));
 const extras=await em.find(ResourceRecord,{where:{companyId:user.companyId,type:In(['finance-platforms',...(cost?['finance-cost-versions','finance-cost-skus','finance-product-costs']:[]),...(sale?['finance-jst-skus']:[])])}});
 const versions=new Map(extras.filter(r=>r.type==='finance-cost-versions'&&r.status!=='deleted'&&!r.archivedAt).map(r=>[r.id,r]));
 const rank=(status:string)=>status==='active'?0:status==='draft'?1:2;
 const settings=extras.filter(r=>r.type==='finance-cost-skus'&&r.status==='active'&&!r.archivedAt);
 const context=settings.filter(r=>r.data.skuType==='bundle'&&r.data.bundleId===bundle.id&&versions.has(Number(r.data.versionId))).sort((a,b)=>{
  const av=versions.get(Number(a.data.versionId))!,bv=versions.get(Number(b.data.versionId))!;
  return rank(av.status)-rank(bv.status)||text(bv.data.effectiveFrom).localeCompare(text(av.data.effectiveFrom))||bv.id-av.id||b.id-a.id;
 })[0],version=context?versions.get(Number(context.data.versionId)):undefined;
 const snapshots=new Map<number,number>();
 if(version?.data.lockedAt)for(const row of settings.filter(r=>r.data.versionId===version.id&&r.data.skuType==='base_code').sort((a,b)=>a.id-b.id)){
  const snapshot=row.data.snapshot;
  if(snapshot&&typeof snapshot==='object'&&!Array.isArray(snapshot)&&(snapshot as Record<string,unknown>).skuType==='base_code'&&(snapshot as Record<string,unknown>).skuId===row.data.baseCodeId){
   const value=amount((snapshot as Record<string,unknown>).costIncludingFreightCents);
   if(value!==null)snapshots.set(Number(row.data.baseCodeId),value);
  }
 }
 const prices=new Map(extras.filter(r=>r.type==='finance-jst-skus'&&r.data.goodsType==='normal').map(r=>[text(r.data.skuId),amount(r.data.salePrice)]));
 const day=todayInChina(),archivePrices=new Map<number,number[]>();
 for(const row of extras.filter(r=>r.type==='finance-product-costs'&&r.status==='active'&&!r.archivedAt&&text(r.data.effectiveFrom)<=day&&(!r.data.effectiveTo||text(r.data.effectiveTo)>=day))){
  const value=amount(row.data.unitCost);if(value!==null){const id=Number(row.data.productId);archivePrices.set(id,[...(archivePrices.get(id)||[]),value]);}
 }
 return {id:bundle.id,code:text(bundle.data.code),name:text(bundle.data.name)||bundle.title,shortName:text(bundle.data.shortName),mainStyleCode:text(bundle.data.mainStyleCode),styleCode:text(bundle.data.styleCode),platform:extras.find(r=>r.type==='finance-platforms'&&r.id===bundle.data.platformId)?.title||'',spec:text(bundle.data.propertiesValue),...(cost?{costVersionName:version?.title||'当前基础编码成本'}:{}),lines:lines.slice().sort((a,b)=>Number(a.data.sortOrder||0)-Number(b.data.sortOrder||0)||a.id-b.id).map(line=>{
  const d=line.data,selected=data.baseCodes.get(Number(d.baseCodeId)),canonicalId=selected?.data.canonicalId,candidate=canonicalId==null?selected:typeof canonicalId==='number'?data.baseCodes.get(canonicalId):undefined,base=candidate?.data.canonicalId==null?candidate:undefined,product=data.products.get(Number(d.productId)),labor=data.labor.get(Number(d.laborId)),fact=currentById.get(line.id),qty=amount(d.qty),isLabor=d.role==='labor';
  const locked=base?snapshots.get(base.id):undefined;
  const archive=product?archivePrices.get(product.id):undefined;
  const archiveCost=archive?.length?sumUnitCents(archive,LOGISTICS_CENT_SCALE):null;
  const unitCost=isLabor?amount(labor?.data.unitPrice):product?archiveCost:locked??amount(base?.data.cost);
  const costSource=isLabor?'人力成本':product?(unitCost===null?'未找到当前档案成本':'商品档案成本'):locked!==undefined?'SKU成本快照':unitCost===null?'基础编码未维护有效成本':'基础编码当前成本';
  const price=d.role==='gift'?0:prices.get(text(base?.data.code))??null;
  return {id:line.id,role:text(d.role),name:text(selected?.data.name)||selected?.title||product?.title||labor?.title||'资料暂不可读',code:text(selected?.data.code)||text(product?.data.code)||text(labor?.data.workCode),spec:text(selected?.data.propertiesValue)||text(selected?.data.codeSpecLabel)||text(selected?.data.spec)||text(product?.data.systemSpec),qty,unit:fact?.unitName||text(d.unit),weightG:fact?.weightG??null,isRawFinishedName:!!selected?.data.canonicalId,
   ...(cost?{cost:unitCost,costSubtotal:unitCost===null||qty===null?null:multiplyUnitCents(unitCost,qty,0,6,LOGISTICS_CENT_SCALE,LOGISTICS_CENT_SCALE),costSource}:{}),
   ...(sale&&!isLabor?{saleSubtotal:price===null||qty===null?null:multiplyUnitCents(price,qty,0,6,UNIT_CENT_SCALE,LOGISTICS_CENT_SCALE)}:{})};
 })};
}
