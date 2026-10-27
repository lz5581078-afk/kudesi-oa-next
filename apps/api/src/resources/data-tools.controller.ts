import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query, Headers } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuthUser, CurrentUser, Public, RequirePermission } from '../common/auth.decorators';
import { CatalogApiService } from './catalog-api.service';
import { CostService } from './cost.service';
import { CATALOG_SCOPE, DataToolsService } from './data-tools.service';
import { ResourcesService } from './resources.service';

class HistoryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) bundleId?: number;
  @IsOptional() @IsString() @MaxLength(60) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
class RegisterDto {
  @IsOptional() @IsInt() @Min(1) bundleId?: number;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
class ZoneDto { @Type(() => Number) @IsNumber() @Min(0.01) @Max(1000) maxWeightKg!: number }
class MatchDto {
  @IsOptional() @IsIn(['production', 'supplier_oem', 'dispatch']) usageScene?: string;
  @IsIn(['base_code', 'bundle', 'product_archive']) targetType!: 'base_code' | 'bundle' | 'product_archive';
  @IsOptional() @IsString() @MaxLength(120) targetCode?: string;
  @IsOptional() @IsInt() @Min(1) categoryId?: number;
  @IsOptional() @IsInt() @Min(1) brandId?: number;
  @IsOptional() @IsInt() @Min(1) scenarioId?: number;
  @IsOptional() @IsNumber() @Min(0) weightKg?: number;
}
class KeyDto { @IsString() @MaxLength(100) name!: string; @IsOptional() @IsIn(['verified_bundle_read', 'company_catalog_read']) scope?: string }
class PreviewDto { @IsOptional() @IsIn(['true', 'false']) includePlatforms?: string }
class ResetDto {
  @IsString() confirm!: string;
  @IsOptional() @IsBoolean() includePlatforms?: boolean;
  @IsOptional() @IsString() @MaxLength(200) label?: string;
}
class RestoreDto { @IsString() confirm!: string }
class ExpressRowDto {
  @IsString() @MaxLength(100) carrier!: string;
  @IsOptional() @IsString() @MaxLength(100) branch?: string;
  @IsString() province!: string;
  @IsOptional() @IsNumber() shipWeightMin?: number | null;
  @IsOptional() @IsNumber() shipWeightMax?: number | null;
  @IsOptional() @IsNumber() firstWeight?: number | null;
  @IsOptional() @IsInt() firstPrice?: number | null;
  @IsOptional() @IsInt() extraPrice?: number | null;
  @IsOptional() @IsInt() fixedPrice?: number | null;
  @IsOptional() @Matches(/^(\d{4}-\d{2}-\d{2})?$/) validFrom?: string;
  @IsOptional() @Matches(/^(\d{4}-\d{2}-\d{2})?$/) validTo?: string;
}
class ExpressConfirmDto { @IsArray() @ValidateNested({ each: true }) @Type(() => ExpressRowDto) rows!: ExpressRowDto[] }

@Controller('finance')
export class DataToolsController {
  constructor(private readonly tools: DataToolsService, private readonly cost: CostService, private readonly resources: ResourcesService) {}

  @RequirePermission('finance.cost-history.view', 'product.cost.view')
  @Get('cost-history')
  history(@CurrentUser() u: AuthUser, @Query() q: HistoryDto) { return this.tools.costHistory(u, { bundleId: q.bundleId, keyword: q.keyword, page: q.page ?? 1, pageSize: q.pageSize ?? 20 }); }

  @RequirePermission('finance.cost-history.view', 'product.cost.edit')
  @Post('cost-history/register')
  register(@CurrentUser() u: AuthUser, @Body() b: RegisterDto) { return this.tools.registerCost(u, b.bundleId, b.reason?.trim() || '手工登记'); }

  @RequirePermission('finance.zone-suggestion.view', 'product.cost.view')
  @Get('zone-suggestion')
  zone(@CurrentUser() u: AuthUser, @Query() q: ZoneDto) { return this.cost.zoneSuggestion(u, q.maxWeightKg); }

  @RequirePermission('finance.packaging-match.view')
  @Post('packaging-match')
  @HttpCode(200)
  match(@CurrentUser() u: AuthUser, @Body() b: MatchDto) { return this.tools.packagingMatch(u, b); }

  @RequirePermission('finance.api-keys.view')
  @Get('api-keys')
  keys(@CurrentUser() u: AuthUser) { return this.tools.listKeys(u); }

