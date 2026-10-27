import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
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
}
class PassDto {
  @IsInt() revision!: number;
  @IsInt() stepId!: number;
  @IsOptional() @IsObject() form?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
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
  @IsInt() revision!: number;
  @IsObject() payload!: Record<string, unknown>;
}
class TransferDto {
  @IsInt() revision!: number;
  @IsOptional() @IsInt() stepId?: number;
  @IsInt() toUserId!: number;
  @IsString() @MaxLength(500) reason!: string;
}
class RunsQuery {
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
  saveDraft(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() b: DraftDto) { return this.flow.saveDraft(user, key, b.steps as never, b.escalateUserIds, (b.schema as never) ?? null); }

  @RequirePermission('flow.templates.view')
  @Post('definitions/:key/publish')
  publish(@CurrentUser() user: AuthUser, @Param('key') key: string) { return this.flow.publish(user, key); }

  @RequirePermission('flow.apply.view')
  @Post('runs')
  start(@CurrentUser() user: AuthUser, @Body() b: StartDto) { return this.flow.start(user, b.templateKey, b.payload, b.requestKey); }

  @AuthenticatedOnly()
  @Get('runs')
  list(@CurrentUser() user: AuthUser, @Query() q: RunsQuery) {
    return this.flow.listRuns(user, { view: q.view, status: q.status, templateKey: q.templateKey, keyword: q.keyword, overdue: q.overdue, page: q.page ?? 1, pageSize: q.pageSize ?? 20 });
  }

  @AuthenticatedOnly()
  @Get('runs/:id')
  detail(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.flow.detail(user, id); }

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

  @AuthenticatedOnly()
  @Get('notifications')
  notifications(@CurrentUser() user: AuthUser, @Query('unread') unread?: string) { return this.flow.notifications(user, unread === '1'); }

  @AuthenticatedOnly()
  @Post('notifications/read')
  markRead(@CurrentUser() user: AuthUser, @Body() b: ReadDto) { return this.flow.markRead(user, b.ids); }
}
