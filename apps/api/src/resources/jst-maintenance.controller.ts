import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { JstMaintenanceService, UploadForm } from './jst-maintenance.service';

class CheckDto {
  @IsOptional() @IsString() @MaxLength(120) skuId?: string;
  @IsOptional() @IsString() @MaxLength(120) styleId?: string;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
}
class UploadDto { @IsObject() form!: UploadForm }
class LogsDto {
  @IsOptional() @IsString() @MaxLength(60) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

@Controller('finance/jst-maintenance')
export class JstMaintenanceController {
  constructor(private readonly svc: JstMaintenanceService) {}

  @RequirePermission('finance.jst-maintenance.view')
  @Get('options')
  options(@CurrentUser() u: AuthUser) { return this.svc.options(u); }

  @RequirePermission('finance.jst-maintenance.view')
  @Post('check-duplicate')
  @HttpCode(200)
  check(@CurrentUser() u: AuthUser, @Body() b: CheckDto) { return this.svc.checkDuplicate(u, b); }

  @RequirePermission('finance.jst-maintenance.view', 'product.cost.edit')
  @Post('upload')
  @HttpCode(200)
  upload(@CurrentUser() u: AuthUser, @Body() b: UploadDto) { return this.svc.upload(u, b.form); }

  @RequirePermission('finance.jst-maintenance.view')
  @Get('logs')
  logs(@CurrentUser() u: AuthUser, @Query() q: LogsDto) { return this.svc.logs(u, { keyword: q.keyword, page: q.page ?? 1, pageSize: q.pageSize ?? 20 }); }
}
