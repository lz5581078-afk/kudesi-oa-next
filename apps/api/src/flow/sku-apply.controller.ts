import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission, AuthenticatedOnly } from '../common/auth.decorators';
import { SkuApplyService, type SkuOptionKind } from './sku-apply.service';

class OptionsQuery {
  @IsIn(['meta', 'main', 'gift', 'package', 'label', 'other', 'labor', 'names']) kind!: SkuOptionKind | 'meta';
  @IsOptional() @IsString() @MaxLength(50) keyword?: string;
  @IsOptional() @IsString() @MaxLength(1500) ids?: string;
}

/** SKU 批量申请的辅助接口。不另开菜单：申请从“申请中心”发起，预览显示在流程详情里。 */
@Controller('flow/sku-apply')
export class SkuApplyController {
  constructor(private readonly sku: SkuApplyService) {}

  @RequirePermission('flow.apply.view')
  @Get('options')
  options(@CurrentUser() user: AuthUser, @Query() q: OptionsQuery) { return this.sku.options(user, q.kind, q.keyword, q.ids); }

  /** 能不能看由流程可见性决定（发起人、办理人、抄送、有流程总览权限的人） */
  @AuthenticatedOnly()
  @Get('runs/:id/preview')
  preview(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.sku.preview(user, id); }
}
