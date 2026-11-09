import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { COMPANY_PRODUCTS } from '@kudesi/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { CompanyProductsService } from './company-products.service';
import { WorkspaceService } from './workspace.service';

class TasksQuery {
  @IsOptional() @IsIn(['new', 'processing', 'review', 'done']) view?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) pageSize?: number;
}
class ProductQuery {
  @IsOptional() @IsString() @MaxLength(150) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) category?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page?: number;
}
class ProductDetailQuery {
  @IsOptional() @IsString() @MaxLength(160) alias?: string;
}
class ProductAttributes {
  @IsBoolean() priceRestricted!: boolean;
  @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(24, { each: true }) tags!: string[];
}

class DailyQuery { @IsOptional() @IsString() @MaxLength(10) date?: string }
class NoteDto { @IsOptional() @IsString() @MaxLength(500) note?: string }
class ReviewDto { @IsBoolean() approve!: boolean; @IsOptional() @IsString() @MaxLength(500) note?: string }

/** 工作台：岗位目录与汇总、个人任务四分类、老板总控台。个人任务只看本人，所以只要登录；总控台要专门权限。 */
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly ws: WorkspaceService, private readonly products: CompanyProductsService) {}

  @AuthenticatedOnly()
  @Get('catalog')
  catalog(@CurrentUser() user: AuthUser) { return this.ws.catalog(user); }

  @AuthenticatedOnly()
  @Get('desk/:positionId')
  desk(@CurrentUser() user: AuthUser, @Param('positionId', ParseIntPipe) positionId: number) { return this.ws.desk(user, positionId); }

  @RequirePermission('workbench.desk.view', 'resource.store-daily-metrics.view')
  @Get('daily')
  daily(@CurrentUser() user: AuthUser, @Query() q: DailyQuery) { return this.ws.daily(user, q.date); }

  @RequirePermission('workbench.desk.view')
  @Get('my-stores')
  myStores(@CurrentUser() user: AuthUser) { return this.ws.myStores(user); }

  @RequirePermission(COMPANY_PRODUCTS.permission)
  @Get('company-products')
  productList(@CurrentUser() user: AuthUser, @Query() query: ProductQuery) { return this.products.list(user, query); }

  @RequirePermission(COMPANY_PRODUCTS.permission)
  @Get('company-products/:id')
  productDetail(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Query() query: ProductDetailQuery) { return this.products.detail(user, id, query.alias); }

  @RequirePermission(COMPANY_PRODUCTS.permission)
  @Patch('company-products/:id/attributes')
  productAttributes(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() values: ProductAttributes) {
    return this.products.setAttributes(user, id, values);
  }

  @AuthenticatedOnly()
  @Get('tasks')
  tasks(@CurrentUser() user: AuthUser, @Query() q: TasksQuery) { return this.ws.tasks(user, q); }

  @AuthenticatedOnly()
  @Post('tasks/:id/start')
  start(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.ws.start(user, id); }

  @AuthenticatedOnly()
  @Post('tasks/:id/submit')
  submit(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: NoteDto) { return this.ws.submit(user, id, b.note); }

  @AuthenticatedOnly()
  @Post('tasks/:id/review')
  review(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReviewDto) { return this.ws.review(user, id, b.approve, b.note); }

  @RequirePermission('workbench.boss.view')
  @Get('boss')
  boss(@CurrentUser() user: AuthUser) { return this.ws.boss(user); }
}
