import { Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuthUser, CurrentUser, Public, RequirePermission } from '../common/auth.decorators';
import { MAX_UPLOAD_BYTES } from '../integrations/files.service';
import { SessionService } from './session.service';
import { MAX_PACKAGE_BYTES } from './agent-package';
import { MaintenanceService } from './maintenance.service';

type Upload = { originalname: string; buffer: Buffer; size: number };
class BindVouchersDto { @IsArray() @IsInt({ each: true }) fileIds!: number[] }

export class AddShopsDto { @IsArray() @IsInt({ each: true }) storeIds!: number[]; @IsInt() deviceId!: number }
export class UpdateShopDto {
  @IsOptional() @IsInt() deviceId?: number | null;
  @IsOptional() @IsString() @MaxLength(100) loginAccount?: string;
  @IsOptional() @IsString() @MaxLength(200) loginPassword?: string;
  @IsOptional() @IsBoolean() clearPassword?: boolean;
  @IsOptional() @IsBoolean() autoLogin?: boolean;
}
export class OverviewQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) storeId?: number;
  @IsOptional() @IsString() @MaxLength(60) keyword?: string;
  @IsOptional() @IsIn(['none', 'synced', 'valid', 'expired', 'error']) loginState?: string;
  @IsOptional() @IsIn(['normal', 'abnormal', 'cancelled', 'inactive']) storeStatus?: string;
  @IsOptional() @IsString() @MaxLength(10) deviceId?: string;
  @IsOptional() @IsIn(['default', 'platform_asc', 'platform_desc', 'operator_asc', 'operator_desc']) sort?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(10) @Max(200) pageSize?: number;
}
export class NameDto { @IsString() @MaxLength(80) name!: string }
export class StatusDto { @IsIn(['active', 'revoked']) status!: 'active' | 'revoked' }
class RegisterDto { @IsString() @MaxLength(20) code!: string; @IsString() @MaxLength(80) name!: string; @IsOptional() @IsString() @MaxLength(60) os?: string; @IsOptional() @IsString() @MaxLength(30) agentVersion?: string }
class PublishReleaseDto { @IsOptional() @IsString() @MaxLength(64) sha256?: string; @IsOptional() @IsString() @MaxLength(30) version?: string; @IsOptional() @IsString() @MaxLength(300) notes?: string }
class UpdateReportDto { @IsString() @MaxLength(30) version!: string; @IsString() @MaxLength(12) status!: string; @IsOptional() @IsString() @MaxLength(40) errorCode?: string; @IsOptional() @IsString() @MaxLength(300) errorText?: string }
class HeartbeatDto { @IsOptional() @IsString() @MaxLength(30) agentVersion?: string }
class ReportDto { @IsIn(['progress', 'succeeded', 'failed']) status!: string; @IsOptional() @IsString() @MaxLength(40) errorCode?: string; @IsOptional() @IsString() @MaxLength(300) errorText?: string; @IsOptional() @IsString() @MaxLength(40) step?: string; @IsOptional() @IsInt() @Min(0) @Max(99) progress?: number }
class RemarkDto { @IsString() @MaxLength(80) remark!: string }

const VIEW = 'finance.doc-withdrawal.view';

/** 店铺提现登录管理（网页端）：查看要提现页面的权限，改动要 finance.session.manage（服务里再判断）。 */
@Controller('session')
export class SessionController {
  constructor(private readonly session: SessionService) {}

