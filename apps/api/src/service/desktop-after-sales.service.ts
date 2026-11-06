import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AFTER_SALES_FIELDS, AFTER_SALES_PAGE_SIZE, afterSalesCell, createChecker, type AfterSalesColumnFilter, type DesktopSaleListRow, type DesktopSaleSnapshot } from '@kudesi/shared';
import { ResourceFile } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { FilesService, type UploadedFile } from '../integrations/files.service';
import {applicationAt,sourceChanges} from './desktop-after-sales-domain';

const FILE_TYPE = 'desktop-after-sales';
type Row = { id:number; store_id:number|null; source_company:string; after_sale_id:string; internal_order_id:string; snapshot_enc:string; progress_enc:string; owner_id:number|null; next_at:Date|null; version:number; attachments:number[]|string; updated_at:Date; priority:number;row_color:string|null;report_enc:string|null;source_seen_at:Date|null;flow_case_id:number|null };
type ListRow = Row & { storeName: string | null; ownerName: string | null };
const fileIds = (v: Row['attachments']): number[] => typeof v === 'string' ? JSON.parse(v) : v;
/** Local OA follow-up is independent of ERP refund approval. This service never writes to ERP. */
@Injectable()
export class DesktopAfterSalesService {
  constructor(@InjectDataSource() private readonly ds:DataSource, private readonly crypto:CryptoService, private readonly files:FilesService) {}
  async options(u:AuthUser) {
    const stores=await this.ds.query(`SELECT id,title AS name FROM resource_records WHERE company_id=? AND type='stores' AND archived_at IS NULL AND status<>'cancelled' ORDER BY title LIMIT 2000`,[u.companyId]);
    const people=await this.ds.query(`SELECT id,name FROM users WHERE company_id=? AND status='active' ORDER BY name LIMIT 3000`,[u.companyId]);
    return {stores,people};
  }
  async list(u:AuthUser, keyword='', page=1, sort='申请时间', direction='desc', filters:AfterSalesColumnFilter[] = []) {
    const args:unknown[]=[u.companyId];let where='c.company_id=?';
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
    const [r]=await em.query(`SELECT * FROM desktop_after_sales WHERE company_id=? AND id=? ${lock?'FOR UPDATE':''}`,[u.companyId,id]);
    if(!r)throw new NotFoundException('售后档案不存在');return r;
  }
  private sanitize(snapshot:DesktopSaleSnapshot):DesktopSaleSnapshot {
    if(!/^\d{4,40}$/.test(snapshot.afterSaleId) || !/^\d{4,40}$/.test(snapshot.internalOrderId) || !snapshot.sourceCompany.trim())throw new BadRequestException('请读取售后单号、内部订单号，并确认聚水潭公司');
    if(!Number.isFinite(Date.parse(snapshot.capturedAt)))throw new BadRequestException('读取时间无效');
    if(Object.keys(snapshot.fields).some(k=>!AFTER_SALES_FIELDS.includes(k as never)))throw new BadRequestException('包含不支持的网页字段');
    const fields:DesktopSaleSnapshot['fields']={};
    for(const k of AFTER_SALES_FIELDS){
      const value=snapshot.fields[k];if(value===undefined)continue;
      if(typeof value!=='string'||value.length>12000)throw new BadRequestException('网页字段过长');
      fields[k]=value.replace(/https?:\/\/\S+/gi,'[链接已移除]').replace(/(?:jmxToken|access_token|authorization|password|cookie)\s*[:=]\s*[^\n]+/gi,'[凭据已移除]');
    }
    if(JSON.stringify(fields).length>100000)throw new BadRequestException('网页内容过多，请分次读取');
    return {...snapshot,sourceCompany:snapshot.sourceCompany.trim(),fields};
  }
  private project(u:AuthUser,s:DesktopSaleSnapshot){
    const can=createChecker(u.permissions);const fields={...s.fields};
    if(!can('product.cost.view'))delete fields['原订单采购金额'];
    if(!can('product.price.view'))for(const k of ['原订单下单金额','线上申请金额','实退金额','支付金额','商品总成交金额','优惠抵扣金额','运费','应付总金额','实际已付','实际收货金额','商家实退','线上商品应退金额','线上退运费','商品应退金额','优惠/差额','卖家应补','卖家应退运费','换货金额','买家应补','买家退款账号','卖家退款账号'] as const)delete fields[k];
    if(!u.permissions.isCompanyAdmin){delete fields['买家退款账号'];delete fields['卖家退款账号'];}
    // Unstructured goods/log text can contain costs and quoted unit prices.
    if(!can('product.price.view')||!can('product.cost.view')){delete fields['商品信息'];delete fields['商品明细'];delete fields['售后日志'];delete fields['订单操作日志'];}
    return {...s,fields};
  }
  async assertAccess(u:AuthUser,id:number,write=false){
    await this.row(this.ds.manager,u,id);
    if(createChecker(u.permissions)('after-sales.workspace.view'))return;
    const [grant]=await this.ds.query(`SELECT can_write FROM desktop_after_sales_grants WHERE company_id=? AND sale_id=? AND user_id=?`,[u.companyId,id,u.id]);
    if(!grant||(write&&!grant.can_write))throw new ForbiddenException('没有这笔售后的协作权限');
  }
  async detail(u:AuthUser,id:number,before?:number){
    const r=await this.row(this.ds.manager,u,id);
    const [store]=await this.ds.query('SELECT title FROM resource_records WHERE company_id=? AND id=? AND type=\'stores\'',[u.companyId,r.store_id]);
    const [owner]=r.owner_id?await this.ds.query('SELECT name FROM users WHERE company_id=? AND id=?',[u.companyId,r.owner_id]):[];
    const events=await this.ds.query(`SELECT e.id,e.kind,e.content_enc,e.created_at AS createdAt,u.name AS actorName FROM desktop_after_sales_events e LEFT JOIN users u ON u.company_id=e.company_id AND u.id=e.actor_id WHERE e.company_id=? AND e.sale_id=? ${before?'AND e.id<?':''} ORDER BY e.id DESC LIMIT 100`,before?[u.companyId,id,before]:[u.companyId,id]);
    const snapshot=this.project(u,JSON.parse(this.crypto.decrypt(r.snapshot_enc)));
    const [flow]=r.flow_case_id?await this.ds.query('SELECT run_id FROM after_sales_cases WHERE company_id=? AND id=?',[u.companyId,r.flow_case_id]):[];
    return {id:r.id,storeId:r.store_id,storeName:store?.title??snapshot.fields['店铺']??'',version:r.version,snapshot,progress:this.crypto.decrypt(r.progress_enc),ownerId:r.owner_id,ownerName:owner?.name??'',nextAt:r.next_at,updatedAt:r.updated_at,
      priority:r.priority,rowColor:r.row_color,report:r.report_enc?this.crypto.decrypt(r.report_enc):'',flowRunId:flow?.run_id??null,sourceSeenAt:r.source_seen_at,
      nextEventsBefore:events.length===100?events[99].id:null,
      events:events.map((e:{id:number;kind:string;content_enc:string;createdAt:Date;actorName:string})=>{
        let content=e.kind==='snapshot'?'首次采集聚水潭售后资料':this.crypto.decrypt(e.content_enc);
        if(e.kind==='source_change'){
          const changed=JSON.parse(content) as Array<{field:string;before:string;after:string}>;
          const allowed=changed.filter(c=>Object.hasOwn(snapshot.fields,c.field));
          content=allowed.length?'聚水潭资料变更\n'+allowed.map(c=>`${c.field}：${c.before||'（空）'} → ${c.after||'（空）'}`).join('\n'):'聚水潭资料更新（变更字段未获查看权限）';
        }
        return {id:e.id,kind:e.kind,content,createdAt:e.createdAt,actorName:e.actorName};
      }),files:[...(await this.files.info(u.companyId,fileIds(r.attachments))).values()]};
  }
  async import(u:AuthUser,storeId:number|null|undefined,input:DesktopSaleSnapshot){
    const snapshot=this.sanitize(input);
    if(storeId){const [store]=await this.ds.query(`SELECT id FROM resource_records WHERE company_id=? AND id=? AND type='stores' AND archived_at IS NULL AND status<>'cancelled'`,[u.companyId,storeId]);if(!store)throw new BadRequestException('请选择本公司的有效店铺');}
    const id=await this.ds.transaction(em=>this.ingestIn(em,u,storeId??null,snapshot));return this.detail(u,id);
  }
  async refreshSource(u:AuthUser,id:number,snapshot:DesktopSaleSnapshot){
    await this.ds.transaction(async em=>{
      const row=await this.row(em,u,id);
      if(snapshot.afterSaleId!==row.after_sale_id||snapshot.internalOrderId!==row.internal_order_id||snapshot.sourceCompany.trim()!==row.source_company)
        throw new BadRequestException('聚水潭查询结果与当前售后不一致');
      await this.ingestIn(em,u,null,snapshot);
    });
    return this.detail(u,id);
  }
  /** Used inside the latest-collection lease transaction as well as local history reads. */
  async ingestIn(em:EntityManager,u:AuthUser,storeId:number|null,input:DesktopSaleSnapshot){
      const snapshot=this.sanitize(input);
      // Unique key serializes simultaneous first imports without overwriting a different store/order.
      await em.query(`INSERT INTO desktop_after_sales (company_id,store_id,source_company,after_sale_id,internal_order_id,snapshot_enc,progress_enc,attachments,created_by,application_at,source_seen_at) VALUES (?,?,?,?,?,?,?,JSON_ARRAY(),?,?,CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,[u.companyId,storeId,snapshot.sourceCompany,snapshot.afterSaleId,snapshot.internalOrderId,this.crypto.encrypt(JSON.stringify(snapshot)),this.crypto.encrypt(''),u.id,applicationAt(snapshot)]);
      const [r]:Row[]=await em.query(`SELECT * FROM desktop_after_sales WHERE company_id=? AND source_company=? AND after_sale_id=? FOR UPDATE`,[u.companyId,snapshot.sourceCompany,snapshot.afterSaleId]);
      if((r.store_id&&storeId&&r.store_id!==storeId) || r.internal_order_id!==snapshot.internalOrderId)throw new ConflictException('此售后已关联另一店铺或订单，请核对后再读取');
      const prior:DesktopSaleSnapshot=JSON.parse(this.crypto.decrypt(r.snapshot_enc));
      if(Date.parse(snapshot.capturedAt)<Date.parse(prior.capturedAt)){
        if(storeId&&!r.store_id)await em.query('UPDATE desktop_after_sales SET store_id=? WHERE company_id=? AND id=?',[storeId,u.companyId,r.id]);
        return r.id;
      }
      // Missing sections in a newly opened frame must not erase previously captured detail.
      const merged={...snapshot,fields:{...prior.fields,...snapshot.fields}};
      const changes=sourceChanges(prior,merged);
      await em.query('UPDATE desktop_after_sales SET snapshot_enc=?,store_id=COALESCE(store_id,?),application_at=?,source_seen_at=CURRENT_TIMESTAMP(3) WHERE company_id=? AND id=?',[this.crypto.encrypt(JSON.stringify(merged)),storeId,applicationAt(merged),u.companyId,r.id]);
      const [hasEvent]=await em.query('SELECT id FROM desktop_after_sales_events WHERE company_id=? AND sale_id=? LIMIT 1',[u.companyId,r.id]);
      if(!hasEvent)await this.event(em,u,r.id,'snapshot',JSON.stringify(merged));
      else if(changes.length)await this.event(em,u,r.id,'source_change',JSON.stringify(changes));
      return r.id;
  }
  async metadata(u:AuthUser,id:number,b:{version:number;priority:number;rowColor:string|null;report:string}){
    await this.ds.transaction(async em=>{
      const r=await this.row(em,u,id,true);if(r.version!==b.version)throw new ConflictException('档案已被更新，请刷新后重试');
      await em.query('UPDATE desktop_after_sales SET priority=?,row_color=?,report_enc=?,version=version+1,updated_at=CURRENT_TIMESTAMP(3) WHERE company_id=? AND id=?',[b.priority,b.rowColor??null,this.crypto.encrypt(b.report),u.companyId,id]);
      await this.event(em,u,id,'report',r.report_enc&&this.crypto.decrypt(r.report_enc)===b.report?'调整紧急度或行颜色':'更新跟踪报告\n'+b.report);
    });return this.detail(u,id);
  }
  async appendRecordIn(em:EntityManager,u:AuthUser,id:number,content:string){await this.event(em,u,id,'follow',content);}
  async record(u:AuthUser,id:number,content:string){
    await this.assertAccess(u,id,true);
    if(!content.trim()||content.length>4000)throw new BadRequestException('处理记录必填，不超过4000字');
    await this.ds.transaction(async em=>{await this.row(em,u,id,true);await this.event(em,u,id,'follow',content.trim());});return this.detail(u,id);
  }
  private async event(em:EntityManager,u:AuthUser,id:number,kind:string,content:string){await em.query('INSERT INTO desktop_after_sales_events(company_id,sale_id,kind,content_enc,actor_id) VALUES(?,?,?,?,?)',[u.companyId,id,kind,this.crypto.encrypt(content),u.id]);}
  async follow(u:AuthUser,id:number,b:{version:number;progress:string;ownerId?:number|null;nextAt?:string|null;note:string}){
    if(!b.note.trim())throw new BadRequestException('请填写本次处理记录');
    await this.ds.transaction(async em=>{
      const r=await this.row(em,u,id,true);if(r.version!==b.version)throw new ConflictException('档案已被更新，请刷新后重试，填写的内容会保留');
      if(b.ownerId){const [owner]=await em.query(`SELECT id FROM users WHERE company_id=? AND id=? AND status='active'`,[u.companyId,b.ownerId]);if(!owner)throw new BadRequestException('负责人必须是本公司的在职人员');}
      const content=[`处理进度：${b.progress}`,`负责人：${b.ownerId??'未分配'}`,`下次跟进：${b.nextAt??'未设置'}`,b.note].join('\n');
      await em.query('UPDATE desktop_after_sales SET progress_enc=?,owner_id=?,next_at=?,version=version+1,updated_at=CURRENT_TIMESTAMP(3) WHERE company_id=? AND id=?',[this.crypto.encrypt(b.progress),b.ownerId??null,b.nextAt?new Date(b.nextAt):null,u.companyId,id]);
      await this.event(em,u,id,'follow',content);
    });return this.detail(u,id);
  }
  async upload(u:AuthUser,id:number,file:UploadedFile|undefined){
    await this.row(this.ds.manager,u,id);
    const info=await this.files.putBlob(u.companyId,u.id,FILE_TYPE,'attachments',file);
    try {await this.ds.transaction(async em=>{
      const r=await this.row(em,u,id,true);const ids=fileIds(r.attachments);
      if(ids.length>=50)throw new BadRequestException('每个售后最多50个附件');
      await this.files.bind(em,u.companyId,id,[info.id]);
      await em.query('UPDATE desktop_after_sales SET attachments=?,version=version+1,updated_at=CURRENT_TIMESTAMP(3) WHERE company_id=? AND id=?',[JSON.stringify([...ids,info.id]),u.companyId,id]);
      await this.event(em,u,id,'file',`上传附件：${info.name}`);
    });} catch(e) {
      const row=await this.ds.manager.findOne(ResourceFile,{where:{id:info.id,companyId:u.companyId,resourceType:FILE_TYPE}});
      if(row&&row.resourceId===null){await this.ds.manager.delete(ResourceFile,{id:row.id,companyId:u.companyId});await this.files.deleteObjects(u.companyId,[row.storageKey]);}
      throw e;
    }return this.detail(u,id);
  }
  async fileUrl(u:AuthUser,id:number,fileId:number){const r=await this.row(this.ds.manager,u,id);if(!fileIds(r.attachments).includes(fileId))throw new NotFoundException('附件不存在');return this.files.urlOf(u.companyId,fileId,FILE_TYPE);}
}
