import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Max, Min, ValidateNested } from 'class-validator';
import { createChecker } from '@kudesi/shared';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission, RequireResourceAction } from '../common/auth.decorators';
import { DataToolsService } from './data-tools.service';
import { GridSaveService } from './grid-save.service';
import { ResourcesService } from './resources.service';

class ListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(100) keyword?: string;
  @IsOptional() @IsString() @MaxLength(24) status?: string;
  @IsOptional() @IsString() @MaxLength(64) tab?: string;
  @IsOptional() @IsString() @MaxLength(48) fieldKey?: string;
  @IsOptional() @IsString() @MaxLength(100) fieldValue?: string;
  @IsOptional() @IsString() @MaxLength(400) filters?: string;
  @IsOptional() @IsString() @MaxLength(6000) colFilters?: string;
  @IsOptional() @IsString() showHidden?: string;
  @IsOptional() @IsString() archived?: string;
  @IsOptional() @IsString() expiring?: string;
  @IsOptional() @IsString() @MaxLength(48) sortBy?: string;
  @IsOptional() @IsIn(['asc', 'desc']) sortDir?: 'asc' | 'desc';
}

class FacetQueryDto {
  @IsString() @MaxLength(48) key!: string;
  @IsOptional() @IsString() @MaxLength(6000) colFilters?: string;
  @IsOptional() @IsString() showHidden?: string;
  @IsOptional() @IsString() archived?: string;
}

class ExpiringQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(366) days?: number;
  @IsOptional() @IsString() includeExpired?: string;
}

class CategoryTreeQueryDto {
  @IsString() @MaxLength(48) field!: string;
  @IsOptional() @IsString() @MaxLength(64) tab?: string;
  @IsOptional() @IsString() @MaxLength(24) status?: string;
  @IsOptional() @IsString() showHidden?: string;
}

class SaveDto {
  @IsObject() values!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(24) status?: string;
}

class UpdateDto {
  @IsObject() values!: Record<string, unknown>;
}

class StatusDto {
  @IsString() @MaxLength(24) status!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class BatchDto {
  @IsArray() @ArrayMaxSize(200) @IsInt({ each: true }) ids!: number[];
  @IsOptional() @IsObject() values?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(24) status?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsString() @MaxLength(40) action?: string;
  @IsOptional() value?: unknown;
}

class GridUpdateDto {
  @IsInt() @Min(1) id!: number;
  @IsOptional() @IsString() @MaxLength(64) version?: string;
  @IsObject() data!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(24) status?: string;
  @IsOptional() @IsString() @MaxLength(500) statusReason?: string;
}

class GridCreateDto {
  @IsString() @MaxLength(64) clientId!: string;
  @IsObject() data!: Record<string, unknown>;
}

class GridArchiveDto {
  @IsInt() @Min(1) id!: number;
  @IsOptional() @IsString() @MaxLength(64) version?: string;
  @IsString() @MaxLength(500) reason!: string;
}

/** 表格编辑批量保存：只有这三类行；公司、操作人不在请求体里 */
class GridSaveDto {
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => GridUpdateDto) updates?: GridUpdateDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => GridCreateDto) creates?: GridCreateDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => GridArchiveDto) archives?: GridArchiveDto[];
  /** 操作记录里的来源说明（如“费用模块”），缺省“表格编辑” */
  @IsOptional() @IsString() @MaxLength(40) note?: string;
}

class LinkDto {
  @IsString() @MaxLength(40) targetType!: string;
  @IsInt() @Min(1) targetId!: number;
  @IsOptional() @IsString() @MaxLength(10) validFrom?: string;
  @IsOptional() @IsString() @MaxLength(10) validTo?: string;
  @IsOptional() @IsString() @MaxLength(200) purpose?: string;
  @IsOptional() @IsString() @MaxLength(16) relationKind?: string;
}

class LinkPropsDto {
  @IsOptional() @IsString() @MaxLength(10) validFrom?: string;
  @IsOptional() @IsString() @MaxLength(10) validTo?: string;
  @IsOptional() @IsString() @MaxLength(200) purpose?: string;
  @IsOptional() @IsString() @MaxLength(16) relationKind?: string;
}

class PhotoIdsDto {
  @IsArray() @ArrayMaxSize(20) @IsInt({ each: true }) fileIds!: number[];
}

class DeleteDto {
  @IsString() @MaxLength(500) reason!: string;
}

class ImportDto {
  @IsArray() @ArrayMaxSize(2000) rows!: Array<Record<string, string>>;
  @IsBoolean() dryRun!: boolean;
  /** true=有问题的行跳过，其余照常导入 */
  @IsOptional() @IsBoolean() partial?: boolean;
}

class SimilarDto {
  @IsObject() values!: Record<string, unknown>;
  @IsOptional() @IsInt() excludeId?: number;
}

