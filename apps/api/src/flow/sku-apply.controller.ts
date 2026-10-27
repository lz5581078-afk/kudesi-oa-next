import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission, AuthenticatedOnly } from '../common/auth.decorators';
import { SkuApplyService, type SkuOptionKind } from './sku-apply.service';

class OptionsQuery {
  @IsIn(['meta', 'main', 'gift', 'package', 'label', 'other', 'labor', 'names']) kind!: SkuOptionKind | 'meta';
  @IsOptional() @IsString() @MaxLength(50) keyword?: string;
  @IsOptional() @IsString() @MaxLength(1500) ids?: string;
}

class HistoryQuery {
  @IsOptional() @IsString() @MaxLength(200) @Matches(/^[0-9,]*$/) mainIds?: string;
  @IsOptional() @IsString() @MaxLength(50) keyword?: string;
}
class SplitDto {
  @IsObject() payload!: Record<string, unknown>;
  @IsString() @MaxLength(60) requestKey!: string;
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

  @RequirePermission('flow.apply.view')
  @Get('history-config')
  history(@CurrentUser() user: AuthUser, @Query() q: HistoryQuery) {
    const ids = [...new Set((q.mainIds ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 10);
    return this.sku.historyConfigs(user, ids, q.keyword);
  }

  /** 每个规格独立办理：拆成一规格一条流程（发起权限和普通发起一样，由流程引擎校验） */
  @RequirePermission('flow.apply.view')
  @Post('start-split')
  @HttpCode(200)
  startSplit(@CurrentUser() user: AuthUser, @Body() b: SplitDto) { return this.sku.startSplit(user, b.payload, b.requestKey); }

  @AuthenticatedOnly()
  @Get('batches/:key')
  batch(@CurrentUser() user: AuthUser, @Param('key') key: string) { return this.sku.batch(user, key.slice(0, 20)); }
}