  @RequirePermission(VIEW) @Get('overview') overview(@CurrentUser() u: AuthUser, @Query() q: OverviewQueryDto) { return this.session.overview(u, q); }
  @RequirePermission(VIEW) @Get('available-stores') available(@CurrentUser() u: AuthUser, @Query('keyword') k?: string) { return this.session.availableStores(u, k); }
  @RequirePermission(VIEW) @Post('shops') add(@CurrentUser() u: AuthUser, @Body() b: AddShopsDto) { return this.session.addShops(u, b); }
  @RequirePermission(VIEW) @Post('shops/:id') update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: UpdateShopDto) { return this.session.updateShop(u, id, b); }
  @RequirePermission(VIEW) @Post('shops/:id/remove') remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.session.removeShop(u, id); }
  @RequirePermission(VIEW) @Post('shops/:id/reveal') reveal(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.session.revealPassword(u, id); }
  @RequirePermission(VIEW) @Post('shops/:id/open') open(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.session.requestOpen(u, id); }
  @RequirePermission(VIEW) @Get('shops/:id/history') history(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.session.history(u, id); }
  @RequirePermission(VIEW) @Post('requests/:id/cancel') cancel(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.session.cancelRequest(u, id); }
  @RequirePermission(VIEW) @Get('devices') devices(@CurrentUser() u: AuthUser) { return this.session.devices(u); }
  @RequirePermission(VIEW) @Post('bind-codes') bind(@CurrentUser() u: AuthUser) { return this.session.createBindCode(u); }
  @RequirePermission(VIEW) @Post('devices/:id/name') rename(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: NameDto) { return this.session.renameDevice(u, id, b.name); }
  @RequirePermission(VIEW) @Post('devices/:id/remark') remark(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: RemarkDto) { return this.session.remarkDevice(u, id, b.remark); }
  @RequirePermission(VIEW) @Post('devices/:id/status') status(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: StatusDto) { return this.session.setDeviceStatus(u, id, b.status); }
  @RequirePermission(VIEW) @Post('devices/update-all') updateAll(@CurrentUser() u: AuthUser) { return this.session.requestUpdateAll(u); }
  @RequirePermission(VIEW) @Post('devices/:id/update') updateDevice(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.session.requestDeviceUpdate(u, id); }
  @RequirePermission(VIEW) @Post('devices/:id/delete') deleteDevice(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.session.deleteDevice(u, id); }
  @RequirePermission(VIEW) @Post('shops/:id/capture') capture(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.session.requestCapture(u, id); }
  @RequirePermission(VIEW) @Get('requests/:id') requestStatus(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.session.requestStatus(u, id); }
  @RequirePermission(VIEW) @Post('vouchers') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  uploadVoucher(@CurrentUser() u: AuthUser, @UploadedFile() f: Upload | undefined) { return this.session.uploadVoucher(u, f); }
  @RequirePermission(VIEW) @Get('vouchers/:fileId/url') voucherUrl(@CurrentUser() u: AuthUser, @Param('fileId', ParseIntPipe) id: number) { return this.session.voucherUrl(u, id); }
  @RequirePermission(VIEW) @Get('docs/:docId/vouchers') docVouchers(@CurrentUser() u: AuthUser, @Param('docId', ParseIntPipe) id: number) { return this.session.docVouchers(u, id); }
  @RequirePermission(VIEW) @Post('docs/:docId/vouchers') bindVouchers(@CurrentUser() u: AuthUser, @Param('docId', ParseIntPipe) id: number, @Body() b: BindVouchersDto) { return this.session.bindVouchers(u, id, b.fileIds); }
  @RequirePermission(VIEW) @Get('installer') async installer(@CurrentUser() u: AuthUser, @Res() res: { set(h: Record<string, string>): void; end(b: Buffer): void }) {
    const r = await this.session.downloadInstaller(u);
    res.set({ 'Content-Type': 'application/zip', 'Content-Length': String(r.buf.length), 'Content-Disposition': `attachment; filename="kudesi-assistant-${r.version}-windows.zip"`, 'X-Checksum-SHA256': r.sha256, 'Cache-Control': 'private, no-store' });
    res.end(r.buf);
  }
  @RequirePermission(VIEW) @Get('agent-releases') releases(@CurrentUser() u: AuthUser) { return this.session.listReleases(u); }
  @RequirePermission(VIEW) @Post('agent-releases') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PACKAGE_BYTES, files: 1 } }))
  publishRelease(@CurrentUser() u: AuthUser, @UploadedFile() f: Upload | undefined, @Body() b: PublishReleaseDto) { return this.session.publishRelease(u, f, b); }
  @RequirePermission(VIEW) @Post('agent-releases/:id/withdraw') withdrawRelease(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.session.withdrawRelease(u, id); }
  @RequirePermission(VIEW) @Get('audit') audit(@CurrentUser() u: AuthUser) { return this.session.audit(u); }
}

/** 助手接口：不走员工登录，用设备令牌（X-Device-Token）；令牌在绑定时只返回一次，库里只存哈希。 */
@Controller('agent')
export class AgentController {
  constructor(private readonly session: SessionService) {}

  @Public() @Post('register') register(@Body() b: RegisterDto) { return this.session.agentRegister(b); }
  @Public() @Post('heartbeat') heartbeat(@Headers('x-device-token') t: string | undefined, @Body() b: HeartbeatDto) { return this.session.agentHeartbeat(t, b); }
  @Public() @Get('release/download') async releaseDownload(@Headers('x-device-token') t: string | undefined, @Query('version') version: string | undefined, @Res() res: { set(h: Record<string, string>): void; end(b: Buffer): void }) {
    const { buf, sha256 } = await this.session.agentReleaseDownload(t, String(version ?? ''));
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length), 'X-Checksum-SHA256': sha256, 'Cache-Control': 'private, no-store' });
    res.end(buf);
  }
  @Public() @Post('update/report') updateReport(@Headers('x-device-token') t: string | undefined, @Body() b: UpdateReportDto) { return this.session.agentUpdateReport(t, b); }
  @Public() @Post('claim') claim(@Headers('x-device-token') t: string | undefined) { return this.session.agentClaim(t); }
  @Public() @Post('requests/:id/upload') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(@Headers('x-device-token') t: string | undefined, @Param('id', ParseIntPipe) id: number, @UploadedFile() f: Upload | undefined) { return this.session.agentUpload(t, id, f); }
  @Public() @Post('requests/:id/report') report(@Headers('x-device-token') t: string | undefined, @Param('id', ParseIntPipe) id: number, @Body() b: ReportDto) { return this.session.agentReport(t, id, b); }
}

