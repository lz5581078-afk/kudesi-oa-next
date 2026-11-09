import {skuLaborIsCurrent} from './sku-catalog';
import {In,type EntityManager} from 'typeorm';
import {createChecker,type SkuSpec,type WarehouseSpec} from '@kudesi/shared';
import {codeEnabledState} from '../resources/finance-code-lifecycle';
import {FlowEvent,FlowRun,FlowStep,ResourceRecord} from '../entities';
import type {AuthUser} from '../common/auth.decorators';
/** Read submitted warehouse steps; never relabel a changed request as historical input. */
export async function skuReuseLibrary(em:EntityManager,user:AuthUser,keyword:string,sourceRef?:string){
 let records:ResourceRecord[]|undefined;
 const rows: Awaited<ReturnType<typeof skuReusePage>>['rows'] = [];
 const references = new Map<number, Awaited<ReturnType<typeof skuReusePage>>['references'][number]>();
 // Search the whole history in bounded batches; the result limit applies after matching.
 for(let skip=0;;skip+=100){
  const steps=await em.find(FlowStep,{where:{companyId:user.companyId,stepKey:'warehouse',status:'done',action:'pass',...(sourceRef?{id:Number(sourceRef.split(':')[0])}:{})},order:{finishedAt:'DESC',id:'DESC'},skip,take:100});
  if(!steps.length)break;
  records??=await em.find(ResourceRecord,{where:{companyId:user.companyId,type:In(['finance-base-codes','finance-labor-costs','finance-labor-units','finance-labor-versions','finance-bundles'])}});
  const page=await skuReusePage(em,user,keyword,steps,records,sourceRef);
  rows.push(...page.rows);for(const ref of page.references)references.set(ref.id,ref);
  if(sourceRef||rows.length>=100||steps.length<100)break;
 }
 const selected=rows.slice(0,100),used=new Set(selected.flatMap(row=>[...row.main.map(line=>line.baseCodeId),...row.config.lines.map(line=>(line.role==='labor'?line.laborId:line.baseCodeId)!)]));
 return {rows:selected,references:[...references.values()].filter(ref=>used.has(ref.id))};
}
async function skuReusePage(em:EntityManager,user:AuthUser,keyword:string,steps:FlowStep[],records:ResourceRecord[],sourceRef?:string){
 const runIds=[...new Set(steps.map(step=>step.runId))];
 if(!runIds.length)return {rows:[],references:[]};
 const runs=await em.find(FlowRun,{where:{companyId:user.companyId,id:In(runIds),templateKey:'sku-batch-apply'}}),allSteps=await em.find(FlowStep,{where:{companyId:user.companyId,runId:In(runIds)}}),events=await em.find(FlowEvent,{where:{companyId:user.companyId,runId:In(runIds),action:In(['pass','resubmit','draft_save'])}});
 const byId=new Map(records.map(record=>[record.id,record]));
 const names=new Map<number,string>();for(const step of steps)if(step.handledBy&&!names.has(step.handledBy)){const rows=await em.query('SELECT name FROM users WHERE company_id=? AND id=?',[user.companyId,step.handledBy]);names.set(step.handledBy,String(rows[0]?.name??''));}
 const rows=[];const referenceIds=new Set<number>();
 for(const step of steps){const run=runs.find(run=>run.id===step.runId);if(!run)continue;
  if((run.payload._created as Array<{bundleId:number}>|undefined)?.some(row=>byId.get(row.bundleId)?.archivedAt))continue;
  const saved=step.form?._skuSource as {specs:SkuSpec[]}|undefined;
  const passEvent=events.find(event=>event.stepId===step.id&&event.action==='pass');
  const changed=events.some(event=>event.runId===run.id&&event.id>(passEvent?.id??0)&&(event.action==='resubmit'||event.action==='draft_save'&&(event.stepId===null||allSteps.some(item=>item.id===event.stepId&&item.stepType==='submit'))));
  if(!saved&&(!passEvent||changed||run.currentStepKey==='apply'))continue;
  const specs=saved?.specs??run.payload.specs as SkuSpec[]|undefined,config=step.form?.config as WarehouseSpec[]|undefined;if(!specs||!Array.isArray(config))continue;
  for(const [index,spec] of specs.entries()){if(sourceRef&&sourceRef!==step.id+':'+index)continue;if(!config[index]||!spec.main?.length)continue;const main=spec.main.map(line=>{const record=byId.get(line.baseCodeId);referenceIds.add(line.baseCodeId);return {...line,name:String(record?.data.name??record?.title??`商品 #${line.baseCodeId}`),code:String(record?.data.code??record?.title??''),weightG:typeof record?.data.weightG==='number'?record.data.weightG:null};});
   if(keyword&&!main.some(line=>`${line.name} ${line.code}`.toLowerCase().includes(keyword.toLowerCase())))continue;
   for(const line of config[index].lines)referenceIds.add(line.role==='labor'?line.laborId!:line.baseCodeId!);
   const mainWeightG=main.every(line=>line.weightG!==null&&line.weightG>0)?Math.round(main.reduce((sum,line)=>sum+line.weightG!*line.qty,0)*1e6)/1e6:null;
   rows.push({id:`${step.id}:${index}`,runId:run.id,name:spec.name,configuredAt:step.finishedAt,configuredBy:names.get(step.handledBy!)??'',main,mainWeightG,config:config[index],note:typeof step.form?.note==='string'?step.form.note:''});
  }
 }
 const references=[...referenceIds].map(id=>{const record=byId.get(id),labor=record?.type==='finance-labor-costs',unit=labor&&typeof record.data.unitId==='number'?byId.get(record.data.unitId):null;return {id,kind:labor?'labor':'base',name:String(labor?record?.data.workName??record?.title:record?.data.name??record?.title??`项目 #${id}`),code:String(labor?record?.data.workCode??'':record?.data.code??record?.title??''),spec:String(labor?unit?.title??record?.data.unitName??'':record?.data.spec??''),...(createChecker(user.permissions)('product.cost.view')?{costCents:typeof record?.data[labor?'unitPrice':'cost']==='number'?record.data[labor?'unitPrice':'cost']:null}:{}),available:!!record&&!record.archivedAt&&(labor?skuLaborIsCurrent(record,byId.get(Number(record.data.versionId))):record.type==='finance-base-codes'&&codeEnabledState(record)==='active'&&record.status==='verified')};});
 return {rows,references};
}
