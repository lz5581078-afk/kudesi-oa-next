import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission, AuthenticatedOnly } from '../common/auth.decorators';
import { SkuApplyService, type SkuOptionKind } from './sku-apply.service';
import { SkuBatchService, type BatchAction } from './sku-batch.service';

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

class BatchItemDto {
  @IsInt() runId!: number;
  @IsInt() revision!: number;
  @IsOptional() @IsInt() stepId?: number;
}
class BatchActDto {
  @IsString() @Matches(/^(B[0-9a-z]{1,19}|run-\d{1,10})$/) ref!: string;
  @IsIn(['pass', 'return', 'reject', 'cancel', 'resubmit']) action!: BatchAction;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => BatchItemDto) items!: BatchItemDto[];
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
  @IsOptional() @IsObject() form?: Record<string, unknown>;
  @IsOptional() @IsObject() forms?: Record<string, Record<string, unknown>>;
}
class ReturnAllDto {
  @IsString() @Matches(/^(B[0-9a-z]{1,19}|run-\d{1,10})$/) ref!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => BatchItemDto) items!: BatchItemDto[];
  @IsString() @MaxLength(500) reason!: string;
}
class ReturnSpecsDto {
  @IsInt() runId!: number;
  @IsInt() revision!: number;
  @IsInt() stepId!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(100, { each: true }) specs!: string[];
  @IsString() @MaxLength(500) reason!: string;
}

/** SKU 批量申请的辅助接口。不另开菜单：申请从“申请中心”发起，预览显示在流程详情里。 */
@Controller('flow/sku-apply')
export class SkuApplyController {
  constructor(private readonly sku: SkuApplyService, private readonly batches: SkuBatchService) {}

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

  /** 申请汇总：一张申请单的全部规格、每个规格走到哪一步、你能做什么。能不能看由流程可见性决定（发起人、办理人、抄送、有总览权限的人） */
  @AuthenticatedOnly()
  @Get('applications/:ref')
  board(@CurrentUser() user: AuthUser, @Param('ref') ref: string) { return this.batches.board(user, ref); }

  /** 批量通过/退回/废除/拒绝/重新提交：每个规格独立办理，办理资格和单条办理一样由流程引擎判断 */
  @AuthenticatedOnly()
  @Post('applications/act')
  @HttpCode(200)
  act(@CurrentUser() user: AuthUser, @Body() b: BatchActDto) { return this.batches.act(user, b); }

  @AuthenticatedOnly()
  @Post('applications/return-all')
  @HttpCode(200)
  returnAll(@CurrentUser() user: AuthUser, @Body() b: ReturnAllDto) { return this.batches.returnAll(user, b); }

  @AuthenticatedOnly()
  @Post('applications/return-specs')
  @HttpCode(200)
  returnSpecs(@CurrentUser() user: AuthUser, @Body() b: ReturnSpecsDto) { return this.batches.returnSpecs(user, b); }
}
