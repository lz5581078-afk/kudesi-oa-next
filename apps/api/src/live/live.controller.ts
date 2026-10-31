import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { LiveLedgerService } from './live-ledger.service';
import { LiveScheduleService } from './live-schedule.service';
import { LiveSessionService } from './live-session.service';
import { LiveSettlementService } from './live-settlement.service';
import { liveProducts, loadLiveAccess, requireUse } from './live-access';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

class ScheduleDto {
  @IsString() @MaxLength(10) date!: string;
  @IsInt() roomId!: number;
  @IsString() @MaxLength(5) startTime!: string;
  @IsString() @MaxLength(5) endTime!: string;
  @IsInt() anchorId!: number;
  @IsOptional() @IsInt() controlId?: number | null;
  @IsOptional() @IsInt() operatorId?: number | null;
  @IsInt() douyinAccountId!: number;
  @IsOptional() @IsInt() storeId?: number | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class CancelDto { @IsString() @MaxLength(500) reason!: string }
class StartDto {
  @IsOptional() @IsInt() scheduleId?: number | null;
  @IsOptional() @IsInt() roomId?: number | null;
  @IsOptional() @IsInt() anchorId?: number | null;
  @IsOptional() @IsInt() controlId?: number | null;
  @IsOptional() @IsInt() operatorId?: number | null;
  @IsOptional() @IsInt() douyinAccountId?: number | null;
  @IsOptional() @IsInt() storeId?: number | null;
  @IsArray() @ArrayMaxSize(100) @IsInt({ each: true }) productIds!: number[];
  @IsOptional() @IsString() @MaxLength(19) startAt?: string | null;
}
class ReportDto {
  @IsOptional() @IsIn(['anchor', 'control', 'operator']) role?: string;
  @IsString() @MaxLength(19) endAt!: string;
  @IsInt() @Min(0) @Max(10_000_000_000) salesCents!: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000_000) adSpendCents?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) orderIds?: string[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class ReviewFormDto {
  @IsOptional() @IsString() @MaxLength(20) finalSource?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000_000) finalSalesCents?: number;
  @IsOptional() @IsString() @MaxLength(500) finalReason?: string;
  @IsOptional() @IsInt() operatorUserId?: number;
  @IsOptional() @IsBoolean() noOperator?: boolean;
  @IsOptional() @IsString() @MaxLength(19) wageStartAt?: string;
  @IsOptional() @IsString() @MaxLength(19) wageEndAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000) wageHourlyRateCents?: number;
  @IsOptional() @IsString() @MaxLength(500) wageNote?: string;
}
class RuleDto {
  @IsString() @MaxLength(10) effectiveFrom!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsObject() rules!: Record<string, unknown>;
}
class TrialDto {
  @IsObject() rules!: Record<string, unknown>;
  @IsString() @MaxLength(20) sales!: string;
  @IsOptional() @IsString() @MaxLength(20) adSpend?: string;
}
class PreviewDto {
  @IsString() @MaxLength(20) sales!: string;
  @IsOptional() @IsString() @MaxLength(20) adSpend?: string;
}
class WageTrialDto {
  @IsString() @MaxLength(19) startAt!: string;
  @IsString() @MaxLength(19) endAt!: string;
  @IsInt() @Min(1) hourlyRateCents!: number;
}
class GenerateDto {
  @IsString() @MaxLength(7) month!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class RangeQuery {
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
}
class DayQuery { @IsOptional() @IsString() @MaxLength(10) date?: string }
class SessionsQuery extends RangeQuery {
  @IsOptional() @Type(() => Number) @IsInt() roomId?: number;
  @IsOptional() @Type(() => Number) @IsInt() anchorId?: number;
  @IsOptional() @Type(() => Number) @IsInt() controlId?: number;
  @IsOptional() @IsString() @MaxLength(20) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
class CandidatesQuery {
  @IsOptional() @IsString() @MaxLength(19) endAt?: string;
  @IsOptional() @IsIn(['1', '0']) refresh?: string;
}
class HistoryQuery extends RangeQuery {
  @IsOptional() @IsIn(['month', 'range', 'all']) mode?: string;
  @IsOptional() @IsString() @MaxLength(7) month?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
class LedgerQuery extends RangeQuery {
  @IsOptional() @IsString() @MaxLength(7) month?: string;
  @IsOptional() @Type(() => Number) @IsInt() userId?: number;
  @IsOptional() @IsIn(['anchor', 'control', 'operator']) role?: string;
}
class ProductQuery {
  @IsOptional() @IsString() @MaxLength(50) keyword?: string;
}

/**
 * 直播管理。能不能用由服务按令牌身份判断（权限键 + 岗位类型），公司只取自令牌；
 * 排场、改规则、生成月结、提交月结需要 live.manage。
 */
@Controller('live')
export class LiveController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly schedules: LiveScheduleService, private readonly sessions: LiveSessionService, private readonly ledger: LiveLedgerService, private readonly settlements: LiveSettlementService,
  ) {}

  @AuthenticatedOnly() @Get('options')
  options(@CurrentUser() u: AuthUser) { return this.schedules.options(u); }

