import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { resourcePermission } from '@kudesi/shared';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { FeeLedgerService } from './fee-ledger.service';

class LedgerQueryDto {
  @IsIn(['main', 'all', 'broadband']) view!: 'main' | 'all' | 'broadband';
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['main', 'sub', 'standalone', 'soon', 'overdue', 'nofee', 'unbound', 'expiring', 'expired']) focus?: 'main' | 'sub' | 'standalone' | 'soon' | 'overdue' | 'nofee' | 'unbound' | 'expiring' | 'expired';
  @IsOptional() @IsString() @MaxLength(60) carrier?: string;
  @IsOptional() @IsString() @MaxLength(60) user?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) location?: number;
  @IsOptional() @IsIn(['number', 'monthly', 'next', 'carrier']) sort?: 'number' | 'monthly' | 'next' | 'carrier';
  @IsOptional() @IsIn(['asc', 'desc']) dir?: 'asc' | 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

/** 通信费用台账（只读聚合）。公司只取自令牌；权限沿用手机号查看权限，宽带部分另按宽带查看权限。 */
@Controller('resources')
export class FeeLedgerController {
  constructor(private readonly ledger: FeeLedgerService) {}

  @RequirePermission(resourcePermission('phones', 'view'))
  @Get('fee-ledger')
  get(@CurrentUser() user: AuthUser, @Query() q: LedgerQueryDto) {
    return this.ledger.ledger(user, q);
  }
}
