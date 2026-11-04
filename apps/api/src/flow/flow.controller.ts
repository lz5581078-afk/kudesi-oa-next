import {FlowConfirmationDto} from './flow-confirmation.dto';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ValidateNested, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { FlowService } from './flow.service';

class StartDto {
  @IsString() templateKey!: string;
  @IsObject() payload!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(80) requestKey?: string;
}
class DraftDto {
  @IsArray() steps!: never[];
  @IsArray() @IsInt({ each: true }) escalateUserIds!: number[];
  /** 自建模板的表单结构；内置模板不传 */
  @IsOptional() @IsObject() schema?: Record<string, unknown>;
  /** 发起人范围：不传 = 沿用已有的；null / 空 = 不限制 */
  @IsOptional() @IsObject() starterScope?: Record<string, unknown> | null;
}
class ReassignDto {
  @IsInt() @Min(1) fromUserId!: number;
  @IsInt() @Min(1) toUserId!: number;
  @IsOptional() @IsString() @MaxLength(40) templateKey?: string;
  @IsOptional() @IsString() @MaxLength(40) stepKey?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}
class PassDto {
  @IsOptional() @ValidateNested() @Type(()=>FlowConfirmationDto) confirmation?:FlowConfirmationDto;
  @IsInt() revision!: number;
  @IsInt() stepId!: number;
  @IsOptional() @IsObject() form?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}
class StepDraftDto {
  @IsInt() @Min(1) revision!:number;
  @IsInt() @Min(1) stepId!:number;
  @IsOptional() @IsObject() form?:Record<string,unknown>;
  @IsOptional() @IsObject() draftContext?:Record<string,unknown>;
}
class ReasonDto {
  @IsInt() revision!: number;
  @IsInt() stepId!: number;
  @IsString() @MaxLength(500) reason!: string;
}
class WithdrawDto {
  @IsInt() revision!: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class ResubmitDto {
  @IsOptional() @IsString() @MaxLength(500) comment?:string;
  @IsOptional() @ValidateNested() @Type(()=>FlowConfirmationDto) confirmation?:FlowConfirmationDto;
  @IsInt() revision!: number;
  @IsObject() payload!: Record<string, unknown>;
}
class TransferDto {
  @IsInt() revision!: number;
  @IsOptional() @IsInt() stepId?: number;
  @IsInt() toUserId!: number;
  @IsString() @MaxLength(500) reason!: string;
}
class ApplicationDraftVersionDto {
  @IsInt() @Min(1) id!:number;
  @IsInt() @Min(1) revision!:number;
}
class ApplicationDraftCreateDto {
  @IsOptional() @IsObject() confirmations?:Record<string,boolean>;
  @IsString() @MaxLength(40) templateKey!:string;
  @IsInt() @Min(1) definitionId!:number;
  @IsString() @MaxLength(60) requestKey!:string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsObject({each:true}) payloads!:Record<string,unknown>[];
}
class ApplicationDraftSaveDto {
  @IsInt() @Min(1) revision!:number;
  @IsObject() payload!:Record<string,unknown>;
}
class ApplicationDraftSubmitDto {
  @IsOptional() @IsString() @MaxLength(500) comment?:string;
  @IsOptional() @ValidateNested() @Type(()=>FlowConfirmationDto) confirmation?:FlowConfirmationDto;
  @IsInt() @Min(1) revision!:number;
  @IsString() @MaxLength(60) requestKey!:string;
}
class ApplicationDraftSubmitItemDto extends ApplicationDraftVersionDto {
  @IsOptional() @ValidateNested() @Type(()=>FlowConfirmationDto) confirmation?:FlowConfirmationDto;
}
class ApplicationDraftSubmitManyDto {
  @IsOptional() @IsString() @MaxLength(500) comment?:string;
  @IsString() @MaxLength(60) requestKey!:string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({each:true}) @Type(()=>ApplicationDraftSubmitItemDto) items!:ApplicationDraftSubmitItemDto[];
}
class ApplicationDraftStopDto {
 @IsInt() @Min(1) revision!:number;
 @IsIn(['cancel','reject']) kind!:'cancel'|'reject';
 @IsString() @MaxLength(500) reason!:string;
}
class ApplicationDraftDeleteDto {
  @IsInt() @Min(1) revision!:number;
  @IsString() @MaxLength(500) reason!:string;
}
class ApplicationDraftAddDto {
  @IsOptional() @ValidateNested() @Type(()=>ApplicationDraftVersionDto) copySource?:ApplicationDraftVersionDto;
  @IsString() @MaxLength(64) headerVersion!:string;
  @IsString() @MaxLength(60) requestKey!:string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsObject({each:true}) payloads!:Record<string,unknown>[];
}
class ApplicationDraftRemoveBatchDto {
  @IsString() @MaxLength(64) headerVersion!:string;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({each:true}) @Type(()=>ApplicationDraftVersionDto) expected!:ApplicationDraftVersionDto[];
  @IsString() @MaxLength(500) reason!:string;
}
class ApplicationDraftSharedDto {
  @IsString() @MaxLength(64) headerVersion!:string;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({each:true}) @Type(()=>ApplicationDraftVersionDto) expected!:ApplicationDraftVersionDto[];
  @IsObject() payload!:Record<string,unknown>;
}
class RunsQuery {
  @IsOptional() @IsIn(['true','false']) groupSku?:string;
  @IsIn(['started', 'cc', 'all']) view!: 'started' | 'cc' | 'all';
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() templateKey?: string;
  @IsOptional() @IsString() @MaxLength(100) keyword?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() overdue?: boolean;
  /** 发起人所在部门（含下级部门） */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) departmentId?: number;
  /** 当前办理人姓名（模糊） */
  @IsOptional() @IsString() @MaxLength(50) handler?: string;
  /** 只看被退回、等待补充的 */
  @IsOptional() @Type(() => Boolean) @IsBoolean() returned?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
class TodosQuery {
  @IsOptional() @IsIn(['pending', 'overdue', 'returned', 'done']) tab?: 'pending' | 'overdue' | 'returned' | 'done';
  @IsOptional() @IsString() @MaxLength(100) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
class ReadDto { @IsOptional() @IsArray() @IsInt({ each: true }) ids?: number[] }

/** 办理类接口只要登录；真正的资格（这一步有你的待办、是不是发起人）在服务里按令牌身份判断。 */
@Controller('flow')
export class FlowController {
  constructor(private readonly flow: FlowService) {}

