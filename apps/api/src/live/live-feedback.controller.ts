import { Controller,Get,Param,ParseIntPipe,Post,UploadedFile,UseInterceptors,Injectable } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthenticatedOnly,AuthUser,CurrentUser } from '../common/auth.decorators';
import { FilesService,MAX_UPLOAD_BYTES,sniffFile,type UploadedFile as Upload } from '../integrations/files.service';
import { ResourceFile } from '../entities';
import { LiveSessionService } from './live-session.service';
import { feedbackTargets,LIVE_EVIDENCE_TYPE } from './live-feedback';
import { sessionRow,closedDay,liveFail,liveClock } from './live-core';
import { reportsLocked } from './live-checkin-core';
@Injectable()
export class LiveFeedbackService {
 constructor(@InjectDataSource() private readonly ds:DataSource,private readonly sessions:LiveSessionService,private readonly files:FilesService){}
 async context(user:AuthUser,id:number){
   const detail=await this.sessions.detail(user,id);
   const s=await sessionRow(this.ds.manager,user.companyId,id);
   const own=await this.ds.query('SELECT role,confirmation_json FROM live_session_checkins WHERE company_id=? AND session_id=? AND user_id=?',[user.companyId,id,user.id]);
   if(!own.some((c:any)=>['anchor','control'].includes(c.role)))liveFail('只有本场已上播的主播或中控可以填写下播资料',403);
   return {targets:await feedbackTargets(this.ds.manager,user.companyId,s,user.id),records:detail.checkoutFeedback??[],locked:reportsLocked(s,liveClock.now())||!['live','pending_report','returned'].includes(s.status)};
 }
 async upload(user:AuthUser,id:number,file:Upload|undefined){
   await this.sessions.detail(user,id);
   const s=await sessionRow(this.ds.manager,user.companyId,id);
   const [own]=await this.ds.query("SELECT id FROM live_session_checkins WHERE company_id=? AND session_id=? AND user_id=? AND role='control'",[user.companyId,id,user.id]);
   if(!own||Number(s.control_user_id)!==user.id)liveFail('只有本场已上播中控可上传数据图片',403);
   if(reportsLocked(s,liveClock.now())||!['live','pending_report','returned'].includes(s.status)||await closedDay(this.ds.manager,user.companyId,s.session_day,{sessionId:Number(s.id)}))liveFail('本场已锁定，不能上传图片',409);
   if(!file||!sniffFile(file.buffer)?.image)liveFail('请上传本场直播数据图片（png、jpg、gif、webp）',400);
   const info=await this.files.putBlob(user.companyId,user.id,LIVE_EVIDENCE_TYPE,'evidence',file);
   await this.ds.manager.update(ResourceFile,{id:info.id,companyId:user.companyId,uploadedBy:user.id},{resourceId:id});
   return info;
 }
 async url(user:AuthUser,id:number,fileId:number){
   await this.sessions.detail(user,id);
   const file=await this.ds.manager.findOneBy(ResourceFile,{id:fileId,companyId:user.companyId,resourceType:LIVE_EVIDENCE_TYPE,resourceId:id});
   if(!file)liveFail('本场图片不存在',404);
   return this.files.urlOf(user.companyId,fileId,LIVE_EVIDENCE_TYPE);
 }
}
@Controller('live/sessions')
export class LiveFeedbackController {
 constructor(private readonly feedback:LiveFeedbackService){}
 @AuthenticatedOnly() @Get(':id/checkout-feedback')
 context(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number){return this.feedback.context(u,id);}
 @AuthenticatedOnly() @Post(':id/feedback-images') @UseInterceptors(FileInterceptor('file',{limits:{fileSize:MAX_UPLOAD_BYTES}}))
 upload(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@UploadedFile() f:Upload){return this.feedback.upload(u,id,f);}
 @AuthenticatedOnly() @Get(':id/feedback-images/:fileId/url')
 url(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Param('fileId',ParseIntPipe) fileId:number){return this.feedback.url(u,id,fileId);}
}
