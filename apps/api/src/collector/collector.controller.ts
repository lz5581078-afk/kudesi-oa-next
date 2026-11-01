import { Body, Controller, Get, Put, Post } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Min, Max, MaxLength, IsArray, ArrayMaxSize } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { CollectorIdentityService } from './collector-identity.service';
import { SpeechSettingsService } from './speech-settings.service';
import { CollectorService } from './collector.service';

class SpeechSettingsDto {
  @IsOptional() @IsString() @MaxLength(300) apiKey?: string;
  @IsBoolean() enabled!: boolean;
  @IsBoolean() fileEnabled!: boolean;
  @IsBoolean() realtimeEnabled!: boolean;
  @IsInt() @Min(1) @Max(20) maxConcurrent!: number;
  @IsOptional() @IsBoolean() allEmployees?: boolean;
}
class SpeechFileDto {
  @IsString() @MaxLength(5130000) audio!: string;
  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(40, { each: true }) hotwords!: string[];
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
  constructor(private readonly identity: CollectorIdentityService, private readonly collector: CollectorService) {}
  @AuthenticatedOnly() @Get('session')
  async session(@CurrentUser() u: AuthUser) {
    return this.identity.session(u);
  }
  @AuthenticatedOnly() @Post('file')
  async file(@CurrentUser() u: AuthUser, @Body() dto: SpeechFileDto) {
    await this.session(u);
    return this.collector.transcribe(u.companyId, u.id, dto.audio, dto.hotwords);
  }
}
