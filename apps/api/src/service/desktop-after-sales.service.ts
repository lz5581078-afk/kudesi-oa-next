import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AFTER_SALES_FIELDS, AFTER_SALES_PAGE_SIZE, DESKTOP_AFTER_SALES_ROUTES, DESKTOP_SALE_CLICK_LABELS, afterSalesCell, createChecker, type AfterSalesColumnFilter, type DesktopSaleClick, type DesktopSaleFieldChange, type DesktopSaleListRow, type DesktopSaleSnapshot, type DesktopSaleWorkspaceState } from '@kudesi/shared';
import { Notification, ResourceFile } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import {writeNotification} from '../outbox/write-notification';
import { CryptoService } from '../common/crypto.service';
import { FilesService, type UploadedFile } from '../integrations/files.service';
import {applicationAt,sourceChanges} from './desktop-after-sales-domain';

const FILE_TYPE = 'desktop-after-sales';
const AUDIT_PREFIX='\u0000OA售后操作记录1\n';
type SaleEventRow = {id:number;kind:string;content_enc:string;createdAt:Date;actorId:number;actorName:string|null};
type Handling = {warehouse?:boolean;note:string;nextAt:string|null;nextOwnerName:string;fileIds:number[]};
type Closing = {warehouse?:boolean;reason:string;fileIds:number[]};
type Evidence = {name:string;fileId:number};
type FollowInput = {version:number;progress:string;ownerId?:number|null;nextAt?:string|null;note:string};
type Row = { workspace_state:DesktopSaleWorkspaceState; id:number; store_id:number|null; source_company:string; after_sale_id:string; internal_order_id:string; snapshot_enc:string; progress_enc:string; owner_id:number|null; next_at:Date|null; version:number; attachments:number[]|string; updated_at:Date; priority:number;row_color:string|null;report_enc:string|null;source_seen_at:Date|null;flow_case_id:number|null };
type StoredRow = Omit<Row,'workspace_state'> & {workspace_state:DesktopSaleWorkspaceState|null};
const LEGACY_CLOSURE = "EXISTS (SELECT 1 FROM desktop_after_sales_events e WHERE e.company_id=c.company_id AND e.sale_id=c.id AND e.kind IN ('closed','close_entry'))";
type ListRow = StoredRow & { storeName: string | null; ownerName: string | null };
const fileIds = (v: Row['attachments']): number[] => typeof v === 'string' ? JSON.parse(v) : v;
const ordersConflict = (known:string, incoming:string) => !!known && !!incoming && known!==incoming;
/** Local OA follow-up is independent of ERP refund approval. This service never writes to ERP. */
@Injectable()
export class DesktopAfterSalesService implements OnModuleInit,OnModuleDestroy {
  private reminderTimer?:NodeJS.Timeout;
  private readonly logger=new Logger(DesktopAfterSalesService.name);

  onModuleInit(){
    if(process.env.NODE_ENV==='test')return;
    this.reminderTimer=setInterval(()=>void this.dispatchFollowReminders().catch(
      error=>this.logger.error('售后跟进提醒失败',error instanceof Error?error.name:undefined),
    ),60_000);
    this.reminderTimer.unref();
  }
  onModuleDestroy(){if(this.reminderTimer)clearInterval(this.reminderTimer);}

