import { createChecker } from '@kudesi/shared';
import { ForbiddenException, Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { CategoryToolsService } from './category-tools.service';

class ReorderDto { @IsArray() @ArrayMinSize(2) @ArrayMaxSize(500) @IsInt({ each: true }) @Min(1, { each: true }) orderedIds!: number[] }

class TreeDto { @IsString() @Matches(/^[a-z_]{2,24}$/) archiveType!: string }

@Controller('finance/categories')
export class CategoryToolsController {
  constructor(private readonly tools: CategoryToolsService) {}

  @RequirePermission('resource.finance-categories.view')
  @Get('tree')
  tree(@CurrentUser() u: AuthUser, @Query() q: TreeDto) { return this.tools.tree(u, q.archiveType); }

  @RequirePermission('resource.finance-categories.edit')
  @Post('reorder')
  @HttpCode(200)
  reorder(@CurrentUser() u: AuthUser, @Body() b: ReorderDto) { return this.tools.reorder(u, b.orderedIds); }
}

class CodePreviewDto {
  @IsString() @MaxLength(30) archiveType!: string;
  @IsOptional() @IsIn(['original_purchase', 'supplier_oem']) supplyMode?: string;
  @IsOptional() @IsInt() @Min(1) categoryId?: number;
  @IsOptional() @IsInt() @Min(1) brandId?: number;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsNumber() specQty?: number;
  @IsOptional() @IsString() @MaxLength(30) specUnit?: string;
  @IsOptional() @IsString() @MaxLength(60) shape?: string;
  @IsOptional() @IsString() @MaxLength(60) code?: string;
  @IsOptional() @IsString() @MaxLength(80) materialCode?: string;
  @IsOptional() @IsString() @MaxLength(10000) capacities?: string;
  @IsOptional() @IsString() @MaxLength(100) dimensions?: string;
  @IsOptional() @IsString() @MaxLength(30) dimensionUnit?: string;
  @IsOptional() @IsString() @MaxLength(30) productPackagingSpec?: string;
  @IsOptional() @IsString() @MaxLength(30) productPackagingUnit?: string;
  @IsOptional() @IsInt() @Min(1) excludeId?: number;
}

@Controller('finance/products')
export class ProductCodePreviewController {
  constructor(private readonly tools: CategoryToolsService) {}

  @AuthenticatedOnly()
  @Post('code-preview')
  @HttpCode(200)
  preview(@CurrentUser() u: AuthUser, @Body() b: CodePreviewDto) {
    const can = createChecker(u.permissions);
    if (!can('resource.finance-products.create') && !can('resource.finance-products.edit')) throw new ForbiddenException('没有新建或编辑商品档案的权限');
    const { excludeId, ...data } = b;
    return this.tools.previewProductCode(u, data, excludeId ?? null);
  }
}
