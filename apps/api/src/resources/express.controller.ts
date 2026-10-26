import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PROVINCES } from '@kudesi/shared';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { OcrService } from '../integrations/ocr.service';
import { ExpressService } from './express.service';

const DATE = /^(\d{4}-\d{2}-\d{2})?$/;

class RuleDto {
  @IsString() @MaxLength(20) province!: string;
  @IsOptional() @IsNumber() @Min(0) shipWeightMin?: number | null;
  @IsOptional() @IsNumber() @Min(0) shipWeightMax?: number | null;
  @IsOptional() @IsBoolean() minExclusive?: boolean;
  @IsOptional() @IsBoolean() maxExclusive?: boolean;
  @IsOptional() @IsInt() @Min(0) fixedPrice?: number | null;
  @IsOptional() @IsNumber() firstWeight?: number | null;
  @IsOptional() @IsInt() @Min(0) firstPrice?: number | null;
  @IsOptional() @IsInt() @Min(0) extraPrice?: number | null;
}
class ReplaceRulesDto {
  @IsIn(['ai', 'manual']) source!: 'ai' | 'manual';
  @IsArray() @ArrayMaxSize(3000) @ValidateNested({ each: true }) @Type(() => RuleDto) rules!: RuleDto[];
}
class PriceConfirmDto {
  @IsArray() @ArrayMaxSize(3000) @ValidateNested({ each: true }) @Type(() => RuleDto) rules!: RuleDto[];
  @IsOptional() @IsString() @MaxLength(200) fileName?: string;
  @IsOptional() @IsString() @MaxLength(120) modelName?: string;
  @IsOptional() @Matches(DATE) effectiveStart?: string;
  @IsOptional() @Matches(DATE) effectiveEnd?: string;
  @IsOptional() @IsString() @MaxLength(5000) extraRemark?: string;
}
class SurchargeDto {
  @IsString() @MaxLength(160) name!: string;
  @IsOptional() @Matches(DATE) effectiveStart?: string;
  @IsOptional() @Matches(DATE) effectiveEnd?: string;
  @IsOptional() @IsString() @MaxLength(100) areaScope?: string;
  @IsIn(['fixed', 'percent', 'per_kg']) chargeType!: 'fixed' | 'percent' | 'per_kg';
  @IsOptional() @IsInt() @Min(0) amount?: number | null;
  @IsOptional() @IsNumber() @Min(0) percent?: number | null;
  @IsOptional() @IsIn(['all', 'below', 'above', 'between']) weightMode?: 'all' | 'below' | 'above' | 'between';
  @IsOptional() @IsNumber() @Min(0) weightStart?: number | null;
  @IsOptional() @IsNumber() @Min(0) weightEnd?: number | null;
}
class SurchargeConfirmDto {
  @IsString() @MaxLength(160) batchName!: string;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => SurchargeDto) rows!: SurchargeDto[];
  @IsOptional() @IsString() @MaxLength(200) fileName?: string;
  @IsOptional() @IsString() @MaxLength(120) modelName?: string;
}
class ReasonDto { @IsString() @MaxLength(200) reason!: string }
class ParcelLimitDto { @IsInt() @Min(1) @Max(100) parcelLimit!: number }
class OverrideDto {
  @IsNumber() @Min(0) weightFrom!: number;
  @IsNumber() @Min(0) weightTo!: number;
  /** 分；null = 取消这个重量段的手工运费 */
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) amount?: number | null;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
class ZoneRunDto { @IsNumber() @Min(0.01) @Max(1000) maxWeightKg!: number }
class PageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
}

type Upload = { originalname: string; buffer: Buffer; size: number };
const UPLOAD = { limits: { fileSize: 8 * 1024 * 1024, files: 1 } };

/**
 * 快递价格表的层级操作：总览、价格规则整表保存、AI 识别确认、级联删除；
 * 以及“成本表预估快递费”和“分区建议”。单条资料的新增/修改仍走通用的 /resources 接口。
 */
@Controller('finance/express')
export class ExpressController {
  constructor(private readonly express: ExpressService, private readonly ocr: OcrService) {}

  @RequirePermission('resource.finance-express-prices.view')
  @Get('tree')
  tree(@CurrentUser() u: AuthUser) { return this.express.tree(u); }

  @RequirePermission('resource.finance-express-prices.view')
  @Get('versions/:id')
  version(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.express.versionDetail(u, id); }

