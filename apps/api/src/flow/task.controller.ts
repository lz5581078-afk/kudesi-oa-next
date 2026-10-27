import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { TaskService } from './task.service';

class CreateTaskDto {
  @IsString() @MaxLength(150) title!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsInt() assigneeId?: number;
  @IsOptional() @IsString() @MaxLength(10) dueDate?: string;
  @IsOptional() @IsInt() supervisorId?: number;
  @IsOptional() @IsBoolean() requiresReview?: boolean;
  @IsOptional() @IsString() @MaxLength(30) feedbackPreset?: string;
  @IsOptional() @IsString() @MaxLength(500) completionStandard?: string;
}
class DoneDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
  @IsOptional() @IsBoolean() abnormal?: boolean;
}
class ReviewDto { @IsIn(['approve', 'return']) action!: 'approve' | 'return'; @IsOptional() @IsString() @MaxLength(500) comment?: string }
class DelayDto { @IsString() @MaxLength(10) dueDate!: string; @IsString() @MaxLength(500) reason!: string }
class DelayDecideDto { @IsBoolean() approve!: boolean; @IsOptional() @IsString() @MaxLength(500) comment?: string }
class AssignedQuery {
  @IsOptional() @IsIn(['open', 'reviewing', 'abnormal', 'done', 'cancelled']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
class RoutineDto {
  @IsString() @MaxLength(150) title!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsInt() assigneeId!: number;
  @IsIn(['daily', 'weekly', 'monthly']) frequency!: 'daily' | 'weekly' | 'monthly';
  @IsOptional() @IsInt() weekday?: number;
  @IsOptional() @IsInt() monthDay?: number;
  @IsInt() dueDays!: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() supervisorId?: number;
  @IsOptional() @IsBoolean() requiresReview?: boolean;
  @IsOptional() @IsString() @MaxLength(30) feedbackPreset?: string;
  @IsOptional() @IsString() @MaxLength(500) completionStandard?: string;
}
class ActiveDto { @IsBoolean() active!: boolean }

@Controller('tasks')
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  @RequirePermission('workbench.tasks.view')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() b: CreateTaskDto) { return this.tasks.create(user, b); }

  @RequirePermission('workbench.tasks.view')
  @Get('assigned')
  assigned(@CurrentUser() user: AuthUser, @Query() q: AssignedQuery) { return this.tasks.assigned(user, { status: q.status, page: q.page ?? 1, pageSize: q.pageSize ?? 20 }); }

  @RequirePermission('workbench.tasks.view')
  @Get('supervised')
  supervised(@CurrentUser() user: AuthUser, @Query() q: AssignedQuery) { return this.tasks.supervised(user, { status: q.status, page: q.page ?? 1, pageSize: q.pageSize ?? 20 }); }

  @AuthenticatedOnly()
  @Get('review-counts')
  reviewCounts(@CurrentUser() user: AuthUser) { return this.tasks.reviewCounts(user.companyId, user.id); }

  @AuthenticatedOnly()
  @Post(':id/review')
  review(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReviewDto) { return this.tasks.review(user, id, b); }

  @AuthenticatedOnly()
  @Post(':id/delay')
  delay(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: DelayDto) { return this.tasks.requestDelay(user, id, b); }

  @AuthenticatedOnly()
  @Post('delays/:id/decide')
  decideDelay(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: DelayDecideDto) { return this.tasks.decideDelay(user, id, b); }

  @AuthenticatedOnly()
  @Post(':id/complete')
  complete(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: DoneDto) { return this.tasks.complete(user, id, b.note, { payload: b.payload, abnormal: b.abnormal }); }

  @AuthenticatedOnly()
  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.tasks.cancel(user, id); }

  @RequirePermission('workbench.tasks.view')
  @Get('routines')
  routines(@CurrentUser() user: AuthUser) { return this.tasks.routines(user); }

  @RequirePermission('workbench.tasks.view')
  @Post('routines')
  createRoutine(@CurrentUser() user: AuthUser, @Body() b: RoutineDto) { return this.tasks.saveRoutine(user, null, b); }

  @RequirePermission('workbench.tasks.view')
  @Put('routines/:id')
  updateRoutine(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: RoutineDto) { return this.tasks.saveRoutine(user, id, b); }

  @RequirePermission('workbench.tasks.view')
  @Post('routines/:id/active')
  setActive(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ActiveDto) { return this.tasks.setRoutineActive(user, id, b.active); }
}
