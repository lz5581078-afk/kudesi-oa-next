import {ConflictException} from '@nestjs/common';
import {EntityManager,In} from 'typeorm';
import {FlowCc,FlowEvent,FlowRun,FlowStep,Notification,OutboxJob,SupervisionException,TaskDelayRequest,WorkItem} from '../entities';
/** All callers have locked the company and every member run and verified the adapter's deletion policy. */
export async function deleteApplicationRecords(em:EntityManager,companyId:number,ref:string,runs:FlowRun[]){
 const ids=runs.map(run=>run.id),safeIds=ids.length?ids:[0];
 const links=[...ids.flatMap(id=>[`/workbench/todos?run=${id}`,`/workbench/started?run=${id}`,`/flow/overview?run=${id}`]),`/workbench/todos?batch=${ref}`,`/workbench/started?batch=${ref}`];
 const notices=await em.find(Notification,{where:{companyId,link:In(links)},lock:{mode:'pessimistic_write'}}),noticeIds=notices.map(notice=>notice.id),safeNoticeIds=noticeIds.length?noticeIds:[0];
 const jobs=await em.createQueryBuilder(OutboxJob,'job').where('job.companyId=:companyId',{companyId}).andWhere("((job.resourceType=:resource AND job.resourceId IN (:...ids)) OR JSON_EXTRACT(job.payloadJson,'$.runId') IN (:...ids) OR JSON_EXTRACT(job.payloadJson,'$.notificationId') IN (:...noticeIds))",{resource:'flow-run',ids:safeIds,noticeIds:safeNoticeIds}).orderBy('job.id','ASC').setLock('pessimistic_write').getMany();
 if(jobs.some(job=>job.status==='sending'))throw new ConflictException('申请通知正在发送，请稍后刷新重试');
 const cancelled=jobs.filter(job=>job.status==='pending'||job.status==='failed');for(const job of cancelled)await em.update(OutboxJob,{companyId,id:job.id,status:job.status},{status:'cancelled'});
 const referenced=jobs.map(job=>Number(job.payloadJson.notificationId)).filter(id=>Number.isSafeInteger(id)&&id>0);if(referenced.length)await em.delete(Notification,{companyId,id:In(referenced)});if(noticeIds.length)await em.delete(Notification,{companyId,id:In(noticeIds)});
 if(ids.length){
  const work=await em.find(WorkItem,{where:{companyId,runId:In(ids)},lock:{mode:'pessimistic_write'}}),workIds=work.map(item=>item.id);
  if(workIds.length){await em.delete(TaskDelayRequest,{companyId,workItemId:In(workIds)});await em.delete(SupervisionException,{companyId,sourceType:'task',sourceId:In(workIds)});}
  await em.delete(SupervisionException,{companyId,runId:In(ids)});await em.delete(WorkItem,{companyId,runId:In(ids)});await em.delete(FlowCc,{companyId,runId:In(ids)});await em.delete(FlowEvent,{companyId,runId:In(ids)});await em.delete(FlowStep,{companyId,runId:In(ids)});await em.delete(FlowRun,{companyId,id:In(ids)});
 }
 return {cancelledJobIds:cancelled.map(job=>job.id),retainedSentJobIds:jobs.filter(job=>job.status==='done').map(job=>job.id)};
}