  @RequirePermission('resource.finance-express-prices.edit')
  @Put('versions/:id/rules')
  replaceRules(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReplaceRulesDto) {
    return this.express.replaceRules(u, id, b.source, b.rules, '整表保存价格规则');
  }

  @RequirePermission('resource.finance-express-prices.edit')
  @Post('versions/:id/recognize-price')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', UPLOAD))
  recognizePrice(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) _id: number, @UploadedFile() file: Upload | undefined) {
    return this.ocr.recognizeExpressDocument(u, file, 'price_table', PROVINCES);
  }

  @RequirePermission('resource.finance-express-prices.edit')
  @Post('versions/:id/recognize-price/confirm')
  @HttpCode(200)
  confirmPrice(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: PriceConfirmDto) { return this.express.confirmPriceRecognition(u, id, b); }

  @RequirePermission('resource.finance-express-prices.edit')
  @Post('versions/:id/recognize-surcharge')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', UPLOAD))
  recognizeSurcharge(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) _id: number, @UploadedFile() file: Upload | undefined) {
    return this.ocr.recognizeExpressDocument(u, file, 'surcharge_notice', PROVINCES);
  }

  @RequirePermission('resource.finance-express-prices.edit')
  @Post('versions/:id/recognize-surcharge/confirm')
  @HttpCode(200)
  confirmSurcharge(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: SurchargeConfirmDto) { return this.express.confirmSurchargeRecognition(u, id, b); }

  @RequirePermission('resource.finance-express-prices.delete')
  @Post('versions/:id/delete')
  @HttpCode(200)
  deleteVersion(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto) { return this.express.deleteVersion(u, id, b.reason); }

  @RequirePermission('resource.finance-express-prices.delete')
  @Post('branches/:id/delete')
  @HttpCode(200)
  deleteBranch(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto) { return this.express.deleteBranch(u, id, b.reason); }

  @RequirePermission('resource.finance-express-prices.delete')
  @Post('carriers/:id/delete')
  @HttpCode(200)
  deleteCarrier(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto) { return this.express.deleteCarrier(u, id, b.reason); }

  @RequirePermission('resource.finance-express-prices.delete')
  @Post('surcharge-batches/:id/delete')
  @HttpCode(200)
  deleteBatch(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto) { return this.express.deleteSurchargeBatch(u, id, b.reason); }

  // ---------- 成本表预估快递费 ----------

  @RequirePermission('resource.finance-freight-overrides.view', 'product.cost.view')
  @Get('estimates')
  estimates(@CurrentUser() u: AuthUser) { return this.express.getEstimates(u); }

  @RequirePermission('resource.finance-freight-overrides.edit', 'product.cost.edit')
  @Post('estimates/recalculate')
  @HttpCode(200)
  recalc(@CurrentUser() u: AuthUser) { return this.express.recalculate(u); }

  @RequirePermission('resource.finance-freight-overrides.edit', 'product.cost.edit')
  @Put('estimates/parcel-limit')
  parcelLimit(@CurrentUser() u: AuthUser, @Body() b: ParcelLimitDto) { return this.express.setParcelLimit(u, b.parcelLimit); }

  @RequirePermission('resource.finance-freight-overrides.edit', 'product.cost.edit')
  @Put('estimates/override')
  override(@CurrentUser() u: AuthUser, @Body() b: OverrideDto) { return this.express.setOverride(u, b.weightFrom, b.weightTo, b.amount ?? null, b.reason); }

  // ---------- 分区建议生成记录 ----------

  @RequirePermission('finance.zone-suggestion.view', 'product.cost.view')
  @Get('zone-runs')
  zoneRuns(@CurrentUser() u: AuthUser, @Query() q: PageDto) { return this.express.listZoneRuns(u, q.page ?? 1, q.pageSize ?? 5); }

  @RequirePermission('finance.zone-suggestion.view', 'product.cost.view')
  @Get('zone-runs/:id')
  zoneRun(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.express.getZoneRun(u, id); }

  @RequirePermission('finance.zone-suggestion.view', 'product.cost.view', 'resource.finance-express-prices.edit')
  @Post('zone-runs')
  @HttpCode(200)
  generate(@CurrentUser() u: AuthUser, @Body() b: ZoneRunDto) { return this.express.generateZoneRun(u, b.maxWeightKg); }

  @RequirePermission('finance.zone-suggestion.view', 'resource.finance-express-prices.delete')
  @Delete('zone-runs/:id')
  removeRun(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.express.deleteZoneRun(u, id); }
}
