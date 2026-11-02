import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { ExclusiveService } from './exclusive.service';

class OptionsQuery {
  @IsOptional() @IsString() @MaxLength(50) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) categoryId?: number;
  @IsOptional() @Type(() => Boolean) @IsBoolean() onlyFree?: boolean;
}
class CancelBody { @IsString() @MaxLength(500) reason!: string }

/** 专属品领取页的辅助接口。申请和审批在统一流程里（product-exclusive）。 */
@Controller('flow/exclusive')
export class ExclusiveController {
  constructor(private readonly svc: ExclusiveService) {}

  @RequirePermission('flow.exclusive.view')
  @Get('options')
  options(@CurrentUser() user: AuthUser, @Query() q: OptionsQuery) { return this.svc.options(user, q); }

  @RequirePermission('flow.exclusive.view')
  @Get('grants')
  grants(@CurrentUser() user: AuthUser) { return this.svc.grants(user); }

  @RequirePermission('flow.exclusive.view')
  @Post('grants/:id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: CancelBody) { return this.svc.cancel(user, id, b.reason); }
}
