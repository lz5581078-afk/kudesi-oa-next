import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { BaseCodeToolsService } from './base-code-tools.service';

class VerifyItemDto {
  @IsInt() @Min(1) id!: number;
  @IsString() @MaxLength(64) signature!: string;
  @IsOptional() @IsString() @MaxLength(64) uploadSignature?: string;
}
class VerifyDto {
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => VerifyItemDto) items!: VerifyItemDto[];
  @IsBoolean() confirmed!: boolean;
  @IsBoolean() syncToJst!: boolean;
  @IsOptional() @IsBoolean() replaceConfirmed?: boolean;
}
class PreviewDto {
  @IsIn(['pending', 'source']) mode!: 'pending' | 'source';
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsInt({ each: true }) ids?: number[];
}
class GroupDto {
  @IsString() @MaxLength(64) token!: string;
  @IsArray() @ArrayMaxSize(120) @IsInt({ each: true }) ids!: number[];
}
class ExecuteDto {
  @IsIn(['pending', 'source']) mode!: 'pending' | 'source';
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => GroupDto) groups!: GroupDto[];
  @IsString() @Length(2, 500) reason!: string;
  @IsOptional() @IsBoolean() disableConfirmed?: boolean;
}

/** 商品基础编码页面用的辅助接口：核对报告、批量验证、删除。普通增删改查走 /api/resources。 */
@Controller('finance/base-codes')
export class BaseCodeToolsController {
  constructor(private readonly tools: BaseCodeToolsService) {}

  @RequirePermission('resource.finance-base-codes.view')
  @Get('overview')
  overview(@CurrentUser() u: AuthUser) { return this.tools.overview(u); }

  @RequirePermission('resource.finance-base-codes.view')
  @Get('deletion-jobs')
  jobs(@CurrentUser() u: AuthUser) { return this.tools.deletionJobs(u); }

  @RequirePermission('resource.finance-base-codes.view')
  @Get(':id/report')
  report(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.tools.report(u, id); }

  @RequirePermission('resource.finance-base-codes.edit')
  @Post('verify')
  @HttpCode(200)
  verify(@CurrentUser() u: AuthUser, @Body() b: VerifyDto) {
    return this.tools.verify(u, b.items, { confirmed: b.confirmed, syncToJst: b.syncToJst, replaceConfirmed: b.replaceConfirmed });
  }

  @RequirePermission('resource.finance-base-codes.delete')
  @Post('deletion/preview')
  @HttpCode(200)
  preview(@CurrentUser() u: AuthUser, @Body() b: PreviewDto) { return this.tools.deletionPreview(u, b.mode, b.ids); }

  @RequirePermission('resource.finance-base-codes.delete')
  @Post('deletion/execute')
  @HttpCode(200)
  execute(@CurrentUser() u: AuthUser, @Body() b: ExecuteDto) { return this.tools.deletionExecute(u, b.mode, b.groups, b.reason, b.disableConfirmed === true); }
}