class ExportQueryDto {
  @IsOptional() @IsString() includeHidden?: string;
  // 导出范围：带上列表当前的筛选条件=导出当前筛选结果；带 ids=导出所选；都不带=全部
  @IsOptional() @IsString() @MaxLength(100) keyword?: string;
  @IsOptional() @IsString() @MaxLength(24) status?: string;
  @IsOptional() @IsString() @MaxLength(64) tab?: string;
  @IsOptional() @IsString() @MaxLength(400) filters?: string;
  @IsOptional() @IsString() @MaxLength(6000) colFilters?: string;
  @IsOptional() @IsString() archived?: string;
  @IsOptional() @IsString() expiring?: string;
  @IsOptional() @IsString() @MaxLength(48) sortBy?: string;
  @IsOptional() @IsIn(['asc', 'desc']) sortDir?: 'asc' | 'desc';
  @IsOptional() @IsString() @MaxLength(20000) ids?: string;
  @IsOptional() @IsString() @MaxLength(400) cols?: string;
}

/**
 * 所有资料共用一套接口。权限键 = resource.<类型>.<动作>，由全局守卫按路径里的 :type 校验，
 * 公司和操作人只取自令牌。
 */
@Controller('resources')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService, private readonly tools: DataToolsService, private readonly grid: GridSaveService) {}

  // 总览按每种资料的查看权限过滤，所以只要求登录
  // 商品档案下拉用：公司维护的单位与规格（名称+取值），不含敏感信息
  @AuthenticatedOnly()
  @Get('unit-options')
  unitOptions(@CurrentUser() user: AuthUser) {
    return this.resources.unitOptions(user);
  }

  @AuthenticatedOnly()
  @Get('overview')
  overview(@CurrentUser() user: AuthUser) {
    return this.resources.overview(user);
  }

  @AuthenticatedOnly()
  @Get('recent-changes')
  recentChanges(@CurrentUser() user: AuthUser) {
    return this.resources.recentChanges(user, 40);
  }

  @AuthenticatedOnly()
  @Get('expiring')
  expiring(@CurrentUser() user: AuthUser, @Query() q: ExpiringQueryDto) {
    return this.resources.expiring(user, q.days, q.includeExpired !== '0');
  }

  @RequireResourceAction('view')
  @Get(':type/category-tree')
  categoryTree(@CurrentUser() user: AuthUser, @Param('type') type: string, @Query() q: CategoryTreeQueryDto) {
    return this.resources.categoryTree(user, type, q.field, { tab: q.tab, status: q.status, showHidden: q.showHidden === '1' });
  }

  @RequireResourceAction('view')
  @Get(':type/column-facets')
  columnFacets(@CurrentUser() user: AuthUser, @Param('type') type: string, @Query() q: FacetQueryDto) {
    return this.resources.columnFacets(user, type, { key: q.key, colFilters: q.colFilters, showHidden: q.showHidden === '1', archived: q.archived === '1' });
  }

  @RequireResourceAction('view')
  @Get(':type')
  list(@CurrentUser() user: AuthUser, @Param('type') type: string, @Query() q: ListQueryDto) {
    return this.resources.list(user, type, { ...q, showHidden: q.showHidden === '1', archived: q.archived === '1', expiring: q.expiring === '1' });
  }

  @RequireResourceAction('export')
  @Get(':type/export')
  export(@CurrentUser() user: AuthUser, @Param('type') type: string, @Query() q: ExportQueryDto) {
    const ids = (q.ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    return this.resources.exportCsv(user, type, q.includeHidden === '1', {
      keyword: q.keyword, status: q.status, tab: q.tab, filters: q.filters, colFilters: q.colFilters, archived: q.archived === '1', expiring: q.expiring === '1',
      sortBy: q.sortBy, sortDir: q.sortDir, ids: ids.length ? ids : undefined,
      derivedKeys: (q.cols ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20),
    });
  }

  @RequireResourceAction('import')
  @Get(':type/import-backups')
  importBackups(@CurrentUser() user: AuthUser, @Param('type') type: string) {
    return this.resources.listImportBackups(user, type);
  }

  @RequireResourceAction('import')
  @Post(':type/import-backups/:id/restore')
  restoreBackup(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number) {
    return this.resources.restoreImportBackup(user, type, id);
  }

  @RequireResourceAction('import')
  @Post(':type/import')
  import(@CurrentUser() user: AuthUser, @Param('type') type: string, @Body() dto: ImportDto) {
    return this.resources.importRows(user, type, dto.rows, dto.dryRun, dto.partial === true);
  }

  // 往来档案保存前的相似/重复提示：返回阻止项和提示项
  @RequireResourceAction('view')
  @Post(':type/similar-check')
  similarCheck(@CurrentUser() user: AuthUser, @Param('type') type: string, @Body() dto: SimilarDto) {
    return this.resources.similarCheck(user, type, dto.values, dto.excludeId);
  }

  // 表格编辑：逐行走与单条新建/修改相同的规则；新增、归档的权限在服务里逐项检查
  @RequireResourceAction('edit')
  @Post(':type/grid-save')
  gridSave(@CurrentUser() user: AuthUser, @Param('type') type: string, @Body() dto: GridSaveDto) {
    return this.grid.save(user, type, dto);
  }

  @RequireResourceAction('edit')
  @Post(':type/batch')
  batch(@CurrentUser() user: AuthUser, @Param('type') type: string, @Body() dto: BatchDto) {
    if (dto.action) return this.resources.batchAction(user, type, dto.ids, dto.action, dto.value, dto.reason);
    return this.resources.batchUpdate(user, type, dto.ids, dto.values ?? {}, undefined, undefined);
  }

  // 批量停用/启用要有“停用”权限，和单条一样
  @RequireResourceAction('disable')
  @Post(':type/batch-status')
  batchStatus(@CurrentUser() user: AuthUser, @Param('type') type: string, @Body() dto: BatchDto) {
    return this.resources.batchUpdate(user, type, dto.ids, {}, dto.status, dto.reason);
  }

  // 把预置的常用单位补进公司的“单位与规格”（已有同名/同编码的跳过）
  @RequirePermission('resource.finance-product-units.create')
  @Post('finance-product-units/seed-defaults')
  seedUnitDefaults(@CurrentUser() user: AuthUser) {
    return this.resources.seedUnitDefaults(user);
  }

  // 仓库岗位只读商品档案，但可以上传照片（只加不删）
  @RequirePermission('resource.finance-products.view')
  @Post('finance-products/:id/warehouse-photos')
  warehousePhotos(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: PhotoIdsDto) {
    return this.resources.addWarehousePhotos(user, id, dto.fileIds);
  }

  @RequireResourceAction('create')
  @Post(':type')
  create(@CurrentUser() user: AuthUser, @Param('type') type: string, @Body() dto: SaveDto) {
    return this.resources.create(user, type, dto.values, dto.status);
  }

  @RequireResourceAction('view')
  @Get(':type/:id')
  get(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number) {
    return this.resources.get(user, type, id);
  }

  @RequireResourceAction('edit')
  @Patch(':type/:id')
  update(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateDto) {
    return this.resources.update(user, type, id, dto.values);
  }

  /** 一键建立手机号档案并绑定（权限在服务里按该资料的修改 + 手机号档案的新增校验） */
  @AuthenticatedOnly()
  @Post(':type/:id/create-phone')
  createPhone(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number) {
    return this.resources.createPhoneFor(user, type, id);
  }

  @RequireResourceAction('disable')
  @Post(':type/:id/status')
  async status(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number, @Body() dto: StatusDto) {
    const out = await this.resources.changeStatus(user, type, id, dto.status, dto.reason);
    // 组合验证通过时顺手登记一次成本快照（成本历史）；登记失败不影响验证本身
    if (type === 'finance-bundles' && dto.status === 'verified') await this.tools.registerCost(user, id, '验证通过', undefined, 'workflow_publish').catch(() => undefined);
    return out;
  }

  @RequireResourceAction('delete')
  @Delete(':type/:id')
  remove(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number, @Body() dto: DeleteDto) {
    return this.resources.remove(user, type, id, dto.reason);
  }

  @RequireResourceAction('delete')
  @Post(':type/:id/restore')
  restore(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number, @Body() dto: DeleteDto) {
    return this.resources.restore(user, type, id, dto.reason);
  }

  @RequireResourceAction('secret')
  @Get(':type/:id/secret/:field')
  secret(
    @CurrentUser() user: AuthUser,
    @Param('type') type: string,
    @Param('id', ParseIntPipe) id: number,
    @Param('field') field: string,
  ) {
    return this.resources.reveal(user, type, id, field);
  }

  @RequireResourceAction('view')
  @Get(':type/:id/logs')
  logs(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number) {
    return this.resources.logs(user, type, id);
  }

  @RequireResourceAction('view')
  @Get(':type/:id/relations')
  relations(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number) {
    return this.resources.relations(user, type, id, createChecker(user.permissions));
  }

  @RequireResourceAction('edit')
  @Post(':type/:id/links')
  addLink(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number, @Body() dto: LinkDto) {
    return this.resources.addManualLink(user, type, id, dto.targetType, dto.targetId, createChecker(user.permissions), { validFrom: dto.validFrom, validTo: dto.validTo, purpose: dto.purpose, relationKind: dto.relationKind });
  }

  @RequireResourceAction('edit')
  @Patch(':type/:id/links/:linkId')
  updateLink(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number, @Param('linkId', ParseIntPipe) linkId: number, @Body() dto: LinkPropsDto) {
    return this.resources.updateManualLink(user, type, id, linkId, dto);
  }

  @RequireResourceAction('edit')
  @Delete(':type/:id/links/:linkId')
  removeLink(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number, @Param('linkId', ParseIntPipe) linkId: number) {
    return this.resources.removeManualLink(user, type, id, linkId);
  }
}
