import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested, ArrayMaxSize, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { CostMaintainService } from './cost-maintain.service';
import { CostService } from './cost.service';
import { DataToolsService } from './data-tools.service';
import { PricingDebugService } from './pricing-debug.service';

class TableDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) categoryId?: number;
  @IsOptional() @IsString() @MaxLength(100) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}
class ExportTableDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) categoryId?: number;
  @IsOptional() @IsString() @MaxLength(100) keyword?: string;
}
class FreightDto { @Type(() => Number) @Min(0.01) weightG!: number }
class PageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @IsString() @MaxLength(100) keyword?: string;
}
class PricingHistoryDto extends PageDto { @IsOptional() @Type(() => Number) @IsInt() @Min(1) bundleId?: number }
/** 保存售价设置。profitPercent 为 null = 不单独设置（继承分类）；百分数最多 6 位小数，具体范围由服务校验 */
class PricingDto {
  @IsString() @MaxLength(32) revision!: string;
  @IsString() @MaxLength(200) carrierName!: string;
  @IsOptional() @IsNumber() profitPercent?: number | null;
  @IsString() @MaxLength(300) reason!: string;
}
class CategoryMarginDto {
  @IsString() @MaxLength(32) revision!: string;
  @IsOptional() @IsNumber() profitPercent?: number | null;
  @IsString() @MaxLength(300) reason!: string;
}

class ComponentsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) categoryId?: number;
  @IsOptional() @IsString() @MaxLength(100) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}
class DebugListDto extends ComponentsDto {
  @IsOptional() @IsIn(['mine']) exclusive?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) baseCodeId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
class ProfitDto {
  @IsInt() @Min(1) id!: number;
  @IsInt() @Min(0) @Max(100_000_000) amountCents!: number;
}
class SliderDto {
  @IsInt() @Min(1) id!: number;
  @IsInt() @Min(0) @Max(140) step!: number;
  @IsOptional() @ValidateNested() @Type(() => ProfitDto) profit?: ProfitDto;
}
class QuoteInputDto extends SliderDto { @IsNumber() value!: number }
class QuoteDto {
  @IsIn(['roiToPrice', 'priceToRoi']) mode!: 'roiToPrice' | 'priceToRoi';
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => QuoteInputDto) inputs!: QuoteInputDto[];
}
class ExportInputDto extends SliderDto {
  @IsIn(['roiToPrice', 'priceToRoi', 'sliderPrice']) mode!: 'roiToPrice' | 'priceToRoi' | 'sliderPrice';
  @IsOptional() @IsNumber() value?: number;
  @IsOptional() @IsInt() sellingPriceCents?: number;
  @IsOptional() @IsNumber() roi?: number;
  @IsOptional() @IsInt() sliderPriceCents?: number;
}
class ExportDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10000) @ValidateNested({ each: true }) @Type(() => ExportInputDto) inputs!: ExportInputDto[] }

// 成本、最低售价是敏感数据：既要有页面权限，也要有成本查看权限（服务端把关，不是前端隐藏）
@Controller('finance')
export class CostController {
  constructor(
    private readonly cost: CostService,
    private readonly maintain: CostMaintainService,
    private readonly tools: DataToolsService,
    private readonly debug: PricingDebugService,
  ) {}

  @RequirePermission('finance.cost-table.view', 'product.cost.view')
  @Get('cost-table')
  table(@CurrentUser() user: AuthUser, @Query() q: TableDto) {
    return this.cost.table(user, { categoryId: q.categoryId, keyword: q.keyword, page: q.page ?? 1, pageSize: q.pageSize ?? 20 });
  }

  // 注意：export、category-margins 要排在 :bundleId 之前
  @RequirePermission('finance.cost-table.view', 'product.cost.view')
  @Get('cost-table/export')
  exportTable(@CurrentUser() user: AuthUser, @Query() q: ExportTableDto) {
    return this.cost.exportXlsx(user, { categoryId: q.categoryId, keyword: q.keyword });
  }

  @RequirePermission('finance.cost-table.view', 'product.cost.view', 'product.cost.edit')
  @Put('cost-table/category-margins/:categoryId')
  categoryMargin(@CurrentUser() user: AuthUser, @Param('categoryId', ParseIntPipe) id: number, @Body() b: CategoryMarginDto) {
    return this.maintain.saveCategoryMargin(user, id, { revision: b.revision, profitPercent: b.profitPercent ?? null, reason: b.reason });
  }

