import { Body, Controller, Get, Post } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { ProductCostExcelService } from './product-cost-excel.service';

class CostImportDto {
  @IsArray() @ArrayMaxSize(5000) rows!: Array<Record<string, string>>;
  @IsOptional() @IsString() @MaxLength(60) confirm?: string;
}

/** 商品档案成本 Excel 导入导出：查看成本 + 成本记录权限才能导出，修改成本 + 新增成本记录才能导入 */
@Controller('finance/product-costs')
export class ProductCostExcelController {
  constructor(private readonly svc: ProductCostExcelService) {}

  @RequirePermission('product.cost.view', 'resource.finance-product-costs.view')
  @Get('template')
  template(@CurrentUser() u: AuthUser) { return this.svc.template(u); }

  @RequirePermission('product.cost.view', 'resource.finance-product-costs.view')
  @Get('export')
  export(@CurrentUser() u: AuthUser) { return this.svc.export(u); }

  @RequirePermission('product.cost.edit', 'resource.finance-product-costs.create')
  @Post('import/preflight')
  preflight(@CurrentUser() u: AuthUser, @Body() dto: CostImportDto) { return this.svc.preflight(u, dto.rows); }

  @RequirePermission('product.cost.edit', 'resource.finance-product-costs.create')
  @Post('import/execute')
  execute(@CurrentUser() u: AuthUser, @Body() dto: CostImportDto) { return this.svc.execute(u, dto.rows, dto.confirm ?? ''); }
}
