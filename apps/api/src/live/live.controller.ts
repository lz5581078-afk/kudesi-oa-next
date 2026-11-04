import { LiveQrService } from './live-qr.service';
import { LiveNotificationService } from './live-notification.service';
import { LiveTurnoverService } from './live-turnover.service';
import { LiveManagementService } from './live-management.service';
import { liveIsDay } from '@kudesi/shared';
import { liveFail } from './live-core';
import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { LiveLedgerService } from './live-ledger.service';
import { LiveScheduleService } from './live-schedule.service';
import { LiveSessionService } from './live-session.service';
import { LiveSettlementService } from './live-settlement.service';
import { liveProducts, loadLiveAccess, requireUse } from './live-access';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

class LiveQrDto {
  @IsInt() @Min(0) version!: number;
}

class NotificationSettingsDto {
  @IsBoolean() enabled!:boolean;
  @IsBoolean() digestEnabled!:boolean;
  @IsInt() @Min(0) @Max(23) digestHour!:number;
  @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsInt({each:true}) @Min(1,{each:true}) businessRecipients!:number[];
  @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsInt({each:true}) @Min(1,{each:true}) systemRecipients!:number[];
}
class ChannelDto {
  @IsInt() @Min(1) accountId!:number;
  @IsArray() @ArrayMaxSize(20) @IsInt({each:true}) storeIds!:number[];
}
class StoreLineDto {
  @IsInt() @Min(1) storeId!:number;
  @IsString() @MaxLength(32) platform!:string;
  @IsInt() @Min(0) @Max(10_000_000_000) salesCents!:number;
  @IsInt() @Min(0) @Max(10_000_000_000) adSpendCents!:number;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({each:true}) orderIds?:string[];
  @IsOptional() @IsString() @MaxLength(500) reason?:string;
}
class LiveProductEntryDto {
  @IsOptional() @IsInt() @Min(1) productId?: number;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
}
class ScheduleDto {
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({each:true}) @Type(()=>ChannelDto) channels?:ChannelDto[];
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
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsInt({ each: true }) productIds?: number[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => LiveProductEntryDto) productEntries?: LiveProductEntryDto[];
}
class PreviousScheduleQuery {
  @Type(() => Number) @IsInt() @Min(1) roomId!: number;
  @IsString() @MaxLength(10) date!: string;
  @IsOptional() @IsString() @MaxLength(5) startTime?: string;
}
class CancelDto { @IsString() @MaxLength(500) reason!: string }
class StartDto {
  @IsOptional() @IsInt() @Min(1) confirmTrialAnchorId?:number;
  @IsOptional() @IsIn(['anchor','control','operator']) role?:'anchor'|'control'|'operator';
  @IsOptional() @IsInt() @Min(1) sessionId?:number;
  @IsOptional() @IsBoolean() confirmDetails?:boolean;
  @IsOptional() @IsBoolean() confirmEarly?:boolean;
  @IsOptional() @IsString() @MaxLength(64) scheduleFingerprint?:string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({each:true}) @Type(()=>ChannelDto) channels?:ChannelDto[];
  @IsOptional() @IsInt() scheduleId?: number | null;
  @IsOptional() @IsInt() roomId?: number | null;
  @IsOptional() @IsInt() anchorId?: number | null;
  @IsOptional() @IsInt() controlId?: number | null;
  @IsOptional() @IsInt() operatorId?: number | null;
  @IsOptional() @IsInt() douyinAccountId?: number | null;
  @IsOptional() @IsInt() storeId?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsInt({ each: true }) productIds?: number[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => LiveProductEntryDto) productEntries?: LiveProductEntryDto[];
  @IsOptional() @IsString() @MaxLength(19) startAt?: string | null;
}
class LiveRatingDto { @IsInt() @Min(1) userId!:number; @IsInt() @Min(0) @Max(10) score!:number; }
class ReportDto {
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsInt({each:true}) @Min(1,{each:true}) evidenceFileIds?:number[];
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({each:true}) @Type(()=>LiveRatingDto) ratings?:LiveRatingDto[];
  @IsOptional() @IsInt() @Min(1) confirmTrialAnchorId?:number;
  @IsOptional() @IsArray() @ArrayMaxSize(400) @ValidateNested({each:true}) @Type(()=>StoreLineDto) storeLines?:StoreLineDto[];
  @IsOptional() @IsIn(['anchor', 'control', 'operator']) role?: string;
  @IsString() @MaxLength(19) endAt!: string;
  @IsInt() @Min(0) @Max(10_000_000_000) salesCents!: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000_000) adSpendCents?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) orderIds?: string[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class ReviewFormDto {
  @IsOptional() @IsString() @MaxLength(19) operatorEndAt?:string;
  @IsOptional() @IsArray() @ArrayMaxSize(400) @ValidateNested({each:true}) @Type(()=>StoreLineDto) storeLines?:StoreLineDto[];
  @IsOptional() @IsString() @MaxLength(20) finalSource?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000_000) finalSalesCents?: number;
  @IsOptional() @IsString() @MaxLength(500) finalReason?: string;
  @IsOptional() @IsInt() operatorUserId?: number;
  @IsOptional() @IsBoolean() noOperator?: boolean;
  @IsOptional() @IsString() @MaxLength(19) wageStartAt?: string;
  @IsOptional() @IsString() @MaxLength(19) wageEndAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000) wageHourlyRateCents?: number;
  @IsOptional() @IsString() @MaxLength(500) wageNote?: string;
  @IsOptional() @IsString() @MaxLength(19) controlWageStartAt?:string;
  @IsOptional() @IsString() @MaxLength(19) controlWageEndAt?:string;
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000) controlWageHourlyRateCents?:number;
  @IsOptional() @IsString() @MaxLength(500) controlWageNote?:string;
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
class SubmitSettlementDto { @IsInt() @Min(1) revision!:number; }
class PaymentDto {
  @IsInt() @Min(1) userId!:number;
  @IsInt() @Min(-Number.MAX_SAFE_INTEGER) @Max(Number.MAX_SAFE_INTEGER) amountCents!:number;
  @IsString() @MaxLength(100) requestKey!:string;
  @IsString() @MaxLength(200) reference!:string;
  @IsOptional() @IsString() @MaxLength(500) note?:string;
}
class SettlementAdjustmentDto {
  @IsIn(['wage','commission']) kind!:'wage'|'commission';
  @IsInt() @Min(1) lineId!:number;
  @IsInt() @Min(-Number.MAX_SAFE_INTEGER) @Max(Number.MAX_SAFE_INTEGER) amountCents!:number;
  @IsString() @MaxLength(100) reference!:string;
  @IsString() @MaxLength(500) reason!:string;
}
class SettlementVoidDto { @IsString() @MaxLength(500) reason!:string; }
class GenerateDto {
  @IsOptional() @IsIn(['wage','commission','mixed']) kind?:'wage'|'commission'|'mixed';
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsInt({each:true}) @Min(1,{each:true}) userIds?:number[];
  @IsOptional() @IsInt() @Min(1) settlementId?:number;
  @IsOptional() @IsString() @MaxLength(7) month?: string;
  @IsOptional() @IsString() @MaxLength(10) from?:string;
  @IsOptional() @IsString() @MaxLength(10) to?:string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class RoomSettingsDto {
  @IsOptional() @IsInt() @Min(1) ownerId?:number|null;
  @IsString() @MaxLength(1000) products!:string;
}
class TrialPersonDto {
  @IsString() @MaxLength(50) name!:string;
  @IsInt() @Min(1) @Max(100_000_000) hourlyRateCents!:number;
}
class ManualDto {
  @IsOptional() @IsBoolean() confirmUnlinkedStores?:boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(400) @ValidateNested({each:true}) @Type(()=>StoreLineDto) storeLines?:StoreLineDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({each:true}) @Type(()=>ChannelDto) channels?:ChannelDto[];
  @IsOptional() @IsInt() @Min(1) sessionId?:number;
  @IsInt() @Min(1) roomId!:number;
  @IsInt() @Min(1) anchorId!:number;
  @IsOptional() @IsInt() @Min(1) controlId?:number|null;
  @IsOptional() @IsInt() @Min(1) operatorId?:number|null;
  @IsInt() @Min(1) douyinAccountId!:number;
  @IsInt() @Min(1) storeId!:number;
  @IsString() @MaxLength(19) startAt!:string;
  @IsString() @MaxLength(19) endAt!:string;
  @IsInt() @Min(0) @Max(10_000_000_000) salesCents!:number;
  @IsInt() @Min(0) @Max(10_000_000_000) adSpendCents!:number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000_000) controlSalesCents?:number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000_000) operatorSalesCents?:number;
  @IsString() @MaxLength(500) reason!:string;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({each:true}) orderIds?:string[];
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
  @IsOptional() @Type(()=>Number) @IsInt() @Min(1) storeId?:number;
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
    private readonly notices: LiveNotificationService,
    private readonly turnover: LiveTurnoverService,
    private readonly management: LiveManagementService,
    private readonly liveQr: LiveQrService,
    private readonly schedules: LiveScheduleService, private readonly sessions: LiveSessionService, private readonly ledger: LiveLedgerService, private readonly settlements: LiveSettlementService,
  ) {}

  @Get('checkin-context') @AuthenticatedOnly()
  async checkinContext(@CurrentUser() u:AuthUser,@Query('roomId') room?:string,@Query('token') token?:string,@Query('qrScan') scan?:string){
    if(scan!==undefined||room!==undefined||token!==undefined)await this.liveQr.assert(u,token);
    return this.sessions.checkinContext(u,room?Number(room):undefined);
  }
  @RequirePermission('live.manage') @Get('checkin-qr')
  readLiveQr(@CurrentUser() u:AuthUser){return this.liveQr.read(u);}
  @RequirePermission('live.manage') @Post('checkin-qr')
  generateLiveQr(@CurrentUser() u:AuthUser,@Body() b:LiveQrDto){return this.liveQr.generate(u,b.version);}
  @Get('sessions/:id/checkout-preview') @AuthenticatedOnly()
  checkoutPreview(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Query('role') role?:string){return this.sessions.checkoutPreview(u,id,role);}

  @RequirePermission('live.manage') @Get('notification-settings')
  notificationSettings(@CurrentUser() u:AuthUser) { return this.notices.settings(u); }
  @RequirePermission('live.manage') @Put('notification-settings')
  saveNotificationSettings(@CurrentUser() u:AuthUser,@Body() b:NotificationSettingsDto) { return this.notices.save(u,b); }

  @AuthenticatedOnly() @Get('options')
  options(@CurrentUser() u: AuthUser) { return this.schedules.options(u); }

  @AuthenticatedOnly() @Get('integration-status')
  integrationStatus(@CurrentUser() u: AuthUser) { return this.sessions.integrationStatus(u); }
  @AuthenticatedOnly() @Get('submission-status')
  submissionStatus(@CurrentUser() u: AuthUser) { return this.sessions.submissionStatus(u); }
  @AuthenticatedOnly() @Get('products')
  async products(@CurrentUser() u: AuthUser, @Query() q: ProductQuery) {
    const a = await loadLiveAccess(this.ds.manager, u); requireUse(a);
    return liveProducts(this.ds.manager, u.companyId, null, (q.keyword ?? '').trim());
  }

  @AuthenticatedOnly() @Get('overview')
  overview(@CurrentUser() u: AuthUser, @Query() q: DayQuery) { return this.schedules.overview(u, q.date); }

  @AuthenticatedOnly() @Get('rooms/:id/day')
  roomDay(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query() q: DayQuery) { return this.schedules.roomDay(u, id, q.date); }

  @RequirePermission('live.manage') @Put('rooms/:id')
  roomSettings(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:RoomSettingsDto){return this.management.room(u,id,b);}
  @RequirePermission('live.manage') @Post('trial-people')
  trialPerson(@CurrentUser() u:AuthUser,@Body() b:TrialPersonDto){return this.management.trial(u,b);}
  @RequirePermission('live.manage') @Post('manual-reports')
  manualReport(@CurrentUser() u:AuthUser,@Body() b:ManualDto){return this.management.manual(u,b);}
  @RequirePermission('live.manage') @Put('rules/:id')
  editRule(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:RuleDto){if(!liveIsDay(b.effectiveFrom))liveFail('请选择生效日期',400);return this.management.updateRule(u,id,b as never);}

  // ---- 排场 ----
  @AuthenticatedOnly() @Get('schedules')
  listSchedules(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) { return this.schedules.list(u, q); }
  @RequirePermission('live.manage') @Get('schedules/previous')
  previousSchedule(@CurrentUser() u: AuthUser, @Query() q: PreviousScheduleQuery) { return this.schedules.previous(u, q); }
  @RequirePermission('live.manage') @Post('schedules')
  createSchedule(@CurrentUser() u: AuthUser, @Body() b: ScheduleDto) { return this.schedules.create(u, b); }
  @RequirePermission('live.manage') @Put('schedules/:id')
  updateSchedule(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ScheduleDto) { return this.schedules.update(u, id, b); }
  @RequirePermission('live.manage') @Post('schedules/:id/cancel')
  cancelSchedule(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: CancelDto) { return this.schedules.cancel(u, id, b.reason); }

  @AuthenticatedOnly() @Get('sessions/:id/turnover')
  sessionTurnover(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.turnover.read(u, id); }

  // ---- 场次 ----
  @AuthenticatedOnly() @Post('sessions')
  async start(@CurrentUser() u: AuthUser, @Body() b: StartDto, @Query('qrScan') qrScan?:string,@Query('qrToken') qrToken?:string) {
    if(qrScan!==undefined||qrToken!==undefined)await this.liveQr.assert(u,qrToken);
    return this.sessions.start(u, {...b, actualCheckin:true, startAt:null});
  }
  @AuthenticatedOnly() @Get('sessions')
  listSessions(@CurrentUser() u: AuthUser, @Query() q: SessionsQuery) { return this.sessions.list(u, q); }
  @AuthenticatedOnly() @Get('sessions/:id')
  session(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.sessions.detail(u, id); }
  @AuthenticatedOnly() @Get('sessions/:id/order-candidates')
  candidates(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query() q: CandidatesQuery) { return this.sessions.orderCandidates(u, id, { endAt: q.endAt, storeId:q.storeId, refresh: q.refresh === '1' }); }
  @AuthenticatedOnly() @Post('sessions/:id/report')
  async report(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReportDto, @Query('qrScan') qrScan?:string,@Query('qrToken') qrToken?:string) {
    if(qrScan!==undefined||qrToken!==undefined)await this.liveQr.assert(u,qrToken);
    return this.sessions.report(u, id, b);
  }
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
  @AuthenticatedOnly() @Get('personal-income')
  personalIncome(@CurrentUser() u:AuthUser) { return this.ledger.personalIncome(u); }
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
  @RequirePermission('live.manage') @Post('settlements/preview')
  previewSettlement(@CurrentUser() u:AuthUser,@Body() b:GenerateDto){return this.settlements.preview(u,b);}
  @RequirePermission('live.manage') @Post('settlements')
  generate(@CurrentUser() u: AuthUser, @Body() b: GenerateDto) { return this.settlements.generate(u, b.month??'', b.note, {from:b.from,to:b.to,kind:b.kind,userIds:b.userIds,settlementId:b.settlementId}); }
  @RequirePermission('live.manage') @Post('settlements/:id/adjustments')
  adjustSettlement(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:SettlementAdjustmentDto){return this.settlements.adjustment(u,id,b);}
  @RequirePermission('live.manage') @Post('settlements/:id/payments')
  paySettlement(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:PaymentDto){return this.settlements.payment(u,id,b);}
  @RequirePermission('live.manage') @Post('settlements/:id/void')
  voidSettlement(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:SettlementVoidDto){return this.settlements.void(u,id,b.reason);}
  @RequirePermission('live.manage') @Post('settlements/:id/submit')
  submitSettlement(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number,@Body() b:SubmitSettlementDto) { return this.settlements.submit(u, id,b.revision); }
}