  @RequirePermission('finance.cost-table.view', 'product.cost.view')
  @Get('cost-table/:bundleId')
  one(@CurrentUser() user: AuthUser, @Param('bundleId', ParseIntPipe) id: number) {
    return this.cost.one(user, id);
  }

  @RequirePermission('finance.cost-table.view', 'product.cost.view', 'product.cost.edit')
  @Put('cost-table/:bundleId/pricing')
  pricing(@CurrentUser() user: AuthUser, @Param('bundleId', ParseIntPipe) id: number, @Body() b: PricingDto) {
    return this.maintain.savePricing(user, id, { revision: b.revision, carrierName: b.carrierName, profitPercent: b.profitPercent ?? null, reason: b.reason });
  }

  /** 一个组合自己的成本历史（成本变更 + 售价维护），从成本表这一行点开 */
  @RequirePermission('finance.cost-table.view', 'product.cost.view')
  @Get('cost-table/:bundleId/history')
  async skuHistory(@CurrentUser() user: AuthUser, @Param('bundleId', ParseIntPipe) id: number, @Query() q: PageDto) {
    const page = q.page ?? 1;
    const [changes, pricing] = await Promise.all([
      this.tools.costHistory(user, { bundleId: id, keyword: q.keyword, page, pageSize: 20 }),
      this.maintain.pricingHistory(user, { bundleId: id, keyword: q.keyword, page, pageSize: 20 }),
    ]);
    return { changes, pricing };
  }

  @RequirePermission('finance.cost-history.view', 'product.cost.view')
  @Get('cost-history/margins')
  marginHistory(@CurrentUser() user: AuthUser, @Query() q: PageDto) {
    return this.maintain.marginHistory(user, { keyword: q.keyword, page: q.page ?? 1, pageSize: 20 });
  }

  @RequirePermission('finance.cost-history.view', 'product.cost.view')
  @Get('cost-history/pricing')
  pricingHistory(@CurrentUser() user: AuthUser, @Query() q: PricingHistoryDto) {
    return this.maintain.pricingHistory(user, { bundleId: q.bundleId, keyword: q.keyword, page: q.page ?? 1, pageSize: 20 });
  }

  @RequirePermission('finance.pricing-debug.view', 'product.cost.view')
  @Get('freight-estimate')
  freight(@CurrentUser() user: AuthUser, @Query() q: FreightDto) {
    return this.cost.freightEstimate(user, q.weightG);
  }

  // ---------- 定价调试表：有页面权限即可；看得到成本的人精确到分，其余人整元且看不到成本（服务端判断） ----------

  @RequirePermission('finance.pricing-debug.view')
  @Get('pricing-debug/components')
  debugComponents(@CurrentUser() user: AuthUser, @Query() q: ComponentsDto) {
    return this.debug.components(user, { categoryId: q.categoryId, keyword: q.keyword, page: q.page ?? 1 });
  }

  @RequirePermission('finance.pricing-debug.view')
  @Get('pricing-debug')
  debugList(@CurrentUser() user: AuthUser, @Query() q: DebugListDto) {
    return this.debug.list(user, { keyword: q.keyword, categoryId: q.categoryId, baseCodeId: q.baseCodeId, exclusive: q.exclusive, page: q.page ?? 1, pageSize: q.pageSize ?? 30 });
  }

  @RequirePermission('finance.pricing-debug.view')
  @HttpCode(200)
  @Post('pricing-debug/slider-price')
  debugSlider(@CurrentUser() user: AuthUser, @Body() b: SliderDto) {
    return this.debug.sliderPrice(user, b);
  }

  @RequirePermission('finance.pricing-debug.view')
  @HttpCode(200)
  @Post('pricing-debug/quote')
  debugQuote(@CurrentUser() user: AuthUser, @Body() b: QuoteDto) {
    return this.debug.quote(user, b.mode, b.inputs);
  }

  @RequirePermission('finance.pricing-debug.view')
  @HttpCode(200)
  @Post('pricing-debug/export')
  debugExport(@CurrentUser() user: AuthUser, @Body() b: ExportDto) {
    return this.debug.exportXlsx(user, b.inputs);
  }
}
