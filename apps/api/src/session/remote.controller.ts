import { Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, ArrayMaxSize, ValidateNested } from 'class-validator';
import { AuthUser, CurrentUser, Public, RequirePermission } from '../common/auth.decorators';
import { RemoteAssistService, MaintenanceRemoteAssistService } from './remote.service';

class RequestRemoteDto { @IsIn(['view', 'control']) mode!: string; @IsString() @MaxLength(200) reason!: string }
class SignalDto { @IsString() @MaxLength(10) kind!: string; @IsOptional() @IsObject() payload?: Record<string, unknown> }
class PollQueryDto { @IsOptional() @Type(() => Number) @IsInt() @Min(0) after?: number }
class DeviceRemoteDto { @IsBoolean() enabled!: boolean; @IsOptional() @IsBoolean() allowControl?: boolean; @IsOptional() @IsInt() @Min(1) @Max(1000) maxMinutes?: number }
class AgentMsgDto { @IsString() @MaxLength(10) kind!: string; @IsOptional() @IsObject() payload?: Record<string, unknown> }
class ExchangeDto {
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AgentMsgDto) send?: AgentMsgDto[];
  @IsOptional() @IsInt() @Min(0) after?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5000) inputs?: number;
}
class AgentEndDto { @IsOptional() @IsIn(['completed', 'error']) reason?: string; @IsOptional() @IsString() @MaxLength(300) note?: string; @IsOptional() @IsInt() @Min(0) @Max(100000) inputs?: number }
class DeclineDto { @IsOptional() @IsString() @MaxLength(100) note?: string }

const VIEW = 'finance.doc-withdrawal.view';

/**
 * 远程协助（网页端）。都需要“店铺提现”页面的查看权限；是否能申请、能否管理在服务里再按
 * finance.session.remote / finance.session.manage 判断。轮询接口很频繁，不参与全局限流。
 */
@SkipThrottle()
@Controller('session/remote')
export class RemoteAssistController {
  constructor(private readonly remote: RemoteAssistService) {}

  @RequirePermission(VIEW) @Get('devices') devices(@CurrentUser() u: AuthUser) { return this.remote.devices(u); }
  @RequirePermission(VIEW) @Post('devices/:id') setDevice(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: DeviceRemoteDto) { return this.remote.setDevice(u, id, b); }
  @RequirePermission(VIEW) @Post('stop-all') stopAll(@CurrentUser() u: AuthUser) { return this.remote.stopAll(u); }
  @RequirePermission(VIEW) @Get('shops') shops(@CurrentUser() u: AuthUser) { return this.remote.shopStates(u); }
  @RequirePermission(VIEW) @Post('shops/:id/request') request(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: RequestRemoteDto) { return this.remote.request(u, id, b); }
  @RequirePermission(VIEW) @Get('history') history(@CurrentUser() u: AuthUser) { return this.remote.history(u); }
  @RequirePermission(VIEW) @Get('sessions/:id') get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.remote.get(u, id); }
  @RequirePermission(VIEW) @Get('sessions/:id/poll') poll(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query() q: PollQueryDto) { return this.remote.poll(u, id, q.after ?? 0); }
  @RequirePermission(VIEW) @Post('sessions/:id/signal') signal(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: SignalDto) { return this.remote.signal(u, id, b); }
  @RequirePermission(VIEW) @Post('sessions/:id/extend') extend(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.remote.extend(u, id); }
  @RequirePermission(VIEW) @Post('sessions/:id/end') end(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.remote.end(u, id); }
}

@SkipThrottle()
@Controller('store-maintenance/remote')
export class MaintenanceRemoteAssistController {
  constructor(private readonly remote: MaintenanceRemoteAssistService) {}

  @RequirePermission('resource.company-store-maintenance.view') @Get('devices') devices(@CurrentUser() u: AuthUser) { return this.remote.devices(u); }
  @RequirePermission('resource.company-store-maintenance.view') @Post('devices/:id') setDevice(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: DeviceRemoteDto) { return this.remote.setDevice(u, id, b); }
  @RequirePermission('resource.company-store-maintenance.view') @Post('stop-all') stopAll(@CurrentUser() u: AuthUser) { return this.remote.stopAll(u); }
  @RequirePermission('resource.company-store-maintenance.view') @Get('shops') shops(@CurrentUser() u: AuthUser) { return this.remote.shopStates(u); }
  @RequirePermission('resource.company-store-maintenance.view') @Post('shops/:id/request') request(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: RequestRemoteDto) { return this.remote.request(u, id, b); }
  @RequirePermission('resource.company-store-maintenance.view') @Get('history') history(@CurrentUser() u: AuthUser) { return this.remote.history(u); }
  @RequirePermission('resource.company-store-maintenance.view') @Get('sessions/:id') get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.remote.get(u, id); }
  @RequirePermission('resource.company-store-maintenance.view') @Get('sessions/:id/poll') poll(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query() q: PollQueryDto) { return this.remote.poll(u, id, q.after ?? 0); }
  @RequirePermission('resource.company-store-maintenance.view') @Post('sessions/:id/signal') signal(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: SignalDto) { return this.remote.signal(u, id, b); }
  @RequirePermission('resource.company-store-maintenance.view') @Post('sessions/:id/extend') extend(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.remote.extend(u, id); }
  @RequirePermission('resource.company-store-maintenance.view') @Post('sessions/:id/end') end(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.remote.end(u, id); }
}

/** 远程协助（助手端）：设备令牌，和 /agent/* 其他接口一样不读员工登录信息。 */
@SkipThrottle()
@Controller('agent/remote')
export class RemoteAssistAgentController {
  constructor(private readonly remote: RemoteAssistService) {}

  @Public() @Post('claim') claim(@Headers('x-device-token') t: string | undefined) { return this.remote.agentClaim(t); }
  @Public() @Post('sessions/:id/accept') accept(@Headers('x-device-token') t: string | undefined, @Param('id', ParseIntPipe) id: number) { return this.remote.agentAccept(t, id); }
  @Public() @Post('sessions/:id/decline') decline(@Headers('x-device-token') t: string | undefined, @Param('id', ParseIntPipe) id: number, @Body() b: DeclineDto) { return this.remote.agentDecline(t, id, b.note); }
  @Public() @Post('sessions/:id/exchange') exchange(@Headers('x-device-token') t: string | undefined, @Param('id', ParseIntPipe) id: number, @Body() b: ExchangeDto) { return this.remote.agentExchange(t, id, b); }
  @Public() @Post('sessions/:id/end') end(@Headers('x-device-token') t: string | undefined, @Param('id', ParseIntPipe) id: number, @Body() b: AgentEndDto) { return this.remote.agentEnd(t, id, b); }
}