  @AuthenticatedOnly() @Get('integration-status')
  integrationStatus(@CurrentUser() u: AuthUser) { return this.sessions.integrationStatus(u); }
  @AuthenticatedOnly() @Get('products')
  async products(@CurrentUser() u: AuthUser, @Query() q: ProductQuery) {
    const a = await loadLiveAccess(this.ds.manager, u); requireUse(a);
    return liveProducts(this.ds.manager, u.companyId, null, (q.keyword ?? '').trim());
  }

  @AuthenticatedOnly() @Get('overview')
  overview(@CurrentUser() u: AuthUser, @Query() q: DayQuery) { return this.schedules.overview(u, q.date); }

  @AuthenticatedOnly() @Get('rooms/:id/day')
  roomDay(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query() q: DayQuery) { return this.schedules.roomDay(u, id, q.date); }

  // ---- 排场 ----
  @AuthenticatedOnly() @Get('schedules')
  listSchedules(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) { return this.schedules.list(u, q); }
  @RequirePermission('live.manage') @Post('schedules')
  createSchedule(@CurrentUser() u: AuthUser, @Body() b: ScheduleDto) { return this.schedules.create(u, b); }
  @RequirePermission('live.manage') @Put('schedules/:id')
  updateSchedule(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ScheduleDto) { return this.schedules.update(u, id, b); }
  @RequirePermission('live.manage') @Post('schedules/:id/cancel')
  cancelSchedule(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: CancelDto) { return this.schedules.cancel(u, id, b.reason); }

  // ---- 场次 ----
  @AuthenticatedOnly() @Post('sessions')
  start(@CurrentUser() u: AuthUser, @Body() b: StartDto) { return this.sessions.start(u, b); }
  @AuthenticatedOnly() @Get('sessions')
  listSessions(@CurrentUser() u: AuthUser, @Query() q: SessionsQuery) { return this.sessions.list(u, q); }
  @AuthenticatedOnly() @Get('sessions/:id')
  session(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.sessions.detail(u, id); }
  @AuthenticatedOnly() @Get('sessions/:id/order-candidates')
  candidates(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query() q: CandidatesQuery) { return this.sessions.orderCandidates(u, id, { endAt: q.endAt, refresh: q.refresh === '1' }); }
  @AuthenticatedOnly() @Post('sessions/:id/report')
  report(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReportDto) { return this.sessions.report(u, id, b); }
  @AuthenticatedOnly() @Post('sessions/:id/submit')
  submit(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.sessions.submit(u, id); }
  @AuthenticatedOnly() @Post('sessions/:id/review-preview')
  reviewPreview(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReviewFormDto) { return this.sessions.reviewPreview(u, id, b); }

  @AuthenticatedOnly() @Post('sessions/:id/commission-preview')
  commissionPreview(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: PreviewDto) { return this.sessions.previewFor(u, id, b); }

  // ---- 我的直播 ----
  @AuthenticatedOnly() @Get('workbench')
  workbench(@CurrentUser() u: AuthUser) { return this.sessions.workbench(u); }
  @AuthenticatedOnly() @Get('workbench/history')
  history(@CurrentUser() u: AuthUser, @Query() q: HistoryQuery) { return this.sessions.history(u, q); }

  // ---- 提成与工资 ----
  @AuthenticatedOnly() @Get('commissions')
  commissions(@CurrentUser() u: AuthUser, @Query() q: LedgerQuery) { return this.ledger.commissions(u, q); }
  @AuthenticatedOnly() @Get('wages')
  wages(@CurrentUser() u: AuthUser, @Query() q: LedgerQuery) { return this.ledger.wages(u, q); }
  @AuthenticatedOnly() @Get('people')
  people(@CurrentUser() u: AuthUser) { return this.ledger.people(u); }
  @AuthenticatedOnly() @Get('rules')
  rules(@CurrentUser() u: AuthUser) { return this.ledger.rules(u); }
  @RequirePermission('live.manage') @Post('rules')
  createRule(@CurrentUser() u: AuthUser, @Body() b: RuleDto) { return this.ledger.createRule(u, b as never); }
  @AuthenticatedOnly() @Post('rules/trial')
  trial(@CurrentUser() u: AuthUser, @Body() b: TrialDto) { return this.ledger.trial(u, b as never); }
  @AuthenticatedOnly() @Post('wage/preview')
  wageTrial(@CurrentUser() u: AuthUser, @Body() b: WageTrialDto) { return this.ledger.wageTrial(u, b); }

  // ---- 月结 ----
  @AuthenticatedOnly() @Get('settlements')
  listSettlements(@CurrentUser() u: AuthUser) { return this.settlements.list(u); }
  @AuthenticatedOnly() @Get('settlements/:id')
  settlement(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.settlements.detail(u, id); }
  @RequirePermission('live.manage') @Post('settlements')
  generate(@CurrentUser() u: AuthUser, @Body() b: GenerateDto) { return this.settlements.generate(u, b.month, b.note); }
  @RequirePermission('live.manage') @Post('settlements/:id/submit')
  submitSettlement(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.settlements.submit(u, id); }
}
