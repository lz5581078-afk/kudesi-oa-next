import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ASSET_ACTIONS, createChecker, resourcePermission, type AssetAction } from '@kudesi/shared';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { AssetsService } from './assets.service';

class TransitionDto {
  @IsIn(Object.keys(ASSET_ACTIONS)) action!: AssetAction;
  @IsOptional() @IsInt() @Min(1) userId?: number | null;
  @IsOptional() @IsInt() @Min(1) locationId?: number | null;
  @IsOptional() @IsInt() @Min(1) departmentId?: number | null;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class InventoryItemDto {
  @IsInt() @Min(1) id!: number;
  @IsIn(['present', 'moved', 'missing']) result!: 'present' | 'moved' | 'missing';
  @IsOptional() @IsInt() @Min(1) locationId?: number | null;
}

class InventoryDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => InventoryItemDto) items!: InventoryItemDto[];
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

/** 固定资产的流转/盘点/卷宗，和位置的“存放内容”。公司与操作人只取自令牌。 */
@Controller('resources')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @RequirePermission(resourcePermission('fixed-assets', 'edit'))
  @Post('fixed-assets/inventory')
  inventory(@CurrentUser() user: AuthUser, @Body() dto: InventoryDto) {
    return this.assets.inventory(user, dto.items, dto.note ?? '');
  }

  @RequirePermission(resourcePermission('fixed-assets', 'edit'))
  @Post('fixed-assets/:id/transition')
  transition(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: TransitionDto) {
    return this.assets.transition(user, id, dto);
  }

  @RequirePermission(resourcePermission('fixed-assets', 'view'))
  @Get('fixed-assets/:id/asset-details')
  details(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.assets.details(user, id);
  }

  @RequirePermission(resourcePermission('locations', 'view'))
  @Get('locations/:id/contents')
  contents(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.assets.locationContents(user, id, createChecker(user.permissions));
  }
}
