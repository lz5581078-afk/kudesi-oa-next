import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { OutboxService } from './outbox.service';

class SwitchDto { @IsBoolean() enabled!: boolean; @IsOptional() @IsString() @MaxLength(200) note?: string }
class EnqueueDto { @IsIn(['finance-base-codes', 'finance-bundles']) type!: string; @IsOptional() @IsArray() @IsInt({ each: true }) ids?: number[]; @IsOptional() @IsBoolean() replaceConfirmed?: boolean }
class ItemsDto {
  @IsIn(['finance-base-codes', 'finance-bundles']) type!: string;
  @IsOptional() @IsString() @MaxLength(60) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
class JobsDto {
  @IsOptional() @IsIn(['pending', 'sending', 'done', 'failed', 'cancelled']) status?: string;
  @IsOptional() @IsIn(['base_code', 'bundle', 'normal_product']) kind?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

/** 聚水潭同步队列：看队列、开关由页面权限控制；改动一律要公司管理员（服务里再校验）。 */
@Controller('finance/jst-sync')
export class OutboxController {
  constructor(private readonly outbox: OutboxService) {}

  @RequirePermission('finance.jst-sync.view')
  @Get('switch')
  getSwitch(@CurrentUser() u: AuthUser) { return this.outbox.getSwitch(u.companyId); }

  @RequirePermission('finance.jst-sync.view')
  @Put('switch')
  setSwitch(@CurrentUser() u: AuthUser, @Body() b: SwitchDto) { return this.outbox.setSwitch(u, b.enabled, b.note); }

  @RequirePermission('finance.jst-sync.view')
  @Get('jobs')
  jobs(@CurrentUser() u: AuthUser, @Query() q: JobsDto) { return this.outbox.jobs(u, { status: q.status, kind: q.kind, page: q.page ?? 1, pageSize: q.pageSize ?? 20 }); }

  @RequirePermission('finance.jst-sync.view')
  @Get('items')
  items(@CurrentUser() u: AuthUser, @Query() q: ItemsDto) { return this.outbox.items(u, { type: q.type, keyword: q.keyword, page: q.page ?? 1, pageSize: q.pageSize ?? 20 }); }

  @RequirePermission('finance.jst-sync.view')
  @Post('enqueue')
  @HttpCode(200)
  enqueue(@CurrentUser() u: AuthUser, @Body() b: EnqueueDto) { return this.outbox.enqueue(u, b.type, b.ids, { replaceConfirmed: b.replaceConfirmed }); }

  @RequirePermission('finance.jst-sync.view')
  @Post('jobs/:id/retry')
  @HttpCode(200)
  retry(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.outbox.retry(u, id); }

  @RequirePermission('finance.jst-sync.view')
  @Post('jobs/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.outbox.cancel(u, id); }
}