  constructor(@InjectDataSource() private readonly ds:DataSource, private readonly crypto:CryptoService, private readonly files:FilesService) {}
  async options(u:AuthUser) {
    const stores=await this.ds.query(`SELECT id,title AS name FROM resource_records WHERE company_id=? AND type='stores' AND archived_at IS NULL AND status<>'cancelled' ORDER BY title LIMIT 2000`,[u.companyId]);
    const people=await this.ds.query(
      "SELECT u.id,u.name,d.id AS departmentId,d.name AS departmentName FROM users u LEFT JOIN departments d ON d.company_id=u.company_id AND d.id=u.department_id WHERE u.company_id=? AND u.status='active' ORDER BY d.name,u.name LIMIT 3000",
      [u.companyId],
    );
    const [current]=await this.ds.query('SELECT department_id AS departmentId FROM users WHERE company_id=? AND id=?',[u.companyId,u.id]);
    return {stores,people,currentUserId:u.id,currentDepartmentId:current?.departmentId??null};
  }
  async list(u:AuthUser, keyword='', page=1, sort='申请时间', direction='desc', filters:AfterSalesColumnFilter[] = [],state:DesktopSaleWorkspaceState='open') {
    const args:unknown[]=[u.companyId,state];
    let stateFilter='c.workspace_state=?';
    if(state!=='tear'){
      const legacyFilter=state==='closed'?LEGACY_CLOSURE:'NOT '+LEGACY_CLOSURE;
      stateFilter=`(${stateFilter} OR (c.workspace_state IS NULL AND ${legacyFilter}))`;
    }
    let where='c.company_id=? AND '+stateFilter;
    if(keyword){where+=' AND (c.after_sale_id LIKE ? OR c.internal_order_id LIKE ?)';args.push(`%${keyword}%`,`%${keyword}%`);}
    const columns:Record<string,string>={'申请时间':'c.application_at','售后单号':'c.after_sale_id','内部订单号':'c.internal_order_id','紧急度':'c.priority','负责人':'u.name','下次跟进':'c.next_at'};
    const order=Object.hasOwn(columns,sort)?columns[sort]:columns['申请时间'],dir=direction==='asc'?'ASC':'DESC';
    const query=`SELECT c.*,s.title AS storeName,u.name AS ownerName FROM desktop_after_sales c
      LEFT JOIN resource_records s ON s.company_id=c.company_id AND s.id=c.store_id AND s.type='stores'
      LEFT JOIN users u ON u.company_id=c.company_id AND u.id=c.owner_id
      WHERE ${where} ORDER BY ${order} IS NULL,${order} ${dir},c.id DESC LIMIT ? OFFSET ?`;
    const project=(r:ListRow):DesktopSaleListRow=>({id:r.id,afterSaleId:r.after_sale_id,internalOrderId:r.internal_order_id,sourceCompany:r.source_company,
      storeId:r.store_id,storeName:r.storeName??'',ownerId:r.owner_id,ownerName:r.ownerName??'',priority:r.priority,rowColor:r.row_color,
      snapshot:this.project(u,JSON.parse(this.crypto.decrypt(r.snapshot_enc))),
      progress:this.crypto.decrypt(r.progress_enc),nextAt:r.next_at?.toISOString()??null,version:r.version,updatedAt:r.updated_at.toISOString()});
    const start=(page-1)*AFTER_SALES_PAGE_SIZE;
    if(filters.length){
      const conditions=filters.map(({column,value})=>({column,value:value.trim().toLowerCase()})).filter(f=>f.value);
      // Source text is encrypted. Match only permission-projected values and keep just the requested page.
      return this.ds.transaction('REPEATABLE READ',async em=>{
        const batchSize=200,rows:DesktopSaleListRow[]=[];
        let total=0;
        for(let offset=0;;offset+=batchSize){
          const batch:ListRow[]=await em.query(query,[...args,batchSize,offset]);
          for(const r of batch){
            const row=project(r);
            if(!conditions.every(f=>afterSalesCell(row,f.column).toLowerCase().includes(f.value)))continue;
            if(total>=start&&rows.length<AFTER_SALES_PAGE_SIZE)rows.push(row);
            total++;
          }
          if(batch.length<batchSize)break;
        }
        return {total,rows};
      });
    }
    const rows:ListRow[]=await this.ds.query(query,[...args,AFTER_SALES_PAGE_SIZE,start]);
    const [{total}]=await this.ds.query(`SELECT COUNT(*) AS total FROM desktop_after_sales c WHERE ${where}`,args);
    return {total:Number(total),rows:rows.map(project)};
  }
  private async row(em:EntityManager,u:AuthUser,id:number,lock=false):Promise<Row>{
    const [r]:StoredRow[]=await em.query(`SELECT * FROM desktop_after_sales WHERE company_id=? AND id=? ${lock?'FOR UPDATE':''}`,[u.companyId,id]);
    if(!r)throw new NotFoundException('售后档案不存在');
    const workspaceState=r.workspace_state??(await this.closingEvent(em,u,id)?'closed':'open');
    return {...r,workspace_state:workspaceState};
  }
  private sanitize(snapshot:DesktopSaleSnapshot):DesktopSaleSnapshot {
    if(!/^\d{4,40}$/.test(snapshot.afterSaleId)||!snapshot.sourceCompany.trim())throw new BadRequestException('请读取售后单号并确认聚水潭公司');
    if(typeof snapshot.internalOrderId!=='string'||(snapshot.internalOrderId!==''&&!/^\d{4,40}$/.test(snapshot.internalOrderId)))throw new BadRequestException('内部订单号格式无效');
    if(!Number.isFinite(Date.parse(snapshot.capturedAt)))throw new BadRequestException('读取时间无效');
    if(Object.keys(snapshot.fields).some(k=>!AFTER_SALES_FIELDS.includes(k as never)))throw new BadRequestException('包含不支持的网页字段');
    const fields:DesktopSaleSnapshot['fields']={};
    for(const k of AFTER_SALES_FIELDS){
      const value=snapshot.fields[k];if(value===undefined)continue;
      if(typeof value!=='string'||value.length>12000)throw new BadRequestException('网页字段过长');
      if(k==='原订单旗帜'&&value!==''&&!/^#[0-9a-f]{6}$/.test(value))throw new BadRequestException('原订单旗帜颜色无效');
      fields[k]=value.replace(/https?:\/\/\S+/gi,'[链接已移除]').replace(/(?:jmxToken|access_token|authorization|password|cookie)\s*[:=]\s*[^\n]+/gi,'[凭据已移除]');
    }
    if(JSON.stringify(fields).length>100000)throw new BadRequestException('网页内容过多，请分次读取');
    return {...snapshot,sourceCompany:snapshot.sourceCompany.trim(),fields};
  }
  private project(u:AuthUser,s:DesktopSaleSnapshot){
    const can=createChecker(u.permissions);const fields={...s.fields};
    if(!can('product.cost.view'))delete fields['原订单采购金额'];
    if(!can('product.price.view'))for(const k of ['原订单下单金额','原订单下单金额明细','线上申请金额','实退金额','支付金额','商品总成交金额','优惠抵扣金额','运费','应付总金额','实际已付','实际收货金额','退货金额','买家应补运费','实退金额明细','商家实退','线上商品应退金额','线上退运费','商品应退金额','优惠/差额','卖家应补','卖家应退运费','换货金额','买家应补','买家退款账号','卖家退款账号',
      '买家已付运费','订单支付金额','线上原始金额','支付优惠','店铺优惠','订单优惠明细','售后详情商品汇总','售后线上金额说明','优惠/差额'] as const)delete fields[k];
    if(!u.permissions.isCompanyAdmin){delete fields['买家退款账号'];delete fields['卖家退款账号'];}
    // Unstructured goods/log text can contain costs and quoted unit prices.
    if(!can('product.price.view')||!can('product.cost.view')){delete fields['商品信息'];delete fields['商品明细'];delete fields['售后商品明细'];delete fields['售后日志'];delete fields['平台售后记录'];delete fields['订单操作日志'];delete fields['售后详情操作日志'];delete fields['售后详情商品明细'];}
    return {...s,fields};
  }
  async assertAccess(u:AuthUser,id:number,write=false){
    await this.row(this.ds.manager,u,id);
    if(createChecker(u.permissions)('after-sales.workspace.view'))return;
    const [grant]=await this.ds.query(`SELECT can_write FROM desktop_after_sales_grants WHERE company_id=? AND sale_id=? AND user_id=?`,[u.companyId,id,u.id]);
    if(!grant||(write&&!grant.can_write))throw new ForbiddenException('没有这笔售后的协作权限');
  }
  private async closingEvent(em:EntityManager,u:AuthUser,id:number):Promise<SaleEventRow|undefined>{
    const [event]=await em.query(
      "SELECT e.id,e.kind,e.content_enc,e.created_at AS createdAt,e.actor_id AS actorId,u.name AS actorName FROM desktop_after_sales_events e LEFT JOIN users u ON u.company_id=e.company_id AND u.id=e.actor_id WHERE e.company_id=? AND e.sale_id=? AND e.kind IN ('closed','close_entry') ORDER BY e.id DESC LIMIT 1",
      [u.companyId,id],
    );
    return event;
  }
  private readEvent(event:{content_enc:string;actorName?:string|null}){
    const raw=this.crypto.decrypt(event.content_enc);
    if(!raw.startsWith(AUDIT_PREFIX))return {content:raw,actorName:event.actorName??''};
    try{
      const value=JSON.parse(raw.slice(AUDIT_PREFIX.length)) as {content?:unknown;actorName?:unknown}|null;
      if(typeof value?.content==='string'&&typeof value.actorName==='string')return {content:value.content,actorName:value.actorName};
    }catch{/* Historical free text remains readable. */}
    return {content:raw,actorName:event.actorName??''};
  }
  private projectClosure(event:SaleEventRow){
    const {content,actorName}=this.readEvent(event);
    const reason=event.kind==='close_entry'?(JSON.parse(content) as Closing).reason:content;
    return {reason,actorName,actorId:event.actorId,createdAt:event.createdAt};
  }
  async detail(u:AuthUser,id:number,before?:number){
    const r=await this.row(this.ds.manager,u,id);
    const [store]=await this.ds.query('SELECT title FROM resource_records WHERE company_id=? AND id=? AND type=\'stores\'',[u.companyId,r.store_id]);
    const [owner]=r.owner_id?await this.ds.query('SELECT name FROM users WHERE company_id=? AND id=?',[u.companyId,r.owner_id]):[];
    const eventQuery=`SELECT e.id,e.kind,e.content_enc,e.created_at AS createdAt,e.actor_id AS actorId,u.name AS actorName FROM desktop_after_sales_events e LEFT JOIN users u ON u.company_id=e.company_id AND u.id=e.actor_id WHERE e.company_id=? AND e.sale_id=?`;
    const events:SaleEventRow[]=await this.ds.query(eventQuery+(before?' AND e.id<?':'')+' ORDER BY e.id DESC LIMIT 100',before?[u.companyId,id,before]:[u.companyId,id]);
    const nextEventsBefore=events.length===100?events[99].id:null;
    if(!before&&nextEventsBefore&&!events.some(event=>['follow','closed','follow_entry','close_entry','evidence','file','tear_sent','notice_sent','reply','tear_reply','report'].includes(event.kind))){
      const [latest]:SaleEventRow[]=await this.ds.query(eventQuery+" AND e.kind IN ('follow','closed','follow_entry','close_entry','evidence','file','tear_sent','notice_sent','reply','tear_reply','report') ORDER BY e.id DESC LIMIT 1",[u.companyId,id]);
      if(latest)events.push(latest);
    }
    const progress=this.crypto.decrypt(r.progress_enc);
    const closing=r.workspace_state==='closed'?(events.find(event=>event.kind==='closed'||event.kind==='close_entry')??await this.closingEvent(this.ds.manager,u,id)):undefined;
    const closed=closing?this.projectClosure(closing):null;
    const snapshot=this.project(u,JSON.parse(this.crypto.decrypt(r.snapshot_enc)));
    const [flow]=r.flow_case_id?await this.ds.query('SELECT run_id FROM after_sales_cases WHERE company_id=? AND id=?',[u.companyId,r.flow_case_id]):[];
    return {id:r.id,storeId:r.store_id,storeName:store?.title??snapshot.fields['店铺']??'',version:r.version,snapshot,progress,ownerId:r.owner_id,ownerName:owner?.name??'',nextAt:r.next_at,updatedAt:r.updated_at,
      priority:r.priority,rowColor:r.row_color,report:r.report_enc?this.crypto.decrypt(r.report_enc):'',flowRunId:flow?.run_id??null,sourceSeenAt:r.source_seen_at,
      closed,workspaceState:r.workspace_state,nextEventsBefore,
      canCloseTear:r.workspace_state==='tear'&&(await this.warehouseMembers(this.ds.manager,u.companyId)).some(member=>member.id===u.id),
      pendingFileIds:fileIds(r.attachments).length?await this.pendingEvidence(this.ds.manager,u,id):[],
      events:events.map(e=>{
        const {content,actorName}=this.readEvent(e);
        const entry={id:e.id,kind:e.kind,createdAt:e.createdAt,actorName,actorId:e.actorId};
        if(e.kind==='snapshot')return {...entry,content:'首次采集聚水潭售后资料'};
        if(e.kind==='activity'){
          const action=DESKTOP_SALE_CLICK_LABELS[content as DesktopSaleClick]??'售后操作';
          return {...entry,action,content:''};
        }
        if(e.kind==='tear_sent')return {...entry,content,action:'转仓储部撕单'};
        if(e.kind==='notice_sent')return {...entry,content,action:'发送协作通知'};
        if(e.kind==='reply'||e.kind==='tear_reply')return {...entry,kind:'follow',content,
          action:e.kind==='tear_reply'?'回复撕单结果':'回复协作记录'};
        if(e.kind==='report')return {...entry,content,action:'保存跟踪报告'};
        if(e.kind==='source_read')return {...entry,content:'字段无变更'};
        if(e.kind==='follow_entry'){
          const {note,warehouse,...handling}=JSON.parse(content) as Handling;
          return {...entry,kind:'follow',action:warehouse?'回复撕单结果':'保存跟进',content:note,...handling};
        }
        if(e.kind==='close_entry'){
          const {reason,fileIds,warehouse}=JSON.parse(content) as Closing;
          return {...entry,kind:'closed',action:warehouse?'仓储完结':'完结售后',content:reason,fileIds};
        }
        if(e.kind==='evidence'){
          const {name,fileId}=JSON.parse(content) as Evidence;
          return {...entry,kind:'file',action:/^售后-\d+-\d+\.png$/.test(name)?'保存截图':'上传凭证',content:name,fileIds:[fileId]};
        }
        if(e.kind!=='source_change')return {...entry,content};
        const changes=(JSON.parse(content) as DesktopSaleFieldChange[]).filter(change=>Object.hasOwn(snapshot.fields,change.field));
        return {...entry,changes,content:changes.length
          ? '聚水潭资料变更\n'+changes.map(change=>`${change.field}：${change.before||'（空）'} → ${change.after||'（空）'}`).join('\n')
          : '聚水潭资料更新（变更字段未获查看权限）'};
      }),files:[...(await this.files.info(u.companyId,fileIds(r.attachments))).values()]};
  }
  async import(u:AuthUser,storeId:number|null|undefined,input:DesktopSaleSnapshot){
    const snapshot=this.sanitize(input);
    if(!snapshot.internalOrderId)throw new BadRequestException('手动关联店铺前请读取内部订单号');
    if(storeId){const [store]=await this.ds.query(`SELECT id FROM resource_records WHERE company_id=? AND id=? AND type='stores' AND archived_at IS NULL AND status<>'cancelled'`,[u.companyId,storeId]);if(!store)throw new BadRequestException('请选择本公司的有效店铺');}
    const id=await this.ds.transaction(em=>this.ingestIn(em,u,storeId??null,snapshot));return this.detail(u,id);
  }
  async refreshSource(u:AuthUser,id:number,snapshot:DesktopSaleSnapshot){
    await this.ds.transaction(async em=>{
      const row=await this.row(em,u,id,true);
      if(snapshot.afterSaleId!==row.after_sale_id||ordersConflict(row.internal_order_id,snapshot.internalOrderId)||snapshot.sourceCompany.trim()!==row.source_company)
        throw new BadRequestException('聚水潭查询结果与当前售后不一致');
      await this.ingestIn(em,u,null,snapshot);
    });
    return this.detail(u,id);
  }
  /** Used inside the latest-collection lease transaction as well as local history reads. */
  async ingestIn(em:EntityManager,u:AuthUser,storeId:number|null,input:DesktopSaleSnapshot){
      const snapshot=this.sanitize(input);
      // Unique key serializes simultaneous first imports without overwriting a different store/order.
      await em.query(`INSERT INTO desktop_after_sales (company_id,store_id,source_company,after_sale_id,internal_order_id,snapshot_enc,progress_enc,attachments,created_by,application_at,source_seen_at,workspace_state) VALUES (?,?,?,?,?,?,?,JSON_ARRAY(),?,?,CURRENT_TIMESTAMP(3),'open') ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,[u.companyId,storeId,snapshot.sourceCompany,snapshot.afterSaleId,snapshot.internalOrderId,this.crypto.encrypt(JSON.stringify(snapshot)),this.crypto.encrypt(''),u.id,applicationAt(snapshot)]);
      const [r]:StoredRow[]=await em.query(`SELECT * FROM desktop_after_sales WHERE company_id=? AND source_company=? AND after_sale_id=? FOR UPDATE`,[u.companyId,snapshot.sourceCompany,snapshot.afterSaleId]);
      if((r.store_id&&storeId&&r.store_id!==storeId)||ordersConflict(r.internal_order_id,snapshot.internalOrderId))throw new ConflictException('此售后已关联另一店铺或订单，请核对后再读取');
      const prior:DesktopSaleSnapshot=JSON.parse(this.crypto.decrypt(r.snapshot_enc));
      if(Date.parse(snapshot.capturedAt)<Date.parse(prior.capturedAt)){
        if(storeId&&!r.store_id)await em.query('UPDATE desktop_after_sales SET store_id=? WHERE company_id=? AND id=?',[storeId,u.companyId,r.id]);
        return r.id;
      }
      // Missing sections in a newly opened frame must not erase previously captured detail.
      const merged={...snapshot,internalOrderId:r.internal_order_id||snapshot.internalOrderId,fields:{...prior.fields,...snapshot.fields}};
      const changes=sourceChanges(prior,merged);
      if(r.workspace_state==='closed'||r.workspace_state===null){
        const incoming=applicationAt(snapshot);
        const previous=applicationAt(prior);
        const closing=await this.closingEvent(em,u,r.id);
        if(incoming&&closing&&incoming>closing.createdAt&&(!previous||incoming>previous)){
          await em.query(
            "UPDATE desktop_after_sales SET workspace_state='open',progress_enc=?,owner_id=NULL,next_at=NULL,reminder_at=NULL,reminder_user_id=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP(3) WHERE company_id=? AND id=?",
            [this.crypto.encrypt(''),u.companyId,r.id],
          );
          await this.event(em,u,r.id,'follow','聚水潭出现新的售后申请，已重新进入待处理。');
        }
      }
      await em.query('UPDATE desktop_after_sales SET snapshot_enc=?,internal_order_id=?,store_id=COALESCE(store_id,?),application_at=?,source_seen_at=CURRENT_TIMESTAMP(3) WHERE company_id=? AND id=?',[this.crypto.encrypt(JSON.stringify(merged)),merged.internalOrderId,storeId,applicationAt(merged),u.companyId,r.id]);
      const [hasEvent]=await em.query('SELECT id FROM desktop_after_sales_events WHERE company_id=? AND sale_id=? LIMIT 1',[u.companyId,r.id]);
      const capturedAt=new Date(snapshot.capturedAt);
      const readAt=capturedAt.getUTCFullYear()>=1000&&capturedAt.getUTCFullYear()<=9999?capturedAt:null;
      if(!hasEvent)await this.event(em,u,r.id,'snapshot',JSON.stringify(merged),readAt);
      else if(changes.length)await this.event(em,u,r.id,'source_change',JSON.stringify(changes),readAt);
      else if(Date.parse(snapshot.capturedAt)>Date.parse(prior.capturedAt))await this.event(em,u,r.id,'source_read','',readAt);
      return r.id;
  }
  async metadata(u:AuthUser,id:number,b:{version:number;priority:number;rowColor:string|null;report:string}){
    await this.ds.transaction(async em=>{
      const r=await this.row(em,u,id,true);if(r.version!==b.version)throw new ConflictException('档案已被更新，请刷新后重试');
      await em.query('UPDATE desktop_after_sales SET priority=?,row_color=?,report_enc=?,version=version+1,updated_at=CURRENT_TIMESTAMP(3) WHERE company_id=? AND id=?',[b.priority,b.rowColor??null,this.crypto.encrypt(b.report),u.companyId,id]);
      await this.event(em,u,id,'report',r.report_enc&&this.crypto.decrypt(r.report_enc)===b.report?'调整紧急度或行颜色':'更新跟踪报告\n'+b.report);
    });return this.detail(u,id);
  }
  async appendRecordIn(em:EntityManager,u:AuthUser,id:number,content:string,kind:'follow'|'notice_sent'='follow'){
    await this.event(em,u,id,kind,content);
  }
  async recordActivity(u:AuthUser,id:number,click:DesktopSaleClick){
    if(!Object.hasOwn(DESKTOP_SALE_CLICK_LABELS,click))throw new BadRequestException('未知售后操作');
    await this.assertAccess(u,id);
    const createdAt=new Date();
    const eventId=await this.event(this.ds.manager,u,id,'activity',click,createdAt);
    return {id:eventId,kind:'activity',actorId:u.id,actorName:u.name,createdAt,action:DESKTOP_SALE_CLICK_LABELS[click],content:''};
  }
  async record(u:AuthUser,id:number,content:string){
    await this.assertAccess(u,id,true);
    if(!content.trim()||content.length>4000)throw new BadRequestException('处理记录必填，不超过4000字');
    await this.ds.transaction(async em=>{
      const sale=await this.row(em,u,id,true);
      if(sale.workspace_state==='closed')throw new ConflictException('这笔售后已完结');
      await this.event(em,u,id,sale.workspace_state==='tear'?'tear_reply':'reply',content.trim());
    });
    return this.detail(u,id);
  }
  private async event(em:EntityManager,u:AuthUser,id:number,kind:string,content:string,occurredAt:Date|null=null){
    const encrypted=this.crypto.encrypt(AUDIT_PREFIX+JSON.stringify({content,actorName:u.name??''}));
    const result:{insertId:number}=await em.query(
      'INSERT INTO desktop_after_sales_events(company_id,sale_id,kind,content_enc,actor_id,created_at) VALUES(?,?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP(3)))',
      [u.companyId,id,kind,encrypted,u.id,occurredAt],
    );
    return result.insertId;
  }
  private async warehouseMembers(em:EntityManager,companyId:number):Promise<Array<{id:number}>>{
    return em.query(
      "WITH RECURSIVE warehouse AS (SELECT id FROM departments WHERE company_id=? AND name='仓储部' AND status='active' UNION DISTINCT SELECT d.id FROM departments d JOIN warehouse w ON d.parent_id=w.id WHERE d.company_id=? AND d.status='active') SELECT u.id FROM users u JOIN warehouse w ON u.department_id=w.id WHERE u.company_id=? AND u.status='active' ORDER BY u.id",
      [companyId,companyId,companyId],
    );
  }
  async tear(u:AuthUser,id:number,version:number){
    let recipients=0,assistantQueued=0;
    await this.ds.transaction(async em=>{
      const record=await this.row(em,u,id,true);
      if(record.workspace_state==='tear')return;
      if(record.workspace_state==='closed')throw new ConflictException('这笔售后已完结');
      if(record.version!==version)throw new ConflictException('档案已被更新，请刷新后重试');
      const people=await this.warehouseMembers(em,u.companyId);
      if(!people.length)throw new BadRequestException('没有找到仓储部的在职人员，请先核对 OA 部门及人员');
      const link=DESKTOP_AFTER_SALES_ROUTES.shared.replace(':id',String(id));
      for(const person of people){
        await this.grantFollowAccess(em,u.companyId,id,person.id,u.id);
        const notice=await writeNotification(em,{
          companyId:u.companyId,userId:person.id,kind:'after_sales',title:'售后 '+record.after_sale_id+' 待仓储部撕单',
          body:'内部订单 '+(record.internal_order_id||'待补齐')+'。请打开售后协作页，处理后记录结果并完结。',
          link,
        });
        assistantQueued+=Number(notice.feishuQueued);
      }
      recipients=people.length;
      await em.query(
        "UPDATE desktop_after_sales SET workspace_state='tear',progress_enc=?,next_at=NULL,reminder_at=NULL,reminder_user_id=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP(3) WHERE company_id=? AND id=?",
        [this.crypto.encrypt('等待仓储部撕单'),u.companyId,id],
      );
      await this.event(em,u,id,'tear_sent','已通知仓储部撕单（'+recipients+' 人）。');
    });
    return {archive:await this.detail(u,id),recipients,assistantQueued};
  }
  private async pendingEvidence(em:EntityManager,u:AuthUser,id:number){
    const evidence:{content_enc:string}[]=await em.query(
      "SELECT content_enc FROM desktop_after_sales_events WHERE company_id=? AND sale_id=? AND actor_id=? AND kind='evidence' AND id>COALESCE((SELECT MAX(id) FROM desktop_after_sales_events WHERE company_id=? AND sale_id=? AND actor_id=? AND kind IN ('follow_entry','close_entry')),0) ORDER BY id",
      [u.companyId,id,u.id,u.companyId,id,u.id],
    );
    return evidence.map(item=>(JSON.parse(this.readEvent(item).content) as Evidence).fileId);
  }
  async follow(u:AuthUser,id:number,b:FollowInput){
    if(!b.note.trim())throw new BadRequestException('请填写本次处理记录');
    return this.saveFollow(u,id,b);
  }
  async close(u:AuthUser,id:number,b:FollowInput & {reason:string}){
    const reason=b.reason.trim();
    if(!reason||reason.length>1000)throw new BadRequestException('请填写完结理由，最多1000字');
    return this.saveFollow(u,id,b,reason);
  }
  async closeTear(u:AuthUser,id:number,b:{version:number;note:string;reason:string}){
    await this.assertAccess(u,id,true);
    const reason=b.reason.trim();
    if(!reason||reason.length>1000)throw new BadRequestException('请填写完结理由，最多1000字');
    return this.saveFollow(u,id,{...b,progress:'已撕单'},reason,true);
  }
  private async saveFollow(u:AuthUser,id:number,b:FollowInput,reason?:string,warehouseOnly=false){
    await this.ds.transaction(async em=>{
      const r=await this.row(em,u,id,true);
      if(r.workspace_state==='closed')throw new ConflictException('这笔售后已完结');
      if(r.version!==b.version)throw new ConflictException('档案已被更新，请刷新后重试，填写的内容会保留');
      if(warehouseOnly){
        const members=await this.warehouseMembers(em,u.companyId);
        if(r.workspace_state!=='tear'||!members.some(member=>member.id===u.id))
          throw new ForbiddenException('只有仓储部可从协作页完结待撕单售后');
      }
      const ownerId=warehouseOnly?r.owner_id:b.ownerId??null;
      const [owner]=ownerId&&!warehouseOnly?await em.query(
        "SELECT target.name FROM users target JOIN users actor ON actor.company_id=target.company_id AND actor.id=? WHERE target.company_id=? AND target.id=? AND target.status='active' AND (target.id=actor.id OR target.id=? OR target.department_id=actor.department_id)",
        [u.id,u.companyId,ownerId,r.owner_id],
      ):[];
      if(!warehouseOnly&&ownerId&&!owner)throw new BadRequestException('请选择本公司同部门的在职跟进人');
      const nextAt=reason?null:b.nextAt??null;
      const dueAt=nextAt?new Date(nextAt):null;
      const progress=reason?'已完结':b.progress;
      await em.query(
        'UPDATE desktop_after_sales SET workspace_state=?,progress_enc=?,owner_id=?,next_at=?,reminder_at=?,reminder_user_id=?,version=version+1,updated_at=CURRENT_TIMESTAMP(3) WHERE company_id=? AND id=?',
        [reason?'closed':r.workspace_state,this.crypto.encrypt(progress),ownerId,dueAt,dueAt,dueAt?ownerId??u.id:null,u.companyId,id],
      );
      const fileIds=await this.pendingEvidence(em,u,id);
      const note=b.note.trim();
      if(note){
        const entry:Handling={warehouse:warehouseOnly,note,nextAt,nextOwnerName:owner?.name??(nextAt?u.name:''),fileIds};
        await this.event(em,u,id,'follow_entry',JSON.stringify(entry));
      }
      if(reason){
        const entry:Closing={warehouse:warehouseOnly,reason,fileIds:note?[]:fileIds};
        await this.event(em,u,id,'close_entry',JSON.stringify(entry));
      }
    });
    return this.detail(u,id);
  }
  private async grantFollowAccess(em:EntityManager,companyId:number,saleId:number,userId:number,grantedBy:number){
    await em.query(
      'INSERT INTO desktop_after_sales_grants(company_id,sale_id,user_id,granted_by,can_write) VALUES(?,?,?,?,1) ON DUPLICATE KEY UPDATE can_write=1',
      [companyId,saleId,userId,grantedBy],
    );
  }
  async dispatchFollowReminders(now=new Date()){
    await this.ds.transaction(async em=>{
      const due:{id:number;company_id:number;after_sale_id:string;reminder_user_id:number;created_by:number}[]=await em.query(
        'SELECT id,company_id,after_sale_id,reminder_user_id,created_by FROM desktop_after_sales WHERE reminder_at<=? ORDER BY reminder_at,id LIMIT 50 FOR UPDATE SKIP LOCKED',
        [now],
      );
      for(const sale of due){
        const [recipient]=await em.query("SELECT id FROM users WHERE company_id=? AND id=? AND status='active'",[sale.company_id,sale.reminder_user_id]);
        if(recipient){
          await this.grantFollowAccess(em,sale.company_id,sale.id,recipient.id,sale.created_by);
          await em.insert(Notification,{
            companyId:sale.company_id,userId:recipient.id,kind:'after_sales',
            title:'售后 '+sale.after_sale_id+' 到了跟进时间',
            body:'请打开售后档案查看上一条处理记录。',
            link:DESKTOP_AFTER_SALES_ROUTES.shared.replace(':id',String(sale.id)),
          });
        }
        await em.query('UPDATE desktop_after_sales SET reminder_at=NULL,reminder_user_id=NULL WHERE company_id=? AND id=?',[sale.company_id,sale.id]);
      }
    });
  }
  async upload(u:AuthUser,id:number,file:UploadedFile|undefined){
    await this.row(this.ds.manager,u,id);
    const info=await this.files.putBlob(u.companyId,u.id,FILE_TYPE,'attachments',file);
    try {await this.ds.transaction(async em=>{
      const r=await this.row(em,u,id,true);const ids=fileIds(r.attachments);
      if(ids.length>=50)throw new BadRequestException('每个售后最多50个附件');
      await this.files.bind(em,u.companyId,id,[info.id]);
      await em.query('UPDATE desktop_after_sales SET attachments=?,version=version+1,updated_at=CURRENT_TIMESTAMP(3) WHERE company_id=? AND id=?',[JSON.stringify([...ids,info.id]),u.companyId,id]);
      const evidence:Evidence={name:info.name,fileId:info.id};
      await this.event(em,u,id,'evidence',JSON.stringify(evidence));
    });} catch(e) {
      const row=await this.ds.manager.findOne(ResourceFile,{where:{id:info.id,companyId:u.companyId,resourceType:FILE_TYPE}});
      if(row&&row.resourceId===null){await this.ds.manager.delete(ResourceFile,{id:row.id,companyId:u.companyId});await this.files.deleteObjects(u.companyId,[row.storageKey]);}
      throw e;
    }return this.detail(u,id);
  }
  async fileUrl(u:AuthUser,id:number,fileId:number){const r=await this.row(this.ds.manager,u,id);if(!fileIds(r.attachments).includes(fileId))throw new NotFoundException('附件不存在');return this.files.urlOf(u.companyId,fileId,FILE_TYPE);}
}
