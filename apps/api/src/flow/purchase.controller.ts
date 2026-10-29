import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { PurchaseService } from './purchase.service';

class OptionsQuery {
  @IsOptional() @IsString() @MaxLength(50) keyword?: string;
  @IsOptional() @IsString() @MaxLength(1500) @Matches(/^[0-9,]*$/) ids?: string;
}
class DraftDto {
  @IsInt() @Min(1) warehouseId!: number;
  @IsOptional() @IsString() @MaxLength(10) date?: string;
}

/** 采购流程的辅助接口；流程本身的发起、办理都走通用的 /api/flow。 */
@Controller('flow/purchase')
export class PurchaseController {
  constructor(private readonly purchase: PurchaseService) {}

  @RequirePermission('flow.apply.view')
  @Get('options')
  options(@CurrentUser() user: AuthUser, @Query() q: OptionsQuery) { return this.purchase.options(user, q.keyword, q.ids); }

  /** 能不能看由流程可见性决定（发起人、办理人、抄送、有流程总览权限的人） */
  @AuthenticatedOnly()
  @Get('runs/:id/summary')
  summary(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.purchase.summary(user, id); }

  @RequirePermission('flow.purchase.inbound-draft')
  @Post('runs/:id/inbound-draft')
  @HttpCode(200)
  draft(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: DraftDto) { return this.purchase.inboundDraft(user, id, b); }
}
