import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsString, Matches, Min } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { CategoryToolsService } from './category-tools.service';

class ReorderDto { @IsArray() @ArrayMinSize(2) @ArrayMaxSize(500) @IsInt({ each: true }) @Min(1, { each: true }) orderedIds!: number[] }

class TreeDto { @IsString() @Matches(/^[a-z_]{2,24}$/) archiveType!: string }

@Controller('finance/categories')
export class CategoryToolsController {
  constructor(private readonly tools: CategoryToolsService) {}

  @RequirePermission('resource.finance-categories.view')
  @Get('tree')
  tree(@CurrentUser() u: AuthUser, @Query() q: TreeDto) { return this.tools.tree(u, q.archiveType); }

  @RequirePermission('resource.finance-categories.edit')
  @Post('reorder')
  @HttpCode(200)
  reorder(@CurrentUser() u: AuthUser, @Body() b: ReorderDto) { return this.tools.reorder(u, b.orderedIds); }
}
