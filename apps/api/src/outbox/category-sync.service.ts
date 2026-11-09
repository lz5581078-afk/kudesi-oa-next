import {BadRequestException,ConflictException,ForbiddenException,Injectable} from '@nestjs/common';
import {InjectDataSource} from '@nestjs/typeorm';
import {DataSource,EntityManager} from 'typeorm';
import {AuthUser} from '../common/auth.decorators';
import {Company,OutboxJob,ResourceRecord} from '../entities';
import {buildPlan,hash,LinkRow,localTree,PlanError,RemoteNode} from './category-plan';
import {JST_CHANNEL,OutboxService} from './outbox.service';
import {CATEGORY_POLICY_TYPE,categoryPolicy,categoryScopes,categoryScope,type CategoryScope} from './category-sync-policy';
export type {CategoryScope} from './category-sync-policy';
const num=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)?v:null;
const str=(v:unknown)=>typeof v==='string'?v:'';
const parse=<T>(v:unknown):T|null=>v==null?null:typeof v==='string'?JSON.parse(v) as T:v as T;
const dataOf=(v:unknown)=>parse<Record<string,unknown>>(v)??{};
const withoutScope=(value:Record<string,unknown>|null)=>{if(!value)return value;const {syncScope:_scope,...data}=value;return data;};
export class CategoryDependencyPending extends Error {}