  @RequirePermission('flow.apply.view')
  @Get('templates')
  templates(@CurrentUser() user: AuthUser) { return this.flow.templates(user); }

  @RequirePermission('flow.templates.view')
  @Get('definitions/:key')
  definition(@CurrentUser() user: AuthUser, @Param('key') key: string) { return this.flow.definition(user, key); }

  @RequirePermission('flow.templates.view')
  @Put('definitions/:key/draft')
  saveDraft(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() b: DraftDto) { return this.flow.saveDraft(user, key, b.steps as never, b.escalateUserIds, (b.schema as never) ?? null, b.starterScope); }

  @RequirePermission('flow.templates.view')
  @Post('definitions/:key/publish')
  publish(@CurrentUser() user: AuthUser, @Param('key') key: string) { return this.flow.publish(user, key); }

  @RequirePermission('flow.apply.view')
  @Get('application-drafts/templates/:key')
  applicationDraftTemplates(@CurrentUser() user:AuthUser,@Param('key') key:string){return this.flow.applicationDraftTemplates(user,key);}
  @RequirePermission('flow.apply.view')
  @Post('runs/drafts')
  createApplicationDrafts(@CurrentUser() user:AuthUser,@Body() body:ApplicationDraftCreateDto){return this.flow.createApplicationDrafts(user,body);}
  @AuthenticatedOnly()
  @Get('application-drafts/:key/:ref')
  applicationDraftHeader(@CurrentUser() user:AuthUser,@Param('key') key:string,@Param('ref') ref:string){return this.flow.applicationDraftHeader(user,key,ref);}
  @RequirePermission('flow.apply.view')
  @Post('application-drafts/:key/:ref/items')
  addApplicationDrafts(@CurrentUser() user:AuthUser,@Param('key') key:string,@Param('ref') ref:string,@Body() body:ApplicationDraftAddDto){return this.flow.addApplicationDrafts(user,key,ref,body.headerVersion,body.requestKey,body.payloads,body.copySource);}
  @RequirePermission('flow.apply.view')
  @Delete('application-drafts/:key/:ref')
  removeApplicationDraftBatch(@CurrentUser() user:AuthUser,@Param('key') key:string,@Param('ref') ref:string,@Body() body:ApplicationDraftRemoveBatchDto){return this.flow.removeApplicationDraftBatch(user,key,ref,body.headerVersion,body.expected,body.reason);}

