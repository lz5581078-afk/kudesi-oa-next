import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { MAX_UPLOAD_BYTES } from '../integrations/files.service';
import { AfterSalesService, type CaseFilter } from './after-sales.service';
import { AppealsService, type AppealStatusFilter } from './appeals.service';
import { SupervisionService } from './supervision.service';

type Upload = { originalname: string; buffer: Buffer; size: number };
const REQUEST_KEY = /^[A-Za-z0-9_-]{12,80}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class Paging {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
class CaseListQuery extends Paging {
  @IsOptional() @IsIn(['open', 'late', 'soon', 'done', 'all']) filter?: CaseFilter;
  @IsOptional() @IsString() @MaxLength(300) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) storeId?: number;
  @IsOptional() @IsString() @MaxLength(24) caseType?: string;
  @IsOptional() @IsIn(['1']) mine?: string;
}
class CaseDto {
  @IsInt() @Min(1) storeId!: number;
  @IsString() @MaxLength(80) orderNo!: string;
  @IsOptional() @IsString() @MaxLength(80) buyerName?: string;
  @IsString() @MaxLength(24) caseType!: string;
  @IsInt() @Min(0) @Max(100_000_000_00) amountCents!: number;
  @IsString() @MaxLength(500) reason!: string;
  @IsOptional() @Matches(DATE) dueDate?: string;
  @IsOptional() @Matches(REQUEST_KEY) requestKey?: string;
}
class LogDto {
  @IsString() @MaxLength(1000) content!: string;
  @IsOptional() @IsIn(['note', 'urge']) kind?: 'note' | 'urge';
}
class AppealListQuery extends Paging {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) storeId?: number;
  @IsOptional() @IsString() @MaxLength(24) type?: string;
  @IsOptional() @IsIn(['all', 'pending', 'submitted', 'approved', 'rejected', 'cancelled']) status?: AppealStatusFilter;
  @IsOptional() @IsString() @MaxLength(600) keyword?: string;
}
class AppealDto {
  @IsInt() @Min(1) storeId!: number;
  @IsString() @MaxLength(24) appealType!: string;
  @IsString() @MaxLength(80) orderNo!: string;
  @IsInt() @Min(0) @Max(100_000_000_00) amountCents!: number;
  @IsString() @MaxLength(1000) reason!: string;
  @IsOptional() @Matches(DATE) deadlineDate?: string;
  @IsOptional() @IsInt() @Min(1) parentId?: number;
  @IsOptional() @Matches(REQUEST_KEY) requestKey?: string;
}
class ExceptionDto {
  @IsString() @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(1000) detail?: string;
  @IsIn(['urgent', 'important', 'normal']) severity!: 'urgent' | 'important' | 'normal';
  @IsOptional() @IsInt() @Min(1) ownerId?: number;
  @IsOptional() @IsInt() @Min(1) storeId?: number;
}
class CloseDto { @IsOptional() @IsString() @MaxLength(500) reason?: string }
class FollowDto { @IsString() @MaxLength(1000) content!: string }
class RuleDto {
  @IsOptional() @IsInt() @Min(0) overdueMinutes?: number;
  @IsOptional() @IsInt() @Min(0) supervisorVisibleMinutes?: number;
  @IsOptional() @IsInt() @Min(0) bossVisibleMinutes?: number;
  @IsOptional() @IsString() @MaxLength(240) abnormalCondition?: string;
  @IsOptional() @IsBoolean() closeRequiresReason?: boolean;
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
}

const upload = () => UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }));

/** 售后表格。身份只取令牌；业务流转走流程引擎（办理在“流程详情”里）。 */
@Controller('after-sales')
export class AfterSalesController {
  constructor(private readonly svc: AfterSalesService) {}

  @RequirePermission('after-sales.table.view') @Get('stores')
  stores(@CurrentUser() u: AuthUser) { return this.svc.stores(u); }

  @RequirePermission('after-sales.table.view') @Get()
  list(@CurrentUser() u: AuthUser, @Query() q: CaseListQuery) {
    return this.svc.list(u, { filter: q.filter ?? 'open', keyword: q.keyword, storeId: q.storeId, caseType: q.caseType, mine: q.mine === '1', page: q.page ?? 1, pageSize: q.pageSize ?? 20 });
  }

  @RequirePermission('after-sales.table.view') @Post()
  create(@CurrentUser() u: AuthUser, @Body() b: CaseDto) { return this.svc.create(u, b); }

