import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, Public } from '../common/auth.decorators';
import { MAX_UPLOAD_BYTES } from './files.service';
import { PhoneUploadService } from './phone-upload.service';

class CreateDto {
  @IsString() @MaxLength(40) type!: string;
  @IsString() @MaxLength(48) field!: string;
}
class TokenDto { @IsString() @MaxLength(120) token!: string }
type Upload = { originalname: string; buffer: Buffer; size: number };

@Controller('phone-uploads')
export class PhoneUploadController {
  constructor(private readonly phone: PhoneUploadService) {}

  // 登录用户：权限（有该资料的新增/编辑权限）由服务检查
  @AuthenticatedOnly()
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDto) { return this.phone.create(user, dto.type, dto.field); }

  @AuthenticatedOnly()
  @Get(':id')
  status(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.phone.status(user, id); }

  // 手机端（免登录，只认令牌）：限流收紧
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('public/inspect')
  inspect(@Body() dto: TokenDto) { return this.phone.inspect(dto.token); }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('public/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(@Body() dto: TokenDto, @UploadedFile() file: Upload | undefined) { return this.phone.upload(dto.token, file); }
}
