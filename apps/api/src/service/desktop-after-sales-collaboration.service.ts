import {BadRequestException,ConflictException,Injectable} from '@nestjs/common';
import {InjectDataSource} from '@nestjs/typeorm';
import {DataSource} from 'typeorm';
import {DESKTOP_AFTER_SALES_ROUTES} from '@kudesi/shared';
import {type AuthUser} from '../common/auth.decorators';
import {writeNotification} from '../outbox/write-notification';
import {DesktopAfterSalesService} from './desktop-after-sales.service';
import {AfterSalesService} from './after-sales.service';

@Injectable()
export class DesktopAfterSalesCollaborationService {
 constructor(@InjectDataSource()private readonly ds:DataSource,private readonly archives:DesktopAfterSalesService,private readonly cases:AfterSalesService){}
 async share(u:AuthUser,id:number,recipients:number[],message:string,canWrite:boolean){
  await this.archives.assertAccess(u,id,true);
  const ids=[...new Set(recipients)];if(!ids.length||ids.length>20)throw new BadRequestException('请选择1至20名协作人');
  let assistantQueued=0;
  const recipientNames:string[]=[];
  await this.ds.transaction(async em=>{
   const [sale]=await em.query('SELECT after_sale_id,internal_order_id FROM desktop_after_sales WHERE company_id=? AND id=? FOR UPDATE',[u.companyId,id]);
   if(!sale)throw new BadRequestException('售后不存在');
   for(const uid of ids){
    const [person]=await em.query("SELECT id,name FROM users WHERE company_id=? AND id=? AND status='active'",[u.companyId,uid]);
    if(!person)throw new BadRequestException('协作人必须是本公司在职人员');
    await em.query(`INSERT INTO desktop_after_sales_grants(company_id,sale_id,user_id,granted_by,can_write) VALUES(?,?,?,?,?)
     ON DUPLICATE KEY UPDATE can_write=GREATEST(can_write,VALUES(can_write)),granted_by=VALUES(granted_by)`,[u.companyId,id,uid,u.id,canWrite?1:0]);
    const notice=await writeNotification(em,{companyId:u.companyId,userId:uid,kind:'after_sales',title:`${u.name} 邀请你协作处理售后 ${sale.after_sale_id}`.slice(0,200),body:message.slice(0,500)||'请查看该售后的资料、处理记录和跟踪报告。',link:DESKTOP_AFTER_SALES_ROUTES.shared.replace(':id',String(id))});
    assistantQueued+=Number(notice.feishuQueued);
    recipientNames.push(person.name);
   }
   await this.archives.appendRecordIn(em,u,id,'通知对象：'+recipientNames.join('、')+'\n'+message,'notice_sent');
  });
  return {shared:ids.length,assistantQueued};
 }
 async startFlow(u:AuthUser,id:number,b:{caseType:string;amountCents:number;reason:string}){
  await this.archives.assertAccess(u,id,true);const sale=await this.archives.detail(u,id);
  if(sale.flowRunId)return {runId:sale.flowRunId};
  if(!sale.storeId)throw new BadRequestException('发起流程前请先关联本公司的OA店铺');
  const order=sale.snapshot.fields['线上订单号']?.replace(/\s/g,'').match(/\d{4,80}/)?.[0]??sale.snapshot.internalOrderId;
  const created=await this.cases.create(u,{storeId:sale.storeId,orderNo:order,caseType:b.caseType,amountCents:b.amountCents,reason:b.reason,requestKey:`desktop_sale_flow_${id}`});
  await this.ds.transaction(async em=>{
   const [r]=await em.query('SELECT flow_case_id FROM desktop_after_sales WHERE company_id=? AND id=? FOR UPDATE',[u.companyId,id]);
   if(r.flow_case_id&&r.flow_case_id!==created.id)throw new ConflictException('此售后已有协同流程，请刷新');
   await em.query('UPDATE desktop_after_sales SET flow_case_id=? WHERE company_id=? AND id=?',[created.id,u.companyId,id]);
  });return {runId:created.runId};
 }
}
