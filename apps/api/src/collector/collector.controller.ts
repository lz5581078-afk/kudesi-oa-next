import { Body, Controller, Get, Put, Post, Param, Header, HttpException, StreamableFile } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Min, Max, MaxLength, IsArray, ArrayMaxSize, IsUUID, Equals } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission, Public } from '../common/auth.decorators';
import { CollectorIdentityService } from './collector-identity.service';
import { MAX_SPEECH_CONCURRENT, SpeechSettingsService } from './speech-settings.service';
import { CollectorService } from './collector.service';
import { CollectorFileService } from './collector-file.service';

class SpeechSettingsDto {
  @IsOptional() @IsString() @MaxLength(300) apiKey?: string;
  @IsBoolean() enabled!: boolean;
  @IsBoolean() fileEnabled!: boolean;
  @IsBoolean() realtimeEnabled!: boolean;
  @IsInt() @Min(1) @Max(MAX_SPEECH_CONCURRENT) maxConcurrent!: number;
  @IsOptional() @IsBoolean() allEmployees?: boolean;
}
class SpeechFileDto {
  @IsString() @MaxLength(5130000) audio!: string;
  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(40, { each: true }) hotwords!: string[];
  @IsOptional() @Equals(2) apiVersion?: number;
  @IsOptional() @IsUUID() requestId?: string;
}
@Controller('settings/integrations/speech')
export class SpeechSettingsController {
  constructor(private readonly settings: SpeechSettingsService) {}
  @RequirePermission('system.integrations.view') @Get()
  overview(@CurrentUser() u: AuthUser) { return this.settings.overview(u.companyId); }
  @RequirePermission('system.integrations.edit') @Put()
  save(@CurrentUser() u: AuthUser, @Body() dto: SpeechSettingsDto) { return this.settings.save(u, dto); }
}

@Controller('collector')
export class CollectorController {
  constructor(private readonly identity: CollectorIdentityService, private readonly collector: CollectorService,
    private readonly files: CollectorFileService) {}
  @AuthenticatedOnly() @Get('session')
  async session(@CurrentUser() u: AuthUser) {
    return this.identity.session(u);
  }
  @AuthenticatedOnly() @Post('file')
  async file(@CurrentUser() u: AuthUser, @Body() dto: SpeechFileDto) {
    await this.session(u);
    if (dto.apiVersion !== 2) throw new HttpException('分段识别已升级为录音文件识别 2.0，请更新小白客户端后重新识别；录像保留', 426);
    return this.files.start(u.companyId, u.id, dto.audio, dto.hotwords, dto.requestId ?? '');
  }
  @AuthenticatedOnly() @Get('file/tasks/:token')
  async query(@CurrentUser() u: AuthUser, @Param('token') token: string) {
    await this.session(u); return this.files.query(u.companyId, u.id, token);
  }
  // The opaque, encrypted capability grants only this short-lived audio, never OA login.
  @Public() @Get('audio/:token') @Header('Cache-Control', 'private, no-store') @Header('X-Content-Type-Options', 'nosniff')
  async audio(@Param('token') token: string) { return new StreamableFile(await this.files.audio(token), { type: 'audio/wav', disposition: 'inline' }); }
}
