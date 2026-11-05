import { Body, Controller, Get, Put, Param, ParseIntPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { AuthUser, CurrentUser, Public, RequirePermission } from '../common/auth.decorators';
import { UploadedFile as Upload } from '../integrations/files.service';
import { RecruitService, validRecruitToken } from './recruit.service';

class CreateInviteDto {
  @IsString() @IsNotEmpty() @MaxLength(60) label!: string;
  @IsOptional() @IsString() @MaxLength(40) channel?: string;
}
class ListQuery {
  @IsOptional() @IsString() @MaxLength(50) keyword?: string;
  @IsOptional() @IsIn(['mine', 'none', 'any']) handler?: 'mine' | 'none' | 'any';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}
class OpeningDto {
  @IsString() @IsNotEmpty() @MaxLength(100) title!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) headcount?: number;
  @IsOptional() @IsString() @MaxLength(1000) requirements?: string;
}
class OpeningUpdateDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) headcount?: number;
  @IsOptional() @IsString() @MaxLength(1000) requirements?: string;
  @IsOptional() @IsIn(['open', 'closed']) status?: 'open' | 'closed';
}
class ImportOpeningsDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsInt({ each: true }) @Min(1, { each: true }) positionIds!: number[] }
class PrintDto { @IsBoolean() withId!: boolean }
class RevealDto { @IsIn(['view', 'print']) purpose!: 'view' | 'print' }
class TokenDto { @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/, { message: '招聘二维码无效' }) token!: string }
/** 登记表内容交给共用的 normalizeRecruitForm 整理和校验，这里只限定整体形状 */
class SubmitDto extends TokenDto {
  @IsString() @Matches(/^[0-9a-f-]{36}$/i) requestKey!: string;
  @IsIn(['manual', 'image']) sourceMode!: 'manual' | 'image';
  @IsObject() form!: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(1) openingId?: number;
}
class RecognizeBody { @IsString() token!: string }

@Controller('recruit')
export class RecruitAdminController {
  constructor(private readonly service: RecruitService) {}
  @RequirePermission('features.recruit.view') @Get('invites') invites(@CurrentUser() u: AuthUser) { return this.service.listInvites(u); }
  @RequirePermission('features.recruit.view') @Post('invites') createInvite(@CurrentUser() u: AuthUser, @Body() b: CreateInviteDto) { return this.service.createInvite(u, b); }
  @RequirePermission('features.recruit.view') @Post('invites/:id/revoke') revoke(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.service.revokeInvite(u, id); }
  @RequirePermission('features.recruit.view') @Get('openings') openings(@CurrentUser() u: AuthUser) { return this.service.listOpenings(u); }
  @RequirePermission('features.recruit.view') @Get('position-candidates') candidates(@CurrentUser() u: AuthUser) { return this.service.positionCandidates(u); }
  @RequirePermission('features.recruit.view') @Post('openings/import') importOpenings(@CurrentUser() u: AuthUser, @Body() b: ImportOpeningsDto) { return this.service.importOpenings(u, b.positionIds); }
  @RequirePermission('features.recruit.view') @Post('openings') createOpening(@CurrentUser() u: AuthUser, @Body() b: OpeningDto) { return this.service.createOpening(u, b); }
  @RequirePermission('features.recruit.view') @Put('openings/:id') updateOpening(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: OpeningUpdateDto) { return this.service.updateOpening(u, id, b); }
  @RequirePermission('features.recruit.view') @Get('applications') list(@CurrentUser() u: AuthUser, @Query() q: ListQuery) { return this.service.listApplications(u, q); }
  @RequirePermission('features.recruit.view') @Get('stats') stats(@CurrentUser() u: AuthUser) { return this.service.stats(u); }
  @RequirePermission('features.recruit.view') @Get('applications/:id') get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.service.getApplication(u, id); }
  @RequirePermission('features.recruit.view') @Post('applications/:id/claim') claim(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.service.claim(u, id); }
  @RequirePermission('features.recruit.view') @Post('applications/:id/print') print(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: PrintDto) { return this.service.recordPrint(u, id, b.withId); }
  @RequirePermission('features.recruit.view') @Post('applications/:id/reveal-id') reveal(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: RevealDto) { return this.service.revealId(u, id, b.purpose); }
}

@Controller('recruit-apply')
export class RecruitPublicController {
  constructor(private readonly service: RecruitService) {}
  @Public() @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Post('preview') preview(@Body() b: TokenDto) { return this.service.preview(b.token); }
  @Public() @Throttle({ default: { limit: 8, ttl: 60_000 } }) @Post('recognize')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024, files: 1 } }))
  recognize(@Body() b: RecognizeBody, @UploadedFile() file: Upload | undefined) { return this.service.recognize(validRecruitToken(b.token) ? b.token : null, file); }
  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('submit') submit(@Body() b: SubmitDto) { return this.service.submit(b.token, b.requestKey, b.sourceMode, b.form, b.openingId); }
}