const scopeName={product:'商品编码分类',bundle:'商品组合编码分类',archive:'商品档案分类'};
/** 同一分类计划及出站队列：自动授权只绑定可信完整连接。 */
@Injectable()
export class CategorySyncService{
 constructor(@InjectDataSource() private readonly ds:DataSource,private readonly outbox:OutboxService){}
 private scope(scope:CategoryScope){if(!categoryScopes.includes(scope))throw new BadRequestException('分类同步范围无效');}
 private admin(user:AuthUser){if(!user.permissions.isCompanyAdmin)throw new ForbiddenException('只有公司管理员能同步聚水潭分类');}
 private async local(em:EntityManager,companyId:number,scope:CategoryScope){
  const all=await em.find(ResourceRecord,{where:[{companyId,type:'finance-categories'},{companyId,type:'finance-code-dictionaries'}]});
  const inScope=all.filter(row=>!row.archivedAt&&(scope==='product'?row.type==='finance-code-dictionaries'&&row.data.kind==='product_category':row.type==='finance-categories'&&(row.data.archiveType==='bundle')===(scope==='bundle')));
  const version=hash(inScope.map(row=>[row.id,row.data.name,row.data.code,row.data.parentId??null,row.data.sort??0,row.status]).sort((a,b)=>Number(a[0])-Number(b[0])));
  return {all,inScope,version};
 }
 private async snapshot(user:AuthUser,scope:CategoryScope,em:EntityManager=this.ds.manager,mode:'manual'|'auto'|'dependency'='manual'){
  const sender=await this.outbox.senderFor(user.companyId),targetKey=sender.targetKey;
  if(!sender.readCategories||!targetKey)throw new ConflictException('还没有接入聚水潭（或没有配置企业编号），无法读取聚水潭分类，也就不能核对差异');
  const {all,inScope,version}=await this.local(em,user.companyId,scope);let nodes;
  try{nodes=localTree(inScope.map(row=>({id:row.id,name:str(row.data.name),parentId:num(row.data.parentId),sort:num(row.data.sort)??0,enable:row.status==='active'})));}catch(error){if(error instanceof PlanError)throw new ConflictException(error.message);throw error;}
  const raw:Array<{category_id:number;remote_id:string|null;status:string;local_json:unknown;remote_json:unknown;pending_json:unknown}>=await em.query('SELECT category_id,remote_id,status,local_json,remote_json,pending_json FROM jst_category_links WHERE company_id=? AND target_key=? ORDER BY category_id',[user.companyId,targetKey]);
  const mine=new Set(inScope.map(row=>row.id)),known=new Map(all.map(row=>[row.id,row])),provenance=new Map<number,CategoryScope>();
  const unknown=new Set(raw.filter(link=>!known.has(link.category_id)&&!dataOf(link.local_json).syncScope).map(link=>link.category_id));
  if(unknown.size){const history:Array<{mode:string;details_json:unknown}>=await em.query("SELECT mode,details_json FROM jst_category_runs WHERE company_id=? AND JSON_UNQUOTE(JSON_EXTRACT(details_json,'$.targetKey'))=? ORDER BY id DESC",[user.companyId,targetKey]);for(const run of history){const details=dataOf(run.details_json),recorded=categoryScopes.includes(details.scope as CategoryScope)?details.scope as CategoryScope:run.mode==='product'?'archive':categoryScopes.includes(run.mode as CategoryScope)?run.mode as CategoryScope:null;if(!recorded)continue;for(const change of Array.isArray(details.changes)?details.changes:[]){if(!change||typeof change!=='object')continue;const id=Number(change.localId);if(unknown.has(id)&&!provenance.has(id))provenance.set(id,recorded);}}}
  const belongs=(link:typeof raw[number])=>{if(mine.has(link.category_id))return true;const record=known.get(link.category_id),current=record?categoryScope(record.type,record.data):null,stored=dataOf(link.local_json).syncScope;return (current||(categoryScopes.includes(stored as CategoryScope)?stored:provenance.get(link.category_id)))===scope;};
  // 旧孤儿仅按同公司/同目标的真实run取证；无证据关联继续保留，不擅认领。
  const links:LinkRow[]=raw.filter(belongs).map(link=>({localId:String(link.category_id),remoteId:link.remote_id,status:link.status,local:withoutScope(parse(link.local_json)),remote:parse(link.remote_json),pending:parse(link.pending_json)}));
  let remote:RemoteNode[];try{remote=(await sender.readCategories()).map(row=>({id:String(row.id),name:row.name,parentId:String(row.parentId||0),sort:row.sort,enable:row.enable}));}catch{throw new ConflictException('读取聚水潭分类失败，请检查连接后重试');}
  const plan=buildPlan({local:nodes,remote,links,allLinks:raw.map(link=>({localId:String(link.category_id),remoteId:link.remote_id})),targetKey,mode});
  const categoryTarget=sender.categoryTarget,identity=categoryTarget?.key||targetKey;
  return {plan:{...plan,signature:hash([plan.signature,version,identity])},targetKey,categoryTarget,identity,version,remote};
 }
 async preview(user:AuthUser,scope:CategoryScope){
  this.admin(user);this.scope(scope);
  const state=await this.snapshot(user,scope),nodes=new Map(state.plan.nodes.map(node=>[node.id,node])),remote=new Map(state.remote.map(node=>[node.id,node]));
  const remotePath=(id:string)=>{
   const names:string[]=[],seen=new Set<string>();
   for(let node=remote.get(id);node&&!seen.has(node.id);node=remote.get(node.parentId)){seen.add(node.id);names.unshift(node.name);}
   return names.join(' / ')||(id==='0'?'一级分类':`#${id}`);
  };
  const changes=state.plan.changes.map(op=>{
   const node=nodes.get(op.localId);
   const before=op.before as RemoteNode|null;
   return {...op,before:before?{...before,parentLabel:remotePath(before.parentId)}:null,
    after:op.after?{...op.after,parentLabel:node?(nodes.get(node.parentId)?.path||'一级分类'):remotePath(op.after.parentId)}:null};
  });
  return {scope,targetKey:state.identity,target:state.categoryTarget?{name:state.categoryTarget.name,coid:state.categoryTarget.coid}:null,signature:state.plan.signature,conflicts:state.plan.conflicts,remoteOnly:state.plan.remoteOnly.length,changes,note:'聚水潭未返回排序或启用状态时，这两项按 OA 配置写入，不能判断远端是否单独修改过。删除同步为停用。'};
 }
 /** Verify the linked remote ID and the whole local path before sending a SKU. */
 async requireForSku(companyId:number,scope:CategoryScope,categoryId:unknown,sender:Awaited<ReturnType<OutboxService['senderFor']>>){
  if(!sender.categoryTarget||!sender.targetKey||!sender.readCategories)return;
  const {inScope}=await this.local(this.ds.manager,companyId,scope);
  const byId=new Map(inScope.map(row=>[row.id,row])),path:ResourceRecord[]=[],seen=new Set<number>();
  for(let id=Number(categoryId);id;){
   const row=byId.get(id);
   if(!row||seen.has(id)||row.status!=='active')throw new ConflictException('编码分类或上级已停用、缺失或存在循环');
   seen.add(id);path.unshift(row);id=Number(row.data.parentId??0);
  }
  const leaf=path.at(-1);
  if(!leaf||inScope.some(row=>row.status==='active'&&Number(row.data.parentId)===leaf.id))throw new ConflictException('请选择有效的末级编码分类');
  const links:Array<{category_id:number;remote_id:string;local_json:unknown}>=await this.ds.query("SELECT category_id,remote_id,local_json FROM jst_category_links WHERE company_id=? AND target_key=? AND status='linked' AND category_id IN (?)",[companyId,sender.targetKey,path.map(row=>row.id)]);
  const linked=new Map(links.map(link=>[link.category_id,link]));
  const pending=()=>new CategoryDependencyPending('等待编码分类在当前聚水潭账号同步成功');
  if(path.some(row=>{
   const link=linked.get(row.id),saved=dataOf(link?.local_json);
   return !link?.remote_id||saved.name!==row.data.name||String(saved.parentId??0)!==String(row.data.parentId??0);
  })){
   await this.queueSkuPath(companyId,scope,path,sender.categoryTarget.key);
   throw pending();
  }
  const remote=await sender.readCategories(),remoteById=new Map(remote.map(node=>[node.id,node]));
  for(const row of path){
   const node=remoteById.get(String(linked.get(row.id)?.remote_id));
   const parent=row.data.parentId?String(linked.get(Number(row.data.parentId))?.remote_id):'0';
   if(!node||node.enable===false||node.name!==row.data.name||node.parentId!==parent)throw new CategoryDependencyPending('聚水潭分类或上级资料已变化，等待核对分类映射');
  }
 }
 private async queueSkuPath(companyId:number,scope:CategoryScope,path:ResourceRecord[],target:string){
  const current=await categoryPolicy(this.ds.manager,companyId,scope);
  if(current?.data.enabled!==true||current.data.targetKey!==target)return;
  await this.ds.transaction(async em=>{
   await em.findOneOrFail(Company,{where:{id:companyId},lock:{mode:'pessimistic_write'}});
   const policy=await categoryPolicy(em,companyId,scope,true);
   if(policy?.data.enabled!==true||policy.data.targetKey!==target)return;
   const ids=path.map(row=>row.id);
   const [prior]=await em.query("SELECT id FROM outbox_jobs WHERE company_id=? AND kind='category_sync' AND resource_id IN (?) AND status IN ('pending','sending','failed') AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.categoryTargetKey'))=? LIMIT 1",[companyId,ids,target]);
   if(prior)return;
   const user:AuthUser={id:Number(policy.data.authorizedBy)||0,companyId,name:'商品上传分类依赖',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
   const state=await this.snapshot(user,scope,em,'dependency');
   if(state.categoryTarget?.key!==target)return;
   const changes=state.plan.changes.filter(change=>ids.includes(Number(change.localId)));
   if(!changes.length||changes.some(change=>change.action==='conflict'))return;
   await this.queuePlan(em,user,scope,{...state,plan:{...state.plan,changes}},'dependency',policy.id);
  });
 }
 private async queuePlan(em:EntityManager,user:AuthUser,scope:CategoryScope,state:Awaited<ReturnType<CategorySyncService['snapshot']>>,mode:'manual'|'auto'|'dependency',policyId?:number){
  const {plan,targetKey}=state,details:Array<{localId:string;path:string;action:string;jobId:number|null;status:string}>=[];let queued=0;
  const nodeById=new Map(plan.nodes.map(node=>[node.id,node]));
  for(const op of plan.changes){
   if(op.action==='retire'){const [link]=await em.query('SELECT local_json FROM jst_category_links WHERE company_id=? AND target_key=? AND category_id=?',[user.companyId,targetKey,Number(op.localId)]);await em.query("UPDATE jst_category_links SET local_json=?,remote_json=NULL,pending_json=NULL,status='retired' WHERE company_id=? AND target_key=? AND category_id=?",[JSON.stringify({...dataOf(link?.local_json),syncScope:scope,enable:false}),user.companyId,targetKey,Number(op.localId)]);details.push({localId:op.localId,path:op.path,action:op.action,jobId:null,status:'success'});continue;}
   const after=op.after!;const node=nodeById.get(op.localId)??{...dataOf((await em.query('SELECT local_json FROM jst_category_links WHERE company_id=? AND target_key=? AND category_id=?',[user.companyId,targetKey,Number(op.localId)]))[0]?.local_json),enable:false};
   const desired:Record<string,unknown>={name:after.name,sort:after.sort??0,enable:after.enable};if(after.parentId.startsWith('local:'))desired.parentLocalId=after.parentId.slice(6);else desired.parentRemoteId=after.parentId;
   const remoteId=(op.before as RemoteNode|null)?.id??null,payload={op:op.action,localId:op.localId,remoteId,desired,local:{...node,syncScope:scope},scope,targetKey,categoryTargetKey:state.categoryTarget?.key,localVersion:state.version,mode,policyId,sku_id:`category:${op.localId}`},baseKey=`cat:${op.localId}:${hash({remoteId,desired}).slice(0,16)}`;
   const prior:Array<{id:number;idempotency_key:string;status:string}>=await em.query("SELECT id,idempotency_key,status FROM outbox_jobs WHERE company_id=? AND kind='category_sync' AND resource_id=? AND (idempotency_key=? OR idempotency_key LIKE ?)",[user.companyId,Number(op.localId),baseKey,`${baseKey}:%`]);
   const live=prior.find(row=>['pending','sending'].includes(row.status));if(live){details.push({localId:op.localId,path:op.path,action:op.action,jobId:Number(live.id),status:'queued'});continue;}
   const key=prior.length?`${baseKey}:${prior.length}`:baseKey,result=await em.query('INSERT IGNORE INTO outbox_jobs(company_id,channel,kind,resource_type,resource_id,idempotency_key,payload_json,created_by) VALUES(?,?,?,?,?,?,?,?)',[user.companyId,JST_CHANNEL,'category_sync',scope==='product'?'finance-code-dictionaries':'finance-categories',Number(op.localId),key,JSON.stringify(payload),user.id||null]);
   if(result.affectedRows)queued++;details.push({localId:op.localId,path:op.path,action:op.action,jobId:Number(result.insertId)||null,status:'queued'});
  }
  const run=await em.query('INSERT INTO jst_category_runs(company_id,mode,actor_id,status,message,details_json) VALUES(?,?,?,?,?,?)',[user.companyId,scope,user.id||null,details.some(row=>row.jobId)?'queued':'success',`已加入同步队列 ${queued} 项（${scopeName[scope]}）`,JSON.stringify({scope,mode,signature:plan.signature,targetKey,changes:details})]);
  return{runId:Number(run.insertId),queued,retired:details.filter(row=>row.action==='retire').length};
 }
 async execute(user:AuthUser,scope:CategoryScope,signature:string,confirmed:boolean){this.admin(user);this.scope(scope);if(confirmed!==true)throw new ConflictException('请先确认差异，再执行同步');return this.ds.transaction(async em=>{await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});const state=await this.snapshot(user,scope,em);if(signature!==state.plan.signature)throw new ConflictException('两端资料已变化，请刷新差异后重新确认');if(state.plan.conflicts)throw new ConflictException(`存在 ${state.plan.conflicts} 项分类冲突，请先到预览里处理`);return this.queuePlan(em,user,scope,state,'manual');});}
 async status(user:AuthUser,scope:CategoryScope,page=1){this.admin(user);this.scope(scope);const policy=await categoryPolicy(this.ds.manager,user.companyId,scope);let target:null|{key:string;name:string;coid:string}=null;try{const sender=await this.outbox.senderFor(user.companyId);if(sender.configured&&sender.categoryTarget)target=sender.categoryTarget;}catch{/* 只投影公开的连接可用性。 */}
  const enabled=policy?.data.enabled===true,stopped=enabled&&(!target||policy?.data.targetKey!==target.key),generation=num(policy?.data.generation)??0,processed=num(policy?.data.processedGeneration)??0;
  return{enabled,effective:enabled&&!stopped,stopped,target,hasPending:enabled&&generation>processed,lastError:stopped?'授权账号已变化，自动同步已停止，请重新人工核对并授权':str(policy?.data.lastError),...(await this.runs(user,page,scope))};
 }
 async automatic(user:AuthUser,scope:CategoryScope,enabled:boolean,confirmed:boolean,expectedTarget?:string){this.admin(user);this.scope(scope);return this.ds.transaction(async em=>{
  await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});let policy=await categoryPolicy(em,user.companyId,scope,true),targetKey=str(policy?.data.targetKey);
  if(enabled){if(confirmed!==true)throw new ConflictException('请明确确认每次分类操作均自动写入聚水潭');const state=await this.snapshot(user,scope,em);if(!state.categoryTarget)throw new ConflictException('当前连接尚未提供完整分类授权目标，请重新配置连接');targetKey=state.categoryTarget.key;if(expectedTarget!==targetKey)throw new ConflictException('聚水潭授权目标已变化，请重新核对差异');if(state.plan.changes.length)throw new ConflictException('请先手动核对并同步全部差异，再启用自动同步');const latest=await this.outbox.senderFor(user.companyId);if(latest.categoryTarget?.key!==targetKey)throw new ConflictException('聚水潭授权目标已变化，请重新核对差异');}
  if(!policy)policy=em.create(ResourceRecord,{companyId:user.companyId,type:CATEGORY_POLICY_TYPE,uniqueKey:scope,title:scopeName[scope],status:'active',data:{scope,generation:0,processedGeneration:0},createdBy:user.id,updatedBy:user.id});
  const generation=(num(policy.data.generation)??0)+(enabled?1:0);policy.data={...policy.data,enabled,targetKey,generation,processedGeneration:enabled?(num(policy.data.processedGeneration)??0):generation,authorizedBy:user.id,authorizedAt:new Date().toISOString(),lastActorId:user.id,lastError:'',nextAttemptAt:0};policy.updatedBy=user.id;await em.save(ResourceRecord,policy);
  await em.query('INSERT INTO jst_category_runs(company_id,mode,actor_id,status,message,details_json) VALUES(?,?,?,?,?,?)',[user.companyId,scope,user.id,'success',enabled?'管理员确认启用逐次分类操作同步':'管理员关闭自动同步',JSON.stringify({scope,mode:'settings',changes:[]})]);return{enabled};
 });}
 async retryAutomatic(user:AuthUser,scope:CategoryScope){this.admin(user);this.scope(scope);return this.ds.transaction(async em=>{const policy=await categoryPolicy(em,user.companyId,scope,true),sender=await this.outbox.senderFor(user.companyId);if(!policy||policy.data.enabled!==true||!sender.categoryTarget||policy.data.targetKey!==sender.categoryTarget.key)throw new ConflictException('分类自动同步未开启或授权目标已变化');policy.data={...policy.data,generation:(num(policy.data.generation)??0)+1,nextAttemptAt:0,lastError:'',failedGeneration:undefined};policy.updatedBy=user.id;await em.save(ResourceRecord,policy);await em.query('INSERT INTO jst_category_runs(company_id,mode,actor_id,status,message,details_json) VALUES(?,?,?,?,?,?)',[user.companyId,scope,user.id,'success','管理员重新安排自动同步核对',JSON.stringify({scope,mode:'retry',changes:[]})]);return{queued:1};});}
 async drainAutomatic(companyId:number){
  const ids=(await this.ds.manager.find(ResourceRecord,{where:{companyId,type:CATEGORY_POLICY_TYPE},select:['id','data']})).filter(row=>row.data.enabled===true&&(num(row.data.generation)??0)>(num(row.data.processedGeneration)??0)).map(row=>row.id);
  for(const id of ids)await this.ds.transaction(async em=>{
   const policy=await em.findOne(ResourceRecord,{where:{id,companyId,type:CATEGORY_POLICY_TYPE},lock:{mode:'pessimistic_write'}});if(!policy||policy.data.enabled!==true)return;const scope=policy.data.scope as CategoryScope;if(!categoryScopes.includes(scope))return;const generation=num(policy.data.generation)??0;if(generation<=(num(policy.data.processedGeneration)??0)||Number(policy.data.nextAttemptAt||0)>Date.now())return;
   const [{n}]=await em.query("SELECT COUNT(*) n FROM outbox_jobs WHERE company_id=? AND kind='category_sync' AND status IN ('pending','sending')",[companyId]);if(Number(n))return;
   const user:AuthUser={id:Number(policy.data.lastActorId||policy.data.authorizedBy)||0,companyId,name:'分类自动同步',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
   const priorData={...policy.data};await em.query('SAVEPOINT category_auto_plan');
   try{const state=await this.snapshot(user,scope,em,'auto');if(!state.categoryTarget||policy.data.targetKey!==state.categoryTarget.key)throw new ConflictException('授权账号已变化');if(state.plan.conflicts)throw new ConflictException('分类存在待人工核对的冲突');await this.queuePlan(em,user,scope,state,'auto',policy.id);policy.data={...policy.data,processedGeneration:generation,lastError:'',nextAttemptAt:0};await em.save(ResourceRecord,policy);await em.query('RELEASE SAVEPOINT category_auto_plan');}
   catch{await em.query('ROLLBACK TO SAVEPOINT category_auto_plan');const message='分类自动同步未完成，请打开差异核对后重试';if(priorData.failedGeneration!==generation)await em.query('INSERT INTO jst_category_runs(company_id,mode,actor_id,status,message,details_json) VALUES(?,?,?,?,?,?)',[companyId,scope,user.id||null,'failed',message,JSON.stringify({scope,mode:'auto',changes:[]})]);policy.data={...priorData,lastError:message,failedGeneration:generation,nextAttemptAt:Date.now()+5000};await em.save(ResourceRecord,policy);}
  });
 }
 /** 新任务发送前复用相同计划再次核对；旧任务无新快照时保留旧兼容语义。 */
 async queuedState(job:OutboxJob):Promise<'current'|'satisfied'|'stale'>{
  const p=job.payloadJson,scope=p.scope as CategoryScope;if(!p.localVersion||!categoryScopes.includes(scope))return'current';
  const user:AuthUser={id:job.createdBy||0,companyId:job.companyId,name:'分类同步核对',permissions:{isCompanyAdmin:true,allow:[],deny:[]}},sender=await this.outbox.senderFor(job.companyId);
  if(p.categoryTargetKey&&p.categoryTargetKey!==sender.categoryTarget?.key)return'stale';
  const transport=p.transport as {stage?:string}|undefined;
  // A persisted write intent can only read back. Replanning could turn a successful
  // create into a bind and cancel it before the original result can be confirmed.
  if(transport?.stage==='category-write-intent'||transport?.stage==='category-written')return'current';
  if(p.mode==='auto'||p.mode==='dependency'){const policy=await categoryPolicy(this.ds.manager,job.companyId,scope);if(!policy||policy.data.enabled!==true||policy.data.targetKey!==sender.categoryTarget?.key)return'stale';}
  if((await this.local(this.ds.manager,job.companyId,scope)).version!==p.localVersion)return'stale';
  const state=await this.snapshot(user,scope,this.ds.manager,p.mode==='dependency'?'dependency':p.mode==='auto'?'auto':'manual'),op=state.plan.operations.find(row=>row.localId===String(p.localId));if(!op||op.action==='conflict'||p.mode!=='dependency'&&state.plan.conflicts)return'stale';if(op.action==='none')return'satisfied';if(op.action!==p.op)return'stale';
  const desired={...(p.desired as Record<string,unknown>)};if(desired.parentLocalId){const [parent]=await this.ds.query("SELECT remote_id FROM jst_category_links WHERE company_id=? AND target_key=? AND category_id=? AND status='linked'",[job.companyId,str(p.targetKey),Number(desired.parentLocalId)]);if(parent?.remote_id)desired.parentRemoteId=String(parent.remote_id);else desired.parentRemoteId='local:'+String(desired.parentLocalId);}
  return op.after&&hash([op.after.name,op.after.parentId,op.after.sort??0,op.after.enable])===hash([desired.name,desired.parentRemoteId??'0',desired.sort??0,desired.enable])?'current':'stale';
 }
 async runs(user:AuthUser,page:number,scope?:CategoryScope){this.admin(user);if(scope)this.scope(scope);const rows:Array<{id:number;mode:string;status:string;message:string;details_json:unknown;created_at:string}>=await this.ds.query(`SELECT id,mode,status,message,details_json,created_at FROM jst_category_runs WHERE company_id=?${scope==='archive'?" AND (mode='archive' OR (mode='product' AND JSON_EXTRACT(details_json,'$.scope') IS NULL))":scope==='product'?" AND mode='product' AND JSON_UNQUOTE(JSON_EXTRACT(details_json,'$.scope'))='product'":scope?" AND mode='bundle'":''} ORDER BY id DESC LIMIT 20 OFFSET ?`,[user.companyId,(page-1)*20]);const out=[];
  for(const row of rows){const details=parse<{mode?:string;scope?:string;changes:Array<{localId:string;path:string;action:string;jobId:number|null;status:string}>}>(row.details_json)??{changes:[]};const ids=details.changes.map(change=>change.jobId).filter((id):id is number=>!!id),jobs:Array<{id:number;status:string;last_error:string|null;transport_stage?:string}>=ids.length?await this.ds.query("SELECT id,status,last_error,JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.transport.stage')) AS transport_stage FROM outbox_jobs WHERE company_id=? AND id IN (?)",[user.companyId,ids]):[],byId=new Map(jobs.map(job=>[job.id,job]));const changes=details.changes.map(change=>({...change,status:change.jobId?byId.get(change.jobId)?.status??change.status:change.status,error:change.jobId?byId.get(change.jobId)?.last_error??null:null,canRecheck:!!change.jobId&&byId.get(change.jobId)?.status==='failed'&&['category-write-intent','category-written'].includes(byId.get(change.jobId)?.transport_stage??'')}));const status=changes.some(change=>['failed','cancelled','rejected'].includes(change.status))?'failed':!changes.length?row.status:changes.every(change=>['done','success'].includes(change.status))?'success':changes.some(change=>change.status==='sending')?'running':'queued';out.push({id:row.id,scope:details.scope||(row.mode==='product'?'archive':row.mode),mode:details.mode==='dependency'?'auto':details.mode||'manual',status,message:row.message,createdAt:row.created_at,changes});}
  return{page,rows:out};
 }
}
