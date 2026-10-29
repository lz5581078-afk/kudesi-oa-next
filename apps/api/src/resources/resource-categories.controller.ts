import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { SPECIAL_PERMISSIONS } from '@kudesi/shared';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { ResourceCategoriesService } from './resource-categories.service';

class CreateCategoryDto { @IsString() @MaxLength(60) name!: string }
class UpdateCategoryDto {
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsBoolean() hidden?: boolean;
}
class ReorderCategoriesDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsString({ each: true }) @MaxLength(64, { each: true }) values!: string[] }

const VALUE = /^[A-Za-z0-9_]{1,64}$/;
class ValueParam { @Matches(VALUE) value!: string }

/**
 * 资料页签“管理分类”。注册顺序要排在 ResourcesController 之前（路径 resources/category-options、resources/:type/categories 不能被 :type、:type/:id 抢走）。
 * 公司和操作人只取自令牌；管理接口要 resource.categories.manage + 该资料的查看权限（服务里再核对）。
 */
@Controller('resources')
export class ResourceCategoriesController {
  constructor(private readonly svc: ResourceCategoriesService) {}

  // 有查看权限的资料的有效选项配置，页签、表单、筛选都用它
  @AuthenticatedOnly()
  @Get('category-options')
  options(@CurrentUser() user: AuthUser) {
    return this.svc.options(user);
  }

  @RequirePermission(SPECIAL_PERMISSIONS.resourceCategoriesManage)
  @Get(':type/categories')
  list(@CurrentUser() user: AuthUser, @Param('type') type: string) {
    return this.svc.list(user, type);
  }

  @RequirePermission(SPECIAL_PERMISSIONS.resourceCategoriesManage)
  @Post(':type/categories')
  create(@CurrentUser() user: AuthUser, @Param('type') type: string, @Body() dto: CreateCategoryDto) {
    return this.svc.create(user, type, dto.name);
  }

  @RequirePermission(SPECIAL_PERMISSIONS.resourceCategoriesManage)
  @Post(':type/categories/reorder')
  @HttpCode(200)
  reorder(@CurrentUser() user: AuthUser, @Param('type') type: string, @Body() dto: ReorderCategoriesDto) {
    return this.svc.reorder(user, type, dto.values);
  }

  @RequirePermission(SPECIAL_PERMISSIONS.resourceCategoriesManage)
  @Patch(':type/categories/:value')
  update(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param() p: ValueParam, @Body() dto: UpdateCategoryDto) {
    return this.svc.update(user, type, p.value, { name: dto.name, hidden: dto.hidden });
  }

  @RequirePermission(SPECIAL_PERMISSIONS.resourceCategoriesManage)
  @Delete(':type/categories/:value')
  remove(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param() p: ValueParam) {
    return this.svc.remove(user, type, p.value);
  }
}
