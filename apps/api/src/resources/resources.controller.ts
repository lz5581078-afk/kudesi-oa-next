import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, MaxLength, Max, Min } from 'class-validator';
import { createChecker } from '@kudesi/shared';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequireResourceAction } from '../common/auth.decorators';
import { DataToolsService } from './data-tools.service';
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
  @IsOptional() @IsString() showHidden?: string;
  @IsOptional() @IsString() archived?: string;
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
}

class LinkDto {
  @IsString() @MaxLength(40) targetType!: string;
  @IsInt() @Min(1) targetId!: number;
}

class DeleteDto {
  @IsString() @MaxLength(500) reason!: string;
}

class ImportDto {
  @IsArray() @ArrayMaxSize(2000) rows!: Array<Record<string, string>>;
  @IsBoolean() dryRun!: boolean;
}

class SimilarDto {
  @IsObject() values!: Record<string, unknown>;
  @IsOptional() @IsInt() excludeId?: number;
}

class ExportQueryDto {
  @IsOptional() @IsString() includeHidden?: string;
}

/**
 * 所有资料共用一套接口。权限键 = resource.<类型>.<动作>，由全局守卫按路径里的 :type 校验，
 * 公司和操作人只取自令牌。
 */
@Controller('resources')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService, private readonly tools: DataToolsService) {}

  // 总览按每种资料的查看权限过滤，所以只要求登录
  @AuthenticatedOnly()
  @Get('overview')
  overview(@CurrentUser() user: AuthUser) {
    return this.resources.overview(user);
  }

  @RequireResourceAction('view')
  @Get(':type/category-tree')
  categoryTree(@CurrentUser() user: AuthUser, @Param('type') type: string, @Query() q: CategoryTreeQueryDto) {
    return this.resources.categoryTree(user, type, q.field, { tab: q.tab, status: q.status, showHidden: q.showHidden === '1' });
  }

  @RequireResourceAction('view')
  @Get(':type')
  list(@CurrentUser() user: AuthUser, @Param('type') type: string, @Query() q: ListQueryDto) {
    return this.resources.list(user, type, { ...q, showHidden: q.showHidden === '1', archived: q.archived === '1' });
  }

  @RequireResourceAction('export')
  @Get(':type/export')
  export(@CurrentUser() user: AuthUser, @Param('type') type: string, @Query() q: ExportQueryDto) {
    return this.resources.exportCsv(user, type, q.includeHidden === '1');
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
    return this.resources.importRows(user, type, dto.rows, dto.dryRun);
  }

  // 往来档案保存前的相似/重复提示：返回阻止项和提示项
  @RequireResourceAction('view')
  @Post(':type/similar-check')
  similarCheck(@CurrentUser() user: AuthUser, @Param('type') type: string, @Body() dto: SimilarDto) {
    return this.resources.similarCheck(user, type, dto.values, dto.excludeId);
  }

  @RequireResourceAction('edit')
  @Post(':type/batch')
  batch(@CurrentUser() user: AuthUser, @Param('type') type: string, @Body() dto: BatchDto) {
    return this.resources.batchUpdate(user, type, dto.ids, dto.values ?? {}, undefined, undefined);
  }

  // 批量停用/启用要有“停用”权限，和单条一样
  @RequireResourceAction('disable')
  @Post(':type/batch-status')
  batchStatus(@CurrentUser() user: AuthUser, @Param('type') type: string, @Body() dto: BatchDto) {
    return this.resources.batchUpdate(user, type, dto.ids, {}, dto.status, dto.reason);
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

  @RequireResourceAction('disable')
  @Post(':type/:id/status')
  async status(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number, @Body() dto: StatusDto) {
    const out = await this.resources.changeStatus(user, type, id, dto.status, dto.reason);
    // 组合验证通过时顺手登记一次成本快照（成本历史）；登记失败不影响验证本身
    if (type === 'finance-bundles' && dto.status === 'verified') await this.tools.registerCost(user, id, '验证通过').catch(() => undefined);
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
    return this.resources.addManualLink(user, type, id, dto.targetType, dto.targetId, createChecker(user.permissions));
  }

  @RequireResourceAction('edit')
  @Delete(':type/:id/links/:linkId')
  removeLink(@CurrentUser() user: AuthUser, @Param('type') type: string, @Param('id', ParseIntPipe) id: number, @Param('linkId', ParseIntPipe) linkId: number) {
    return this.resources.removeManualLink(user, type, id, linkId);
  }
}
