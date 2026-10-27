import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { BundleToolsService } from './bundle-tools.service';

class LineDto {
  @IsIn(['main', 'gift', 'auxiliary', 'package', 'label', 'instruction', 'other', 'labor']) role!: string;
  @IsOptional() @IsInt() @Min(1) baseCodeId?: number;
  @IsOptional() @IsInt() @Min(1) laborId?: number;
  @IsNumber() @Min(0.001) qty!: number;
  // 旧系统 BOM 行字段（单位、损耗率、必需、进聚水潭、成本归集/处理、排序、生效失效日、备注）；取值和范围由 normalizeLineExtras 再检查
  @IsOptional() @IsString() @MaxLength(20) unit?: string;
  @IsOptional() @IsNumber() @Min(0) lossRate?: number;
  @IsOptional() @IsBoolean() isRequired?: boolean;
  @IsOptional() @IsBoolean() includeInJst?: boolean;
  @IsOptional() @IsString() @MaxLength(30) costBucket?: string;
  @IsOptional() @IsString() @MaxLength(30) costTreatment?: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsString() @MaxLength(10) effectiveFrom?: string;
  @IsOptional() @IsString() @MaxLength(10) effectiveTo?: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}
class TargetDto {
  @IsInt() @Min(1) platformId!: number;
  @IsInt() @Min(1) scenarioId!: number;
  @IsOptional() @IsString() @MaxLength(8) configNo?: string;
  @IsOptional() @IsInt() @Min(1) bundleCategoryId?: number;
  @IsOptional() @IsInt() @Min(1) brandId?: number;
}
class PlanDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => LineDto) lines!: LineDto[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => TargetDto) targets!: TargetDto[];
}
class RevisionDto {
  @IsString() @Length(2, 500) reason!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => LineDto) lines!: LineDto[];
}
class ReasonDto { @IsString() @Length(2, 500) reason!: string }
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
class DeleteDto {
  @IsString() @MaxLength(64) token!: string;
  @IsString() @MaxLength(120) confirmCode!: string;
  @IsString() @Length(2, 500) reason!: string;
}
class ArchiveDto {
  @IsString() @Length(2, 500) reason!: string;
  @IsOptional() @IsBoolean() disableConfirmed?: boolean;
}

@Controller('finance/bundles')
export class BundleToolsController {
  constructor(private readonly tools: BundleToolsService) {}

  @RequirePermission('resource.finance-bundles.view')
  @Get('overview')
  overview(@CurrentUser() u: AuthUser) { return this.tools.overview(u); }

  @RequirePermission('resource.finance-bundles.create')
  @Post('preview')
  @HttpCode(200)
  preview(@CurrentUser() u: AuthUser, @Body() b: PlanDto) { return this.tools.preview(u, b.lines, b.targets); }

  @RequirePermission('resource.finance-bundles.create')
  @Post('generate')
  @HttpCode(200)
  generate(@CurrentUser() u: AuthUser, @Body() b: PlanDto) { return this.tools.generate(u, b.lines, b.targets); }

  @RequirePermission('resource.finance-bundles.edit')
  @Post('verify')
  @HttpCode(200)
  verify(@CurrentUser() u: AuthUser, @Body() b: VerifyDto) { return this.tools.verify(u, b.items, { confirmed: b.confirmed, syncToJst: b.syncToJst, replaceConfirmed: b.replaceConfirmed }); }

  @RequirePermission('resource.finance-bundles.view')
  @Get(':id/report')
  report(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.tools.report(u, id); }

  @RequirePermission('resource.finance-bundles.edit')
  @Post(':id/revisions')
  @HttpCode(200)
  revise(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: RevisionDto) { return this.tools.createRevision(u, id, b.reason, b.lines); }

  @RequirePermission('resource.finance-bundles.edit')
  @Post(':id/revisions/cancel')
  @HttpCode(200)
  cancelRevision(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto) { return this.tools.cancelRevision(u, id, b.reason); }

  @RequirePermission('resource.finance-bundles.delete')
  @Get(':id/deletion')
  deletion(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.tools.deletionPreview(u, id); }

  @RequirePermission('resource.finance-bundles.delete')
  @Post(':id/deletion')
  @HttpCode(200)
  deleteIt(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: DeleteDto) { return this.tools.deletionExecute(u, id, b.token, b.confirmCode, b.reason); }

  @RequirePermission('resource.finance-bundles.delete')
  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ArchiveDto) { return this.tools.archive(u, id, b.reason, b.disableConfirmed === true); }
}
