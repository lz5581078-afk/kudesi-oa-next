import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { WorkspaceService } from './workspace.service';

class TasksQuery {
  @IsOptional() @IsIn(['new', 'processing', 'review', 'done']) view?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) pageSize?: number;
}
class DailyQuery { @IsOptional() @IsString() @MaxLength(10) date?: string }
class NoteDto { @IsOptional() @IsString() @MaxLength(500) note?: string }
class ReviewDto { @IsBoolean() approve!: boolean; @IsOptional() @IsString() @MaxLength(500) note?: string }

/** 工作台：岗位目录与汇总、个人任务四分类、老板总控台。个人任务只看本人，所以只要登录；总控台要专门权限。 */
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly ws: WorkspaceService) {}

  @AuthenticatedOnly()
  @Get('catalog')
  catalog(@CurrentUser() user: AuthUser) { return this.ws.catalog(user); }

  @RequirePermission('workbench.desk.view')
  @Get('desk/:positionId')
  desk(@CurrentUser() user: AuthUser, @Param('positionId', ParseIntPipe) positionId: number) { return this.ws.desk(user, positionId); }

  @RequirePermission('workbench.desk.view', 'resource.store-daily-metrics.view')
  @Get('daily')
  daily(@CurrentUser() user: AuthUser, @Query() q: DailyQuery) { return this.ws.daily(user, q.date); }

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
