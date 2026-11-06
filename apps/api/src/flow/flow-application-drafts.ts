import type {FlowConfirmation} from './flow-confirmation.dto';
import {BadRequestException,ConflictException,ForbiddenException,HttpException,NotFoundException} from '@nestjs/common';
import {deleteApplicationRecords} from './flow-application-delete';
import {DataSource,EntityManager,In} from 'typeorm';
import {createHash} from 'crypto';
import {createChecker,readOnlyFieldKeys,restrictedFieldKeys,validateResourceInput,validateSteps,type FlowTemplate,type StepDef} from '@kudesi/shared';
import {Company,FlowDefinition,FlowRun,FlowStep,FlowEvent,WorkItem,AuditLog,FormDraft} from '../entities';
import {FlowApplicationHeaderStore,type ApplicationHeader} from './flow-application-header';
import type {AuthUser} from '../common/auth.decorators';
import {adapterFor} from './flow-templates';
import type {FlowServices} from './flow-adapters';
export interface ApplicationDraftHost {
 template(em:EntityManager,companyId:number,key:string,definitionId?:number):Promise<FlowTemplate>;
 starterAllowed(em:EntityManager,user:AuthUser,scope:Record<string,unknown>|null):Promise<boolean>;
 services:FlowServices;
 event(em:EntityManager,run:FlowRun,userId:number,action:string,stepId:number|null,note?:string):Promise<unknown>;
 activate(em:EntityManager,user:AuthUser,run:FlowRun,steps:StepDef[],first:FlowStep,comment?:string):Promise<void>;
 detail(em:EntityManager,user:AuthUser,id:number):Promise<unknown>;
 visible(em:EntityManager,user:AuthUser,run:FlowRun):Promise<boolean>;
 handlers(em:EntityManager,user:AuthUser,step:StepDef):Promise<string[]>;
}
export interface DraftCreateInput {templateKey:string;definitionId:number;requestKey:string;confirmations?:Record<string,boolean>;payloads:Record<string,unknown>[]}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):value;
const signature=(value:unknown)=>createHash('sha256').update((JSON.stringify(canonical(value)) ?? 'undefined')).digest('hex');
const requestKey=(value:string)=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{12,60}$/.test(value))throw new BadRequestException('requestKey要12到60位字母数字');};
const needApply=(user:AuthUser)=>{if(!createChecker(user.permissions)('flow.apply.view'))throw new ForbiddenException('没有发起流程的权限');};
const batchRef=(value:unknown)=>typeof value==='string'&&/^B[0-9a-z]{1,19}$/.test(value)?value:null;
/** 已有流程引擎的可选草稿阶段；只声明持久化和校验，流转仍调用同一入场内核。 */
export class FlowApplicationDrafts {
 constructor(private readonly ds:DataSource,private readonly host:ApplicationDraftHost,private readonly headers?:FlowApplicationHeaderStore){}
 private headerStore(){if(!this.headers)throw new BadRequestException('申请索引服务未就绪');return this.headers;}
 private async ownHeader(em:EntityManager,user:AuthUser,key:string,ref:string){const header=await this.headerStore().read(em,user,key,ref,true);if(header.row.userId!==user.id)throw new ForbiddenException('只能修改本人的申请');return header;}
 private async definition(em:EntityManager,user:AuthUser,key:string,id:number){
  const definition=await em.findOneBy(FlowDefinition,{companyId:user.companyId,templateKey:key,id});if(!definition)throw new NotFoundException('申请流程定义不存在');
  const template=await this.host.template(em,user.companyId,key,id);
  if(!template.applicationDraft||!adapterFor(template).validateDraft)throw new BadRequestException('此流程未启用申请草稿');
  return {definition,template};
 }
 private async draftPayload(em:EntityManager,user:AuthUser,template:FlowTemplate,input:Record<string,unknown>,run?:FlowRun){
  const hidden=restrictedFieldKeys({fields:template.fields} as never,createChecker(user.permissions));
  const blocked=readOnlyFieldKeys({fields:template.fields} as never,createChecker(user.permissions));
  for(const key of Object.keys(input))if(blocked.has(key))throw new ForbiddenException('没有修改申请字段的权限');
  const fields=template.fields.filter(field=>!hidden.has(field.key)).map(field=>({...field,required:false}));
  const checked=validateResourceInput({key:`flow:${template.key}`,label:template.label,titleField:fields[0]?.key??'id',fields,statuses:[],defaultStatus:''},input,{status:''});
  if(checked.errors.length)throw new BadRequestException(checked.errors.join('；'));
  const payload=Object.fromEntries(Object.entries(checked.values).filter(([,value])=>value!==undefined&&value!==null));
  await adapterFor(template).validateDraft!({em,user,payload,run,...this.host.services});return payload;
 }
 private async sharedPayload(em:EntityManager,user:AuthUser,template:FlowTemplate,values:Record<string,unknown>){
  const can=createChecker(user.permissions),policy=template.applicationDraft!,definition={fields:template.fields} as never;
  const blocked=readOnlyFieldKeys(definition,can);for(const key of Object.keys(values))if(blocked.has(key))throw new ForbiddenException('没有修改公共设置字段的权限');
  const checked=validateResourceInput({key:`flow:${template.key}`,label:template.label,titleField:policy.titleField,statuses:[],defaultStatus:'',fields:template.fields.filter(field=>policy.sharedFields.includes(field.key)).map(field=>({...field,required:false}))},values,{status:''});
  if(checked.errors.length)throw new BadRequestException(checked.errors.join('；'));
  const payload=Object.fromEntries(Object.entries(checked.values).filter(([,value])=>value!==undefined&&value!==null));await adapterFor(template).validateDraftShared?.({em,user,payload,...this.host.services});return payload;
 }
 private async members(em:EntityManager,user:AuthUser,key:string,ref:string,allowEmpty=false){
  if(!batchRef(ref))throw new BadRequestException('申请单编号不合法');
  const rows=await em.createQueryBuilder(FlowRun,'r').where('r.companyId=:company AND r.templateKey=:key AND JSON_UNQUOTE(JSON_EXTRACT(r.payload,:path))=:ref',{company:user.companyId,key,path:'$._batchKey',ref}).orderBy('r.id','ASC').setLock('pessimistic_write').getMany();
  if(!rows.length&&!allowEmpty)throw new NotFoundException('申请单不存在');if(rows.some(run=>run.requesterId!==user.id||run.payload._applicationDraftOrigin!==true))throw new ForbiddenException('只能修改本人建立的申请草稿');return rows;
 }
 private async ownDraft(em:EntityManager,user:AuthUser,id:number,revision:number,allowReturned=false){
  const run=await em.findOne(FlowRun,{where:{id,companyId:user.companyId},lock:{mode:'pessimistic_write'}});if(!run)throw new NotFoundException('申请草稿不存在');
  if(run.requesterId!==user.id)throw new ForbiddenException('只能修改本人的申请草稿');
  if((run.status!=='draft'&&!(allowReturned&&run.status==='running'))||run.payload._applicationDraftOrigin!==true)throw new ConflictException('仅未提交的申请草稿可以执行此操作');
  if(run.revision!==revision)throw new ConflictException('草稿已被修改，请刷新后重试');
  const {template}=await this.definition(em,user,run.templateKey,run.definitionId);
  const steps=await em.find(FlowStep,{where:{companyId:user.companyId,runId:run.id},order:{seq:'ASC'}}),first=(run.stepsSnapshot as StepDef[])[0];
  const active=steps.filter(step=>step.status==='active');
  if(run.status==='running'){
   if(!adapterFor(template).editReturnedApplication||active.length!==1||active[0].stepKey!==first?.key||active[0].stepType!=='submit'||active[0].enteredVia!=='return'||!await em.exists(WorkItem,{where:{companyId:user.companyId,runId:run.id,stepId:active[0].id,assigneeId:user.id,status:'open'}}))throw new ConflictException('只有当前由本人运营办理的退回规格可保存');
   return {run,template,first:active[0]};
  }
  if(steps.length!==1||steps[0].status!=='active'||steps[0].stepType!=='submit'||steps[0].stepKey!==first?.key||await em.exists(WorkItem,{where:{companyId:user.companyId,runId:run.id}}))throw new ConflictException('草稿已有后续处理记录，不能按未提交草稿处理');
  return {run,template,first:steps[0]};
 }
 private async insert(em:EntityManager,user:AuthUser,template:FlowTemplate,header:ApplicationHeader,payload:Record<string,unknown>,key:string,index:number,total:number){
  const steps=header.data.steps,data={...payload,_applicationDraftOrigin:true,_draftCreateHash:header.data.createHash,_batchKey:header.row.sourceRecordId!,_splitIndex:index,_splitTotal:total};
  const run=await em.save(FlowRun,em.create(FlowRun,{companyId:user.companyId,definitionId:header.data.definitionId,templateKey:template.key,title:await adapterFor(template).title(em,user.companyId,payload),status:'draft',requesterId:user.id,currentStepKey:steps[0].key,payload:data,stepsSnapshot:steps,escalateUserIds:header.data.escalateUserIds,requestKey:key,dueAt:null}));
  const first=await em.save(FlowStep,em.create(FlowStep,{companyId:user.companyId,runId:run.id,seq:1,stepKey:steps[0].key,stepName:steps[0].name,stepType:'submit',status:'active',recipients:[user.id],dueAt:null}));
  await this.host.event(em,run,user.id,'draft_save',first.id,'建立申请草稿');return {id:run.id,revision:run.revision};
 }
 private async deletionIssue(em:EntityManager,user:AuthUser,template:FlowTemplate,run:FlowRun){
  if(run.requesterId!==user.id)return '只能删除本人发起的申请单';
  const policy=adapterFor(template).applicationDeletionIssue;
  if(policy)return policy({run,steps:await em.find(FlowStep,{where:{companyId:user.companyId,runId:run.id},order:{seq:'ASC'}})});
  try{await this.ownDraft(em,user,run.id,run.revision);return null;}catch(error){if(error instanceof HttpException)return error.message;throw error;}
 }
 async stop(user:AuthUser,id:number,revision:number,kind:'cancel'|'reject',reason:string){
  needApply(user);if(!['cancel','reject'].includes(kind)||typeof reason!=='string'||!reason.trim()||reason.length>500)throw new BadRequestException('请填写1到500字原因');
  return this.ds.transaction(async em=>{
   await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
   const {run,template,first}=await this.ownDraft(em,user,id,revision);
   const adapter=adapterFor(template),ctx={em,user,run,payload:run.payload,step:first,stepKey:first.stepKey,form:{},...this.host.services};
   const blocked=adapter.cancelBlocked?.(ctx);if(blocked)throw new BadRequestException(blocked);
   first.status=kind==='cancel'?'cancelled':'rejected';first.action=kind;first.handledBy=user.id;first.comment=reason.trim();first.finishedAt=new Date();await em.save(FlowStep,first);
   run.status=kind==='cancel'?'cancelled':'rejected';run.currentStepKey=null;run.dueAt=null;run.finishedAt=new Date();run.revision++;await adapter.onFinish?.(ctx,run.status);await em.save(FlowRun,run);
   await this.host.event(em,run,user.id,kind,first.id,reason.trim());return this.host.detail(em,user,id);
  });
 }
 async read(user:AuthUser,key:string,ref:string){
  if(!batchRef(ref))throw new BadRequestException('申请单编号不合法');const header=await this.headerStore().read(this.ds.manager,user,key,ref),{template}=await this.definition(this.ds.manager,user,key,header.data.definitionId);
  const can=createChecker(user.permissions);let visible=header.row.userId===user.id||user.permissions.isCompanyAdmin||can('flow.overview.view');
  if(!visible){const runs=await this.ds.manager.createQueryBuilder(FlowRun,'r').where('r.companyId=:company AND r.templateKey=:key AND JSON_UNQUOTE(JSON_EXTRACT(r.payload,:path))=:ref',{company:user.companyId,key,path:'$._batchKey',ref}).getMany();for(const run of runs)if(await this.host.visible(this.ds.manager,user,run)){visible=true;break;}}
  if(!visible)throw new ForbiddenException('没有查看此申请的权限');
  const hidden=restrictedFieldKeys({fields:template.fields} as never,can);
  let canDelete=header.row.userId===user.id&&can('flow.apply.view');if(canDelete)for(const run of await this.ds.manager.createQueryBuilder(FlowRun,'r').where('r.companyId=:company AND r.templateKey=:key AND JSON_UNQUOTE(JSON_EXTRACT(r.payload,:path))=:ref',{company:user.companyId,key,path:'$._batchKey',ref}).getMany())if(await this.deletionIssue(this.ds.manager,user,template,run)){canDelete=false;break;}
  const steps=await Promise.all(header.data.steps.map(async step=>{let handlerName=step.type==='end'?'归档':'';try{if(!handlerName)handlerName=(await this.host.handlers(this.ds.manager,{...user,id:header.row.userId},step)).join('、')||'未配置';}catch{handlerName='未配置';}return {key:step.key,name:step.name,type:step.type,handlerName};}));
  return {canDelete,batchKey:ref,title:header.row.title,requesterId:header.row.userId,definitionId:header.data.definitionId,definitionVersion:header.data.definitionVersion,headerVersion:header.version,shared:Object.fromEntries(Object.entries(header.data.shared).filter(([field])=>!hidden.has(field))),steps,createdAt:header.row.createdAt,canAdd:header.row.userId===user.id&&can('flow.apply.view')};
 }
 async add(user:AuthUser,key:string,ref:string,headerVersion:string,actionKey:string,payloads:Record<string,unknown>[],copySource?:{id:number;revision:number}){
  needApply(user);requestKey(actionKey);if(!Array.isArray(payloads)||!payloads.length||Buffer.byteLength(JSON.stringify(payloads))>200*1024)throw new BadRequestException('新增申请明细格式或大小不合法');
  return this.ds.transaction(async em=>{
   await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});const header=await this.ownHeader(em,user,key,ref),{template}=await this.definition(em,user,key,header.data.definitionId),policy=template.applicationDraft!;
   const hash=signature(copySource?[key,ref,payloads,copySource]:[key,ref,payloads]),receipt=await em.createQueryBuilder(AuditLog,'a').where('a.companyId=:company AND a.actorId=:actor AND a.action=:action AND JSON_UNQUOTE(JSON_EXTRACT(a.detail,:path))=:request',{company:user.companyId,actor:user.id,action:'flow.application-draft.add',ref,path:'$.requestKey',request:actionKey}).getOne();
   if(receipt){if(receipt.resourceId!==ref || !receipt.detail || receipt.detail.hash!==hash)throw new ConflictException('请求标识已用于其他明细内容');return {batchKey:ref,headerVersion:header.version,runs:receipt.detail.runs as Array<{id:number;revision:number}>};}
   this.headerStore().assertVersion(header,headerVersion);const rows=await this.members(em,user,key,ref,true);if(rows.length+payloads.length>policy.maxBatchSize)throw new BadRequestException('申请明细数量超过上限');
   if(copySource){
    if(payloads.length!==1)throw new BadRequestException('一次只能复制一个规格');const source=rows.find(row=>row.id===copySource.id);if(!source||source.revision!==copySource.revision)throw new ConflictException('来源规格或版本已变化');
    const active=await em.find(FlowStep,{where:{companyId:user.companyId,runId:source.id,status:'active'}}),first=(source.stepsSnapshot as StepDef[])[0];
    if(!adapterFor(template).copyApplicationPayload||!['draft','running'].includes(source.status)||active.length!==1||active[0].stepKey!==first?.key||active[0].stepType!=='submit'||(source.status==='running'&&active[0].enteredVia!=='return'))throw new ConflictException('只能复制当前仍由运营办理的未完成规格');
    payloads=[adapterFor(template).copyApplicationPayload!(source.payload,payloads[0])];
   }
   const normalized:Record<string,unknown>[]=[];for(const input of payloads){for(const field of [policy.titleField,...policy.sharedFields])if(Object.hasOwn(input,field)&&signature(input[field])!==signature(field===policy.titleField?header.row.title:header.data.shared[field]))throw new BadRequestException('新增明细必须沿用申请公共设置');normalized.push(await this.draftPayload(em,user,template,{...input,...header.data.shared,[policy.titleField]:header.row.title}));}
   const identity=adapterFor(template).draftIdentity,ids=identity?[...rows.map(row=>identity(row.payload)),...normalized.map(payload=>identity(payload))]:[];if(new Set(ids).size!==ids.length)throw new BadRequestException(`同一申请的${policy.itemLabel??'明细'}名称不能重复`);
   const runs=[];for(const [i,payload] of normalized.entries())runs.push(await this.insert(em,user,template,header,payload,`D${signature([user.companyId,user.id,actionKey,i]).slice(0,59)}`,rows.length+i+1,rows.length+normalized.length));
   await this.headerStore().save(em,header,headerVersion);await em.save(AuditLog,em.create(AuditLog,{companyId:user.companyId,actorId:user.id,action:'flow.application-draft.add',resourceType:'flow_application',resourceId:ref,detail:{requestKey:actionKey,hash,runs}}));return {batchKey:ref,headerVersion:header.version,runs};
  });
 }
 async removeApplication(user:AuthUser,key:string,ref:string,version:string,expected:Array<{id:number;revision:number}>,reason:string){
  needApply(user);if(!reason?.trim())throw new BadRequestException('请填写删除原因');return this.ds.transaction(async em=>{
   await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});const header=await this.ownHeader(em,user,key,ref);this.headerStore().assertVersion(header,version);const rows=await this.members(em,user,key,ref,true);
   if(!Array.isArray(expected)||expected.length!==rows.length||new Set(expected.map(row=>row.id)).size!==rows.length||expected.some(row=>!rows.some(run=>run.id===row.id&&run.revision===row.revision)))throw new ConflictException('申请明细或版本已变化');
   const {template}=await this.definition(em,user,key,header.data.definitionId);for(const row of rows){const issue=await this.deletionIssue(em,user,template,row);if(issue)throw new ConflictException(issue);}
   const cleanup=await deleteApplicationRecords(em,user.companyId,ref,rows);
   await em.save(AuditLog,em.create(AuditLog,{companyId:user.companyId,actorId:user.id,action:'flow.application-draft.delete-batch',resourceType:'flow_application',resourceId:ref,detail:{title:header.row.title,reason:reason.trim().slice(0,500),runIds:rows.map(row=>row.id),...cleanup}}));
   await em.delete(FormDraft,{id:header.row.id,companyId:user.companyId,userId:user.id});return {ok:true};
  });
 }
 async templates(user:AuthUser,key:string){
  needApply(user);const template=await this.host.template(this.ds.manager,user.companyId,key);if(!template.applicationDraft)throw new BadRequestException('此流程未启用申请草稿');
  const definitions=await this.ds.manager.find(FlowDefinition,{where:{companyId:user.companyId,templateKey:key},order:{version:'DESC'}}),rows=[];
  // Retired definitions are snapshots of old applications, never choices for a new one.
  const candidates=key==='sku-batch-apply' ? definitions.filter(def=>def.status==='active'||def.status==='draft') : definitions;
  for(const def of candidates)if(await this.host.starterAllowed(this.ds.manager,user,def.starterScope)){
   const issues=validateSteps(template,def.steps as StepDef[],def.escalateUserIds),steps=[];
   for(const step of def.steps as StepDef[]){let handlerName=step.type==='submit'?'申请人':step.type==='end'?'归档':'';if(!handlerName)try{handlerName=(await this.host.handlers(this.ds.manager,user,step)).join('、')||'未配置';}catch(error){handlerName='未配置';issues.push(error instanceof HttpException?error.message:'节点处理人暂不可解析');}steps.push({key:step.key,name:step.name,type:step.type,handlerName});}
   rows.push({id:def.id,version:def.version,status:def.status,label:template.label,steps,issues});
  }
  return {templates:rows};
 }
 async create(user:AuthUser,input:DraftCreateInput){
  needApply(user);requestKey(input.requestKey);if(Buffer.byteLength(JSON.stringify(input.payloads) ?? '')>200*1024)throw new BadRequestException('申请草稿内容太大');if(!Array.isArray(input.payloads)||!input.payloads.length)throw new BadRequestException('请填写申请规格');
  return this.ds.transaction(async em=>{
   await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
   const {definition,template}=await this.definition(em,user,input.templateKey,input.definitionId),policy=template.applicationDraft!;
   if(input.payloads.length>policy.maxBatchSize)throw new BadRequestException('申请规格太多');
   if(!await this.host.starterAllowed(em,user,definition.starterScope))throw new ForbiddenException('你不在所选申请流程的发起人范围内');
   const errors=validateSteps(template,definition.steps as StepDef[],definition.escalateUserIds);if(errors.length)throw new BadRequestException(errors.join('；'));
   const hash=signature([input.templateKey,input.definitionId,input.payloads,input.confirmations]),keys=input.payloads.map((_,i)=>`${input.requestKey}-d${i}`);
   const old=await em.find(FlowRun,{where:{companyId:user.companyId,requestKey:In(keys)},lock:{mode:'pessimistic_write'}});
   if(old.some(run=>run.requesterId!==user.id||run.templateKey!==input.templateKey||run.payload._draftCreateHash!==hash))throw new ConflictException('同一请求标识已用于其他申请内容');
   const ref=`B${signature(['application-draft',user.companyId,user.id,input.requestKey]).slice(0,19)}`,runs=[];
   const priorCreate=await em.createQueryBuilder(AuditLog,'a').where('a.companyId=:company AND a.action=:action AND JSON_UNQUOTE(JSON_EXTRACT(a.detail,:path))=:request',{company:user.companyId,action:'flow.application-draft.create',path:'$.requestKey',request:input.requestKey}).getOne();
   if(priorCreate&&(priorCreate.actorId!==user.id||priorCreate.detail?.hash!==hash))throw new ConflictException('请求标识已用于其他申请');
   const hit=await em.findOneBy(
     // The header is the idempotent application identity even after its last item was deleted.
     FormDraft,{companyId:user.companyId,userId:user.id,moduleKey:`flow-application:${input.templateKey}`,sourceRecordId:ref});
   if(priorCreate&&!hit)throw new ConflictException('原申请已删除，不能重放建立请求');
   if(hit){const header=await this.ownHeader(em,user,input.templateKey,ref);if(header.data.createHash!==hash)throw new ConflictException('同一请求标识已用于其他申请内容');return {batchKey:ref,headerVersion:header.version,runs:old.map(run=>({id:run.id,revision:run.revision}))};}
   if(input.templateKey==='sku-batch-apply'&&definition.status==='retired')throw new ConflictException('所选 SKU 流程版本已停用，请刷新后重新选择');
   for(const check of policy.confirmations??[])if(input.confirmations?.[check.key]!==true)throw new BadRequestException(`请先完成${check.label}，再建立申请`);
   if(Object.entries(input.confirmations??{}).some(([key,value])=>!policy.confirmations?.some(check=>check.key===key)||typeof value!=='boolean'))throw new BadRequestException('申请确认项目不合法');
   const normalized:Record<string,unknown>[]=[];for(const payload of input.payloads)normalized.push(await this.draftPayload(em,user,template,payload));
   for(const field of [policy.titleField,...policy.sharedFields])if(new Set(normalized.map(payload=>signature(payload[field]))).size>1)throw new BadRequestException('同一申请的公共设置必须一致');
   const identity=adapterFor(template).draftIdentity,identities=identity?normalized.map(payload=>identity(payload)):[];if(new Set(identities).size!==identities.length)throw new BadRequestException(`同一申请的${policy.itemLabel ?? '明细'}名称不能重复`);
   const header=await this.headerStore().create(em,user,input.templateKey,ref,String(normalized[0][policy.titleField]??''),{definitionId:definition.id,definitionVersion:definition.version,steps:definition.steps as StepDef[],escalateUserIds:definition.escalateUserIds,shared:Object.fromEntries(policy.sharedFields.flatMap(field=>Object.hasOwn(normalized[0],field)?[[field,normalized[0][field]]]:[])),revision:1,createHash:hash});
   for(const [i,payload] of normalized.entries()){
    const existing=old.find(run=>run.requestKey===keys[i]);if(existing){runs.push({id:existing.id,revision:existing.revision});continue;}
    runs.push(await this.insert(em,user,template,header,payload,keys[i],i+1,normalized.length));
   }
   await em.save(AuditLog,em.create(AuditLog,{companyId:user.companyId,actorId:user.id,action:'flow.application-draft.create',resourceType:'flow_application',resourceId:ref,detail:{requestKey:input.requestKey,hash,definitionId:definition.id}}));
   return {batchKey:ref,headerVersion:header.version,runs};
  });
 }
 async save(user:AuthUser,id:number,revision:number,patch:Record<string,unknown>){
  needApply(user);return this.ds.transaction(async em=>{
   await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
   const {run,template,first}=await this.ownDraft(em,user,id,revision,true),blocked=readOnlyFieldKeys({fields:template.fields} as never,createChecker(user.permissions));
   for(const field of [template.applicationDraft!.titleField,...template.applicationDraft!.sharedFields])if(Object.hasOwn(patch,field)&&signature(patch[field])!==signature(run.payload[field]))throw new BadRequestException('公共设置请在申请公共设置窗口中修改');
   for(const key of Object.keys(patch))if(blocked.has(key))throw new ForbiddenException('没有修改申请字段的权限');
   const publicFields=Object.fromEntries(Object.entries(run.payload).filter(([key])=>!key.startsWith('_'))),payload=await this.draftPayload(em,user,template,{...publicFields,...patch},run);
   const siblings=await this.members(em,user,run.templateKey,String(run.payload._batchKey));
   const identity=adapterFor(template).draftIdentity;
   if(identity&&siblings.some(other=>other.id!==run.id&&identity(other.payload)===identity(payload)))throw new BadRequestException(`此申请单已有同名${template.applicationDraft!.itemLabel ?? '明细'}`);
   run.payload={...Object.fromEntries(Object.entries(run.payload).filter(([key])=>key.startsWith('_'))),...payload};delete run.payload._reviewSig;delete run.payload._review;await adapterFor(template).onDraftSave?.({em,user,payload:run.payload,run,...this.host.services});run.title=await adapterFor(template).title(em,user.companyId,payload);run.revision++;await em.save(FlowRun,run);await this.host.event(em,run,user.id,'draft_save',first.id,'修改申请规格');return this.host.detail(em,user,run.id);
  });
 }
 async shared(user:AuthUser,key:string,ref:string,expected:Array<{id:number;revision:number}>,patch:Record<string,unknown>,headerVersion:string){
  needApply(user);return this.ds.transaction(async em=>{
   await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});const header=await this.ownHeader(em,user,key,ref);this.headerStore().assertVersion(header,headerVersion);const rows=await this.members(em,user,key,ref,true),{template}=await this.definition(em,user,key,header.data.definitionId),fields=template.applicationDraft!.sharedFields;
   if(!Array.isArray(expected)||expected.length!==rows.length||new Set(expected.map(row=>row.id)).size!==rows.length||expected.some(row=>!rows.some(run=>run.id===row.id&&run.revision===row.revision)))throw new ConflictException('申请规格或版本已变化，请刷新后重试');
   if(Object.keys(patch).some(field=>!fields.includes(field)))throw new BadRequestException('包含非公共设置字段');
   const common=await this.sharedPayload(em,user,template,{...header.data.shared,...patch});
   const active=rows.filter(run=>!['cancelled','rejected'].includes(run.status));
   for(const run of active)if(run.status!=='draft'){
    const step=await em.findOneBy(FlowStep,{companyId:user.companyId,runId:run.id,status:'active',stepType:'submit',enteredVia:'return'});if(run.status!=='running'||!step)throw new ConflictException('已有规格进入后续节点，申请公共设置已锁定');
   }
   for(const run of active){const current=Object.fromEntries(Object.entries(run.payload).filter(([field])=>!field.startsWith('_')&&!fields.includes(field))),payload=await this.draftPayload(em,user,template,{...current,...common},run);run.payload={...Object.fromEntries(Object.entries(run.payload).filter(([field])=>field.startsWith('_'))),...payload};delete run.payload._review;delete run.payload._reviewSig;run.revision++;await em.save(FlowRun,run);await this.host.event(em,run,user.id,'draft_save',null,'修改申请公共设置');}
   header.data.shared=common;await this.headerStore().save(em,header,headerVersion);return {ok:true,headerVersion:header.version};
  });
 }
 async submit(user:AuthUser,id:number,revision:number,key:string,confirmation?:FlowConfirmation,comment?:string){
  needApply(user);requestKey(key);if(comment!==undefined&&(typeof comment!=='string'||comment.length>500))throw new BadRequestException('备注最多500字');return this.ds.transaction(async em=>{
   await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
   const existing=await em.findOne(FlowRun,{where:{id,companyId:user.companyId},lock:{mode:'pessimistic_write'}});if(!existing)throw new NotFoundException('申请草稿不存在');
   if(existing.requesterId!==user.id)throw new ForbiddenException('只能提交本人的申请草稿');
   const prior=existing.payload._draftSubmission as {key?:string;revision?:number}|undefined;
   if(existing.status!=='draft'&&prior?.key===key&&prior.revision===revision)return this.host.detail(em,user,id);
   const {run,template,first}=await this.ownDraft(em,user,id,revision);
   const live=await em.findOneBy(FlowDefinition,{companyId:user.companyId,templateKey:run.templateKey,status:'active'});if(!live)throw new ConflictException('流程模板尚未启用，草稿已保留');
   if(!await this.host.starterAllowed(em,user,live.starterScope))throw new ForbiddenException('你不在当前流程的发起人范围内');
   const hidden=restrictedFieldKeys({fields:template.fields} as never,createChecker(user.permissions));
   const checked=validateResourceInput({key:`flow:${template.key}`,label:template.label,titleField:template.fields[0]?.key??'id',fields:template.fields,statuses:[],defaultStatus:''},Object.fromEntries(Object.entries(run.payload).filter(([field])=>!field.startsWith('_')&&!hidden.has(field))),{status:''});if(checked.errors.length)throw new BadRequestException(checked.errors.join('；'));
   const payload=Object.fromEntries(Object.entries(checked.values).filter(([,value])=>value!==undefined&&value!==null));await adapterFor(template).validateStart?.({em,user,payload,run,confirmation,...this.host.services});
   run.payload={...Object.fromEntries(Object.entries(run.payload).filter(([field])=>field.startsWith('_'))),...payload,_draftSubmission:{key,revision}};run.status='running';run.title=await adapterFor(template).title(em,user.companyId,payload);run.revision++;await em.save(FlowRun,run);
   await this.host.activate(em,user,run,run.stepsSnapshot as StepDef[],first,comment?.trim()||undefined);return this.host.detail(em,user,id);
  });
 }
 async submitMany(user:AuthUser,key:string,ref:string,items:Array<{id:number;revision:number;confirmation?:FlowConfirmation}>,actionKey:string,comment?:string){
  needApply(user);requestKey(actionKey);if(!Array.isArray(items)||!items.length||items.length>100||new Set(items.map(item=>item.id)).size!==items.length)throw new BadRequestException('请选择1到100个不重复的申请规格');
  const header=await this.read(user,key,ref);if(header.requesterId!==user.id)throw new ForbiddenException('只能提交本人申请的规格');
  const rows=await this.ds.manager.createQueryBuilder(FlowRun,'r').where('r.companyId=:company AND r.templateKey=:key AND JSON_UNQUOTE(JSON_EXTRACT(r.payload,:path))=:ref',{company:user.companyId,key,path:'$._batchKey',ref}).getMany(),ids=new Set(rows.map(run=>run.id)),results=[];
  for(const item of items){try{if(!ids.has(item.id))throw new NotFoundException('规格不属于此申请');await this.submit(user,item.id,item.revision,`D${signature([user.companyId,user.id,key,ref,actionKey,item.id]).slice(0,59)}`,item.confirmation,comment);results.push({runId:item.id,ok:true});}catch(error){results.push({runId:item.id,ok:false,message:error instanceof HttpException?error.message:'提交失败，请刷新后重试'});}}
  return {ref,ok:results.filter(row=>row.ok).length,failed:results.filter(row=>!row.ok).length,results};
 }
 async remove(user:AuthUser,id:number,revision:number,reason:string){
  needApply(user);if(!reason?.trim())throw new BadRequestException('请填写删除原因');return this.ds.transaction(async em=>{
   await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});const {run}=await this.ownDraft(em,user,id,revision);const header=await this.ownHeader(em,user,run.templateKey,String(run.payload._batchKey));
   await em.save(AuditLog,em.create(AuditLog,{companyId:user.companyId,actorId:user.id,action:'flow.application-draft.delete',resourceType:'flow_run',resourceId:String(run.id),detail:{title:run.title,batchKey:run.payload._batchKey,reason:reason.trim().slice(0,500)}}));
   await em.delete(FlowEvent,{companyId:user.companyId,runId:id});await em.delete(FlowStep,{companyId:user.companyId,runId:id});await em.delete(FlowRun,{companyId:user.companyId,id});await this.headerStore().save(em,header);return {ok:true,headerVersion:header.version};
  });
 }
}
