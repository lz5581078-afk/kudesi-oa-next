import { PROVINCES } from '@kudesi/shared';
import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { AiProviderService } from './ai-providers.service';
import { FilesService, MAX_UPLOAD_BYTES } from './files.service';
import { IntegrationSettingsService } from './integration-settings.service';
import { OcrService } from './ocr.service';
import { STORAGE_FACTORY } from './files.service';
import { Inject } from '@nestjs/common';
import type { StorageFactory } from './files.service';

class QiniuDto {
  @IsString() @MaxLength(100) accessKey!: string;
  @IsOptional() @IsString() @MaxLength(200) secretKey?: string;
  @IsString() @MaxLength(100) bucket!: string;
  @IsString() @MaxLength(16) zone!: string;
  @IsString() @MaxLength(200) domain!: string;
  @IsBoolean() isPrivate!: boolean;
}

class VisionDto {
  @IsString() @MaxLength(200) baseUrl!: string;
  @IsOptional() @IsString() @MaxLength(300) apiKey?: string;
  @IsString() @MaxLength(100) model!: string;
  @IsBoolean() enabled!: boolean;
}

class AiProviderDto {
  @IsString() @MaxLength(80) name!: string;
  @IsString() @MaxLength(200) baseUrl!: string;
  @IsOptional() @IsString() @MaxLength(300) apiKey?: string;
  @IsOptional() @IsString() @MaxLength(100) modelName?: string;
  @IsOptional() @IsIn(['active', 'testing', 'inactive']) status?: string;
}
class AiDefaultDto { @IsOptional() @IsInt() providerId?: number | null; @IsOptional() @IsString() @MaxLength(150) modelId?: string }
class AiSwitchDto { @IsBoolean() enabled!: boolean }

class UploadDto {
  @IsString() @MaxLength(32) type!: string;
  @IsString() @MaxLength(48) field!: string;
}

type Upload = { originalname: string; buffer: Buffer; size: number };

@Controller('settings/integrations')
export class IntegrationSettingsController {
  constructor(
    private readonly settings: IntegrationSettingsService,
    private readonly ocr: OcrService,
    private readonly files: FilesService,
    @Inject(STORAGE_FACTORY) private readonly storageFactory: StorageFactory,
  ) {}

  @RequirePermission('system.integrations.view')
  @Get()
  overview(@CurrentUser() user: AuthUser) {
    return this.settings.overview(user.companyId);
  }

  @RequirePermission('system.integrations.edit')
  @Put('qiniu')
  saveQiniu(@CurrentUser() user: AuthUser, @Body() dto: QiniuDto) {
    return this.settings.saveQiniu(user, dto);
  }

  @RequirePermission('system.integrations.edit')
  @Put('vision')
  saveVision(@CurrentUser() user: AuthUser, @Body() dto: VisionDto) {
    return this.settings.saveVision(user, dto);
  }

  /** 真的传一个很小的测试文件再删掉，验证 AK/SK、空间、区域都对。 */
  @RequirePermission('system.integrations.edit')
  @Post('qiniu/test')
  async testQiniu(@CurrentUser() user: AuthUser) {
    return this.files.selfTest(user);
  }

  @RequirePermission('system.integrations.edit')
  @Post('vision/test')
  testVision(@CurrentUser() user: AuthUser) {
    return this.ocr.pingVision(user);
  }
}

/** AI 服务商、模型同步、识别场景的默认模型。API Key 只写不读。 */
@Controller('settings/ai')
export class AiSettingsController {
  constructor(private readonly ai: AiProviderService) {}

  @RequirePermission('system.ai-api.view') @Get()
  overview(@CurrentUser() u: AuthUser) { return this.ai.overview(u.companyId); }

  @RequirePermission('system.ai-api.edit') @Post('providers')
  create(@CurrentUser() u: AuthUser, @Body() b: AiProviderDto) { return this.ai.save(u, null, b); }

  @RequirePermission('system.ai-api.edit') @Put('providers/:id')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: AiProviderDto) { return this.ai.save(u, id, b); }

  @RequirePermission('system.ai-api.edit') @Delete('providers/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.ai.remove(u, id); }

  @RequirePermission('system.ai-api.view') @Get('providers/:id/models')
  models(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.ai.models(u.companyId, id); }

  @RequirePermission('system.ai-api.edit') @Post('providers/:id/sync-models')
  sync(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.ai.syncModels(u, id); }

  @RequirePermission('system.ai-api.edit') @Put('sync-switch')
  syncSwitch(@CurrentUser() u: AuthUser, @Body() b: AiSwitchDto) { return this.ai.setSyncEnabled(u, b.enabled); }

  @RequirePermission('system.ocr.view') @Get('defaults')
  defaults(@CurrentUser() u: AuthUser) { return this.ai.defaults(u.companyId); }

  @RequirePermission('system.ocr.edit') @Put('defaults/:scope')
  setDefault(@CurrentUser() u: AuthUser, @Param('scope') scope: string, @Body() b: AiDefaultDto) { return this.ai.setDefault(u, scope, b.providerId ?? null, b.modelId); }
}

@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  // 资料类型在表单里，权限由服务按“该资料的新增/编辑权限”检查
  @AuthenticatedOnly()
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(@CurrentUser() user: AuthUser, @Body() dto: UploadDto, @UploadedFile() file: Upload | undefined) {
    return this.files.upload(user, dto.type, dto.field, file);
  }

  // 按文件所属资料的查看权限检查
  @AuthenticatedOnly()
  @Get(':id/url')
  url(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.files.url(user, id);
  }
}

@Controller('ocr')
export class OcrController {
  constructor(private readonly ocr: OcrService) {}

  @AuthenticatedOnly()
  @Post('license')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024, files: 1 } }))
  license(@CurrentUser() user: AuthUser, @UploadedFile() file: Upload | undefined) {
    return this.ocr.recognizeLicense(user, file);
  }

  @AuthenticatedOnly()
  @Post('express-prices')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024, files: 1 } }))
  express(@CurrentUser() user: AuthUser, @UploadedFile() file: Upload | undefined) {
    return this.ocr.recognizeExpress(user, file, PROVINCES);
  }
}