  @RequirePermission('finance.api-keys.view')
  @Post('api-keys')
  createKey(@CurrentUser() u: AuthUser, @Body() b: KeyDto) { return this.tools.createKey(u, b.name, b.scope); }

  @RequirePermission('finance.api-keys.view')
  @Delete('api-keys/:id')
  revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.tools.revokeKey(u, id); }

  @RequirePermission('finance.master-reset.view')
  @Get('master-reset/preview')
  preview(@CurrentUser() u: AuthUser, @Query() q: PreviewDto) { return this.tools.resetPreview(u, q.includePlatforms !== 'false'); }

  @RequirePermission('finance.master-reset.view')
  @Post('master-reset/execute')
  @HttpCode(200)
  reset(@CurrentUser() u: AuthUser, @Body() b: ResetDto) { return this.tools.resetExecute(u, b); }

  @RequirePermission('finance.master-reset.view')
  @Get('master-reset/snapshots')
  snapshots(@CurrentUser() u: AuthUser) { return this.tools.snapshots(u); }

  @RequirePermission('finance.master-reset.view')
  @Post('master-reset/snapshots/:id/restore')
  @HttpCode(200)
  restore(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: RestoreDto) { return this.tools.restore(u, id, b.confirm); }

  /** 快递价格表识别结果确认后逐行入库：走资料的统一校验，失败的行会带原因返回，成功的不受影响 */
  @RequirePermission('resource.finance-express-prices.create')
  @Post('express-recognize/confirm')
  @HttpCode(200)
  async expressConfirm(@CurrentUser() u: AuthUser, @Body() b: ExpressConfirmDto) {
    const results: Array<{ index: number; ok: boolean; error?: string }> = [];
    for (const [index, r] of b.rows.entries()) {
      try {
        await this.resources.create(u, 'finance-express-prices', {
          carrier: r.carrier, branch: r.branch || undefined, province: r.province, shipWeightMin: r.shipWeightMin ?? 0, shipWeightMax: r.shipWeightMax ?? undefined,
          firstWeight: r.firstWeight ?? undefined, firstPrice: r.firstPrice ?? undefined, extraPrice: r.extraPrice ?? undefined, fixedPrice: r.fixedPrice ?? undefined,
          validFrom: r.validFrom || undefined, validTo: r.validTo || undefined,
        });
        results.push({ index, ok: true });
      } catch (e) {
        results.push({ index, ok: false, error: (e as Error).message });
      }
    }
    return { created: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results };
  }
}

/** 外部程序用 X-API-Key 读已验证的组合；不走登录，也不接受写入 */
@Controller('external/v1')
export class ExternalFeedController {
  constructor(private readonly tools: DataToolsService) {}

  @Public()
  @Get('verified-bundles')
  async feed(@Headers('x-api-key') key: string | undefined) {
    const companyId = await this.tools.authenticateKey(key);
    return this.tools.externalFeed(companyId);
  }
}

class CatalogDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) afterId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() @MaxLength(120) code?: string;
}

/** 商品与成本目录：外部程序用 company_catalog_read 密钥只读，没有任何写入接口 */
@Controller('external/catalog/v1')
export class CatalogApiController {
  constructor(private readonly tools: DataToolsService, private readonly catalog: CatalogApiService) {}

  @Public()
  @Get('bundle-categories')
  async bundleCategories(@Headers('x-api-key') key: string | undefined, @Query() q: CatalogDto) { return this.catalog.bundleCategories(await this.tools.authenticateKey(key, CATALOG_SCOPE), q); }

  @Public()
  @Get('cost-categories')
  async costCategories(@Headers('x-api-key') key: string | undefined, @Query() q: CatalogDto) { return this.catalog.costCategories(await this.tools.authenticateKey(key, CATALOG_SCOPE), q); }

  @Public()
  @Get('sku-costs')
  async skuCosts(@Headers('x-api-key') key: string | undefined, @Query() q: CatalogDto) { return this.catalog.skuCosts(await this.tools.authenticateKey(key, CATALOG_SCOPE), q); }

  @Public()
  @Get('bundle-codes')
  async bundleCodes(@Headers('x-api-key') key: string | undefined, @Query() q: CatalogDto) { return this.catalog.bundleCodes(await this.tools.authenticateKey(key, CATALOG_SCOPE), q); }
}
