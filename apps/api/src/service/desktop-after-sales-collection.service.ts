import {BadRequestException,ConflictException,ForbiddenException,Injectable,NotFoundException} from '@nestjs/common';
import {InjectDataSource} from '@nestjs/typeorm';
import {createHash,randomUUID} from 'crypto';
import {DataSource,EntityManager} from 'typeorm';
import {type DesktopSaleSnapshot} from '@kudesi/shared';
import {type AuthUser} from '../common/auth.decorators';
import {CryptoService} from '../common/crypto.service';
import {DesktopAfterSalesService} from './desktop-after-sales.service';
import {applicationAt,collectionHealth} from './desktop-after-sales-domain';
type Source={id:number;source_company:string;enabled:number;interval_seconds:number;last_success_at:Date|null;last_client_seen_at:Date|null;last_failure_at:Date|null;last_error_enc:string|null;lease_client:string|null;lease_user_id:number|null;lease_hash:string|null;lease_started_at:Date|null;lease_until:Date|null;query_from:Date|null;query_until:Date|null;watermark_at:Date|null;next_query_at:Date|null;failure_count:number;collected_count:number;next_page:number};
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** One latest-data round per source. Clients take over expired rounds, never split history/page jobs. */
@Injectable()
export class DesktopAfterSalesCollectionService {
 constructor(@InjectDataSource()private readonly ds:DataSource,private readonly crypto:CryptoService,private readonly archives:DesktopAfterSalesService){}
 private async source(em:EntityManager,u:AuthUser,id:number,lock=false):Promise<Source>{
  const [r]=await em.query(`SELECT * FROM desktop_after_sales_sources WHERE company_id=? AND id=? ${lock?'FOR UPDATE':''}`,[u.companyId,id]);
  if(!r)throw new NotFoundException('采集来源不存在');return r;
 }
 async list(u:AuthUser){
  const rows:Source[]=await this.ds.query('SELECT * FROM desktop_after_sales_sources WHERE company_id=? ORDER BY id',[u.companyId]);
  return rows.map(r=>({id:r.id,sourceCompany:r.source_company,enabled:!!r.enabled,intervalSeconds:r.interval_seconds,
   health:collectionHealth(r),lastSuccessAt:r.last_success_at,lastFailureAt:r.last_failure_at,
   lastError:r.last_error_enc?this.crypto.decrypt(r.last_error_enc):r.query_from&&r.lease_until&&r.lease_until<new Date()?'采集客户端已中断，等待其他客户端接续':collectionHealth(r)==='waiting'?'未检测到在线采集客户端，请检查客户端是否退出、休眠、断网或未登录':null,leaseUntil:r.lease_until,collectedCount:Number(r.collected_count),page:r.next_page}));
 }
 async configure(u:AuthUser,b:{sourceCompany:string;enabled:boolean;intervalSeconds:number}){
  const name=b.sourceCompany.trim();if(!name)throw new BadRequestException('请确认聚水潭公司');
  return this.ds.transaction(async em=>{
   const [existing]=await em.query('SELECT enabled,interval_seconds,created_by FROM desktop_after_sales_sources WHERE company_id=? AND source_company=? FOR UPDATE',[u.companyId,name]);
   if(existing&&(!!existing.enabled!==b.enabled||existing.interval_seconds!==b.intervalSeconds)&&!u.permissions.isCompanyAdmin&&existing.created_by!==u.id)throw new ForbiddenException('只有管理员或采集来源创建人可以调整公司采集开关和频率');
   await em.query(`INSERT INTO desktop_after_sales_sources(company_id,source_company,enabled,interval_seconds,created_by) VALUES(?,?,?,?,?)
    ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),interval_seconds=VALUES(interval_seconds),updated_at=CURRENT_TIMESTAMP(3)`,[u.companyId,name,b.enabled?1:0,b.intervalSeconds,u.id]);
   // Stopping invalidates the active lease atomically. Its late response cannot re-enable the source.
   if(!b.enabled)await em.query(`UPDATE desktop_after_sales_sources SET lease_hash=NULL,lease_until=NULL,lease_client=NULL,lease_user_id=NULL WHERE company_id=? AND source_company=?`,[u.companyId,name]);
   const [r]=await em.query('SELECT id FROM desktop_after_sales_sources WHERE company_id=? AND source_company=?',[u.companyId,name]);return {id:r.id};
  });
 }
 async claim(u:AuthUser,id:number,clientId:string){
  return this.ds.transaction(async em=>{
   const r=await this.source(em,u,id,true),now=new Date();
   await em.query('UPDATE desktop_after_sales_sources SET last_client_seen_at=? WHERE company_id=? AND id=?',[now,u.companyId,id]);
   if(!r.enabled||(r.lease_until&&r.lease_until>now)||(r.next_query_at&&r.next_query_at>now))return null;
   const token=randomUUID(),expires=new Date(now.getTime()+90000);
   if(r.lease_hash&&r.lease_until&&r.lease_until<=now&&r.query_from&&!r.last_error_enc){
    await em.query('UPDATE desktop_after_sales_sources SET last_failure_at=?,last_error_enc=? WHERE company_id=? AND id=?',[now,this.crypto.encrypt('前一客户端已中断，正在接续；完成后恢复正常'),u.companyId,id]);
   }
   // Recover the same unfinished latest round after a failure, not a separate page assignment.
   const from=r.query_from??new Date((r.watermark_at??new Date(now.getTime()-86400000)).getTime()-600000);
   const until=r.query_until??now;
   await em.query(`UPDATE desktop_after_sales_sources SET lease_client=?,lease_user_id=?,lease_hash=?,lease_started_at=?,lease_until=?,query_from=?,query_until=?,updated_at=? WHERE company_id=? AND id=?`,[clientId,u.id,digest(token),now,expires,from,until,now,u.companyId,id]);
   return {sourceId:id,sourceCompany:r.source_company,token,from:from.toISOString(),until:until.toISOString(),expiresAt:expires.toISOString(),page:r.next_page};
  });
 }
 private async lease(em:EntityManager,u:AuthUser,id:number,token:string){
  const r=await this.source(em,u,id,true),now=new Date();
  if(!r.enabled||r.lease_user_id!==u.id||r.lease_hash!==digest(token)||!r.lease_until||r.lease_until<=now||!r.lease_started_at||now.getTime()-r.lease_started_at.getTime()>600000)throw new ConflictException('采集租约已停止或过期，请重新领取最新轮次');
  return r;
 }
 async heartbeat(u:AuthUser,id:number,token:string){
  return this.ds.transaction(async em=>{await this.lease(em,u,id,token);const expires=new Date(Date.now()+90000);await em.query('UPDATE desktop_after_sales_sources SET lease_until=?,last_client_seen_at=? WHERE company_id=? AND id=?',[expires,new Date(),u.companyId,id]);return {expiresAt:expires.toISOString()};});
 }
 async commit(u:AuthUser,id:number,b:{token:string;records:DesktopSaleSnapshot[];page:number;completed:boolean}){
  return this.ds.transaction(async em=>{
   const r=await this.lease(em,u,id,b.token);
   if(b.page!==r.next_page)throw new ConflictException('采集页次已提交或发生变化');
   for(const s of b.records){
    if(s.sourceCompany.trim()!==r.source_company)throw new BadRequestException('聚水潭公司已切换，本轮采集停止');
    const at=applicationAt(s);
    if(!at||!r.query_from||!r.query_until||at<r.query_from||at.getTime()>r.query_until.getTime()+1000)throw new BadRequestException('最新采集只能提交本轮时间范围的数据；历史售后请在本机查询');
    await this.archives.ingestIn(em,u,null,s);
   }
   await em.query(`UPDATE desktop_after_sales_sources SET next_page=next_page+1,collected_count=collected_count+? WHERE company_id=? AND id=?`,[b.records.length,u.companyId,id]);
   if(b.completed){
    await em.query(`UPDATE desktop_after_sales_sources SET last_success_at=?,watermark_at=query_until,
     query_from=NULL,query_until=NULL,next_page=1,last_error_enc=NULL,failure_count=0,
     next_query_at=?,
     lease_hash=NULL,lease_until=NULL,lease_client=NULL,lease_user_id=NULL,updated_at=? WHERE company_id=? AND id=?`,[new Date(),new Date(Date.now()+r.interval_seconds*1000),new Date(),u.companyId,id]);
   }
   return {received:b.records.length,completed:b.completed};
  });
 }
 async fail(u:AuthUser,id:number,token:string,message:string){
  return this.ds.transaction(async em=>{
   const r=await this.lease(em,u,id,token);
   const clean=message.replace(/https?:\/\/\S+/gi,'[链接]').replace(/(?:token|password|cookie|authorization)\s*[:=][^\n]+/gi,'[凭据已隐藏]').slice(0,500)||'本轮采集失败';
   const delay=Math.min(300,15*2**Math.min(r.failure_count,5));
   await em.query(`UPDATE desktop_after_sales_sources SET last_failure_at=?,last_error_enc=?,failure_count=failure_count+1,
    next_query_at=?,lease_hash=NULL,lease_until=NULL,lease_client=NULL,lease_user_id=NULL WHERE company_id=? AND id=?`,[new Date(),this.crypto.encrypt(clean),new Date(Date.now()+delay*1000),u.companyId,id]);
   return {retryAfterSeconds:delay};
  });
 }
 /** Explicit reads from this PC, including historical orders. Never advances the latest watermark. */
 async local(u:AuthUser,id:number,records:DesktopSaleSnapshot[]){
  const ids=await this.ds.transaction(async em=>{
   const source=await this.source(em,u,id);
   const result:number[]=[];
   for(const s of records){
    if(s.sourceCompany.trim()!==source.source_company)throw new BadRequestException('聚水潭公司与已确认来源不一致');
    result.push(await this.archives.ingestIn(em,u,null,s));
   }
   return result;
  });
  return {ids};
 }
}