  @RequirePermission('flow.apply.view')
  @Put('runs/:id/draft')
  saveApplicationDraft(@CurrentUser() user:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() body:ApplicationDraftSaveDto){return this.flow.saveApplicationDraft(user,id,body.revision,body.payload);}
  @RequirePermission('flow.apply.view')
  @Put('application-drafts/:key/:ref/shared')
  sharedApplicationDraft(@CurrentUser() user:AuthUser,@Param('key') key:string,@Param('ref') ref:string,@Body() body:ApplicationDraftSharedDto){return this.flow.saveApplicationDraftShared(user,key,ref,body.expected,body.payload,body.headerVersion);}
  @RequirePermission('flow.apply.view')
  @Post('application-drafts/:key/:ref/submit')
  @HttpCode(200)
  submitApplicationDrafts(@CurrentUser() user:AuthUser,@Param('key') key:string,@Param('ref') ref:string,@Body() body:ApplicationDraftSubmitManyDto){return this.flow.submitApplicationDrafts(user,key,ref,body.items,body.requestKey,body.comment);}
  @RequirePermission('flow.apply.view')
  @Post('runs/:id/draft/submit')
  submitApplicationDraft(@CurrentUser() user:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() body:ApplicationDraftSubmitDto){return this.flow.submitApplicationDraft(user,id,body.revision,body.requestKey,body.confirmation,body.comment);}
  @RequirePermission('flow.apply.view')
  @Post('runs/:id/draft/stop')
  stopApplicationDraft(@CurrentUser() user:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() body:ApplicationDraftStopDto){return this.flow.stopApplicationDraft(user,id,body.revision,body.kind,body.reason);}
  @RequirePermission('flow.apply.view')
  @Delete('runs/:id/draft')
  removeApplicationDraft(@CurrentUser() user:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() body:ApplicationDraftDeleteDto){return this.flow.removeApplicationDraft(user,id,body.revision,body.reason);}

  @RequirePermission('flow.apply.view')
  @Post('runs')
  start(@CurrentUser() user: AuthUser, @Body() b: StartDto) { return this.flow.start(user, b.templateKey, b.payload, b.requestKey); }

  @AuthenticatedOnly()
  @Get('runs')
  list(@CurrentUser() user: AuthUser, @Query() q: RunsQuery) {
    return this.flow.listRuns(user, { ...(q.groupSku==='true'?{groupSku:true}:{}),view: q.view, status: q.status, templateKey: q.templateKey, keyword: q.keyword, overdue: q.overdue, departmentId: q.departmentId, handler: q.handler, returned: q.returned, page: q.page ?? 1, pageSize: q.pageSize ?? 20 });
  }

  @AuthenticatedOnly()
  @Get('runs/:id')
  detail(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.flow.detail(user, id); }

  @AuthenticatedOnly()
  @Put('runs/:id/step-draft')
  saveStepDraft(@CurrentUser() user:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() body:StepDraftDto){return this.flow.saveStepDraft(user,id,body);}

  @AuthenticatedOnly()
  @Post('runs/:id/pass')
  pass(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: PassDto) { return this.flow.pass(user, id, b); }

  @AuthenticatedOnly()
  @Post('runs/:id/return')
  back(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto) { return this.flow.returnBack(user, id, b); }

  @AuthenticatedOnly()
  @Post('runs/:id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto) { return this.flow.stop(user, id, 'cancel', b); }

  @AuthenticatedOnly()
  @Post('runs/:id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto) { return this.flow.stop(user, id, 'reject', b); }

  @AuthenticatedOnly()
  @Post('runs/:id/abnormal')
  abnormal(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto) { return this.flow.reportAbnormal(user, id, b); }

  @AuthenticatedOnly()
  @Post('runs/:id/withdraw')
  withdraw(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: WithdrawDto) { return this.flow.withdraw(user, id, b); }

  @AuthenticatedOnly()
  @Post('runs/:id/resubmit')
  resubmit(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ResubmitDto) { return this.flow.resubmit(user, id, b); }

  @AuthenticatedOnly()
  @Post('runs/:id/transfer')
  transfer(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: TransferDto) { return this.flow.transfer(user, id, b); }

  @AuthenticatedOnly()
  @Get('todos')
  todos(@CurrentUser() user: AuthUser, @Query() q: TodosQuery) { return this.flow.todos(user, { tab: q.tab ?? 'pending', keyword: q.keyword, page: q.page ?? 1, pageSize: q.pageSize ?? 20 }); }

  /** 批量改派：公司管理员把某人名下在办的待办批量改给别人（服务里判断管理员身份，必须写原因，留痕） */
  @AuthenticatedOnly()
  @Post('reassign')
  reassign(@CurrentUser() user: AuthUser, @Body() b: ReassignDto) { return this.flow.reassignOpen(user, b); }

  @AuthenticatedOnly()
  @Get('notifications')
  notifications(@CurrentUser() user: AuthUser, @Query('unread') unread?: string) { return this.flow.notifications(user, unread === '1'); }

  @AuthenticatedOnly()
  @Post('notifications/read')
  markRead(@CurrentUser() user: AuthUser, @Body() b: ReadDto) { return this.flow.markRead(user, b.ids); }
}