class StoreStatusDto { @IsIn(['normal', 'abnormal', 'cancelled', 'inactive']) status!: string; @IsOptional() @IsInt() abnormalReasonId?: number; @IsOptional() @IsString() @MaxLength(300) reason?: string }

const M_VIEW = 'resource.company-store-maintenance.view';

/** 公司店铺维护（网页端）：和店铺提现同一套授权电脑，但店铺清单和权限独立。 */
@Controller('store-maintenance')
export class MaintenanceController {
  constructor(private readonly m: MaintenanceService) {}

  @RequirePermission(M_VIEW) @Get('overview') overview(@CurrentUser() u: AuthUser, @Query() q: OverviewQueryDto) { return this.m.overview(u, q); }
  @RequirePermission(M_VIEW) @Get('available-stores') available(@CurrentUser() u: AuthUser, @Query('keyword') k?: string) { return this.m.availableStores(u, k); }
  @RequirePermission(M_VIEW) @Get('abnormal-reasons') reasons(@CurrentUser() u: AuthUser) { return this.m.abnormalReasons(u); }
  @RequirePermission(M_VIEW) @Post('shops') add(@CurrentUser() u: AuthUser, @Body() b: AddShopsDto) { return this.m.addShops(u, b); }
  @RequirePermission(M_VIEW) @Post('shops/:id') update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: UpdateShopDto) { return this.m.updateShop(u, id, b); }
  @RequirePermission(M_VIEW) @Post('shops/:id/remove') remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.m.removeShop(u, id); }
  @RequirePermission(M_VIEW) @Post('shops/:id/reveal') reveal(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.m.revealPassword(u, id); }
  @RequirePermission(M_VIEW) @Post('shops/:id/open') open(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.m.requestOpen(u, id); }
  @RequirePermission(M_VIEW) @Get('shops/:id/history') history(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.m.history(u, id); }
  @RequirePermission(M_VIEW) @Post('shops/:id/store-status') storeStatus(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: StoreStatusDto) { return this.m.setStoreStatus(u, id, b); }
  @RequirePermission(M_VIEW) @Post('requests/:id/cancel') cancel(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.m.cancelRequest(u, id); }
  @RequirePermission(M_VIEW) @Get('requests/:id') requestStatus(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.m.requestStatus(u, id); }
  @RequirePermission(M_VIEW) @Get('devices') devices(@CurrentUser() u: AuthUser) { return this.m.devices(u); }
  @RequirePermission(M_VIEW) @Post('bind-codes') bind(@CurrentUser() u: AuthUser) { return this.m.createBindCode(u); }
  @RequirePermission(M_VIEW) @Post('devices/:id/name') rename(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: NameDto) { return this.m.renameDevice(u, id, b.name); }
  @RequirePermission(M_VIEW) @Post('devices/:id/remark') remark(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: RemarkDto) { return this.m.remarkDevice(u, id, b.remark); }
  @RequirePermission(M_VIEW) @Post('devices/:id/status') status(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: StatusDto) { return this.m.setDeviceStatus(u, id, b.status); }
  @RequirePermission(M_VIEW) @Get('audit') audit(@CurrentUser() u: AuthUser) { return this.m.audit(u); }
  @RequirePermission(M_VIEW) @Get('installer') async installer(@CurrentUser() u: AuthUser, @Res() res: { set(h: Record<string, string>): void; end(b: Buffer): void }) {
    const r = await this.m.downloadInstaller(u);
    res.set({ 'Content-Type': 'application/zip', 'Content-Length': String(r.buf.length), 'Content-Disposition': `attachment; filename="kudesi-assistant-${r.version}-windows.zip"`, 'X-Checksum-SHA256': r.sha256, 'Cache-Control': 'private, no-store' });
    res.end(r.buf);
  }
  @RequirePermission(M_VIEW) @Get('agent-releases') releases(@CurrentUser() u: AuthUser) { return this.m.listReleases(u); }
  @RequirePermission(M_VIEW) @Post('agent-releases') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PACKAGE_BYTES, files: 1 } }))
  publishRelease(@CurrentUser() u: AuthUser, @UploadedFile() f: Upload | undefined, @Body() b: PublishReleaseDto) { return this.m.publishRelease(u, f, b); }
  @RequirePermission(M_VIEW) @Post('agent-releases/:id/withdraw') withdrawRelease(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.m.withdrawRelease(u, id); }
  @RequirePermission(M_VIEW) @Post('devices/update-all') updateAll(@CurrentUser() u: AuthUser) { return this.m.requestUpdateAll(u); }
  @RequirePermission(M_VIEW) @Post('devices/:id/update') updateDevice(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.m.requestDeviceUpdate(u, id); }
  @RequirePermission(M_VIEW) @Post('devices/:id/delete') deleteDevice(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.m.deleteDevice(u, id); }
}
