import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { CategorySyncService, type CategoryScope } from './category-sync.service';
import { OutboxService } from './outbox.service';
import { PriceSyncService } from './price-sync.service';

class SwitchDto { @IsBoolean() enabled!: boolean; @IsOptional() @IsString() @MaxLength(200) note?: string }
class EnqueueItemDto { @IsInt() @Min(1) id!: number; @IsString() @MaxLength(80) signature!: string }
/** 批量加入同步队列：1～50 条，每条带核对时看到的内容指纹，并且必须明确确认已核对 */
class EnqueueDto {
  @IsIn(['finance-base-codes', 'finance-bundles']) type!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => EnqueueItemDto) items!: EnqueueItemDto[];
  @IsBoolean() confirmed!: boolean;
  @IsOptional() @IsBoolean() replaceConfirmed?: boolean;
}
class PriceRunDto { @IsOptional() @IsArray() @ArrayMaxSize(25) @IsInt({ each: true }) ids?: number[] }
class PriceLogsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) bundleId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
class CategoryScopeDto { @IsIn(['product', 'bundle']) scope!: CategoryScope }
class CategoryExecuteDto { @IsIn(['product', 'bundle']) scope!: CategoryScope; @IsString() @MaxLength(80) signature!: string; @IsBoolean() confirmed!: boolean }
class PageDto { @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number }
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
  constructor(private readonly outbox: OutboxService, private readonly price: PriceSyncService, private readonly category: CategorySyncService) {}

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
  enqueue(@CurrentUser() u: AuthUser, @Body() b: EnqueueDto) {
    if (b.confirmed !== true) throw new BadRequestException('请先勾选“已核对上传内容”');
    if (new Set(b.items.map((i) => i.id)).size !== b.items.length) throw new BadRequestException('同一条记录不能重复选择');
    return this.outbox.enqueue(u, b.type, b.items.map((i) => i.id), { replaceConfirmed: b.replaceConfirmed, signatures: Object.fromEntries(b.items.map((i) => [i.id, i.signature])) });
  }

  @RequirePermission('finance.jst-sync.view')
  @Post('jobs/:id/retry')
  @HttpCode(200)
  retry(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.outbox.retry(u, id); }

  @RequirePermission('finance.jst-sync.view')
  @Post('jobs/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.outbox.cancel(u, id); }

  // ---------- 归档任务 ----------
  @RequirePermission('finance.jst-sync.view')
  @Get('archive-jobs')
  archiveJobs(@CurrentUser() u: AuthUser) { return this.outbox.archiveJobs(u); }

  @RequirePermission('finance.jst-sync.view')
  @Post('archive-jobs/:id/recheck')
  @HttpCode(200)
  recheck(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.outbox.recheckArchiveJob(u, id); }

  // ---------- 基本售价同步（最低售价 -> compose_sale_price；独立开关，默认关） ----------
  @RequirePermission('finance.jst-sync.view')
  @Get('price/switch')
  priceSwitch(@CurrentUser() u: AuthUser) { return this.price.getSwitch(u); }

  @RequirePermission('finance.jst-sync.view')
  @Put('price/switch')
  setPriceSwitch(@CurrentUser() u: AuthUser, @Body() b: SwitchDto) { return this.price.setSwitch(u, b.enabled, b.note); }

  @RequirePermission('finance.jst-sync.view')
  @Get('price/preview')
  pricePreview(@CurrentUser() u: AuthUser) { return this.price.preview(u); }

  @RequirePermission('finance.jst-sync.view')
  @Post('price/run')
  @HttpCode(200)
  priceRun(@CurrentUser() u: AuthUser, @Body() b: PriceRunDto) { return this.price.run(u, { limit: 25, ids: b.ids }); }

  @RequirePermission('finance.jst-sync.view')
  @Get('price/logs')
  priceLogs(@CurrentUser() u: AuthUser, @Query() q: PriceLogsDto) { return this.price.logs(u, { bundleId: q.bundleId, page: q.page ?? 1, pageSize: q.pageSize ?? 20 }); }

  // ---------- 聚水潭分类同步（只有公司管理员；先预览差异，确认后只入队） ----------
  @RequirePermission('finance.jst-sync.view')
  @Post('category/preview')
  @HttpCode(200)
  categoryPreview(@CurrentUser() u: AuthUser, @Body() b: CategoryScopeDto) { return this.category.preview(u, b.scope); }

  @RequirePermission('finance.jst-sync.view')
  @Post('category/execute')
  @HttpCode(200)
  categoryExecute(@CurrentUser() u: AuthUser, @Body() b: CategoryExecuteDto) { return this.category.execute(u, b.scope, b.signature, b.confirmed); }

  @RequirePermission('finance.jst-sync.view')
  @Get('category/runs')
  categoryRuns(@CurrentUser() u: AuthUser, @Query() q: PageDto) { return this.category.runs(u, q.page ?? 1); }
}