  @RequirePermission('after-sales.table.view') @Get(':id')
  detail(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.detail(u, id); }

  @RequirePermission('after-sales.table.view') @Post(':id/logs')
  log(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: LogDto) { return this.svc.addLog(u, id, b.content, b.kind ?? 'note'); }

  @RequirePermission('after-sales.table.view') @Post(':id/files') @upload()
  upload(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @UploadedFile() file: Upload | undefined) { return this.svc.upload(u, id, file); }

  @RequirePermission('after-sales.table.view') @Delete(':id/files/:fileId')
  removeFile(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Param('fileId', ParseIntPipe) fileId: number) { return this.svc.removeFile(u, id, fileId); }

  @RequirePermission('after-sales.table.view') @Get(':id/files/:fileId/url')
  fileUrl(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Param('fileId', ParseIntPipe) fileId: number) { return this.svc.fileUrl(u, id, fileId); }
}

/** 订单申诉与举证。 */
@Controller('appeals')
export class AppealsController {
  constructor(private readonly svc: AppealsService) {}

  @RequirePermission('after-sales.appeals.view') @Get('stores')
  stores(@CurrentUser() u: AuthUser) { return this.svc.stores(u); }

  @RequirePermission('after-sales.appeals.view') @Get()
  list(@CurrentUser() u: AuthUser, @Query() q: AppealListQuery) {
    return this.svc.list(u, { storeId: q.storeId, type: q.type, status: q.status ?? 'all', keyword: q.keyword, page: q.page ?? 1, pageSize: q.pageSize ?? 20 });
  }

  @RequirePermission('after-sales.appeals.view') @Post()
  create(@CurrentUser() u: AuthUser, @Body() b: AppealDto) { return this.svc.create(u, b); }

  @RequirePermission('after-sales.appeals.view') @Get(':id')
  detail(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.detail(u, id); }

  @RequirePermission('after-sales.appeals.view') @Post(':id/logs')
  log(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: LogDto) { return this.svc.addLog(u, id, b.content, b.kind ?? 'note'); }

  @RequirePermission('after-sales.appeals.view') @Post(':id/files') @upload()
  upload(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @UploadedFile() file: Upload | undefined) { return this.svc.upload(u, id, file); }

  @RequirePermission('after-sales.appeals.view') @Delete(':id/files/:fileId')
  removeFile(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Param('fileId', ParseIntPipe) fileId: number) { return this.svc.removeFile(u, id, fileId); }

  @RequirePermission('after-sales.appeals.view') @Get(':id/files/:fileId/url')
  fileUrl(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Param('fileId', ParseIntPipe) fileId: number) { return this.svc.fileUrl(u, id, fileId); }
}

/** 兜底监督。看监督中心要 supervision.center.view；关闭异常、改规则、立即扫描要 supervision.manage。 */
@Controller('supervision')
export class SupervisionController {
  constructor(private readonly svc: SupervisionService) {}

  @RequirePermission('supervision.center.view') @Get()
  overview(@CurrentUser() u: AuthUser) { return this.svc.overview(u); }

  /** 给首页/老板总控台的汇总：只含数量和金额 */
  @RequirePermission('supervision.center.view') @Get('summary')
  summary(@CurrentUser() u: AuthUser) { return this.svc.summary(u.companyId); }

  @RequirePermission('supervision.center.view', 'supervision.manage') @Post('scan')
  async scan(@CurrentUser() u: AuthUser) { return this.svc.scan(u.companyId); }

  @RequirePermission('supervision.center.view') @Post('exceptions')
  register(@CurrentUser() u: AuthUser, @Body() b: ExceptionDto) { return this.svc.register(u, b); }

  @RequirePermission('supervision.center.view') @Get('exceptions/:id')
  detail(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.detail(u, id); }

  @RequirePermission('supervision.center.view') @Post('exceptions/:id/close')
  close(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: CloseDto) { return this.svc.close(u, id, b.reason); }

  @RequirePermission('supervision.center.view') @Post('exceptions/:id/logs')
  follow(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: FollowDto) { return this.svc.addLog(u, id, b.content); }

  @RequirePermission('supervision.center.view', 'supervision.manage') @Put('rules/:target')
  rule(@CurrentUser() u: AuthUser, @Param('target') target: string, @Body() b: RuleDto) { return this.svc.saveRule(u, target, b); }
}
