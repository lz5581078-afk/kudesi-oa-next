import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { FlowDesignerService } from './flow-designer.service';
import { FlowTimeoutService } from './flow-timeout.service';

class CreateDto {
  @IsString() @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @Type(() => Number) @IsInt() departmentId?: number | null;
  @IsOptional() @IsString() @MaxLength(40) sourceKey?: string | null;
}
class MetaDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() departmentId?: number | null;
}
class ActivateDto { @IsInt() @Min(1) version!: number }
class NodeTemplateDto {
  @IsOptional() @IsString() @MaxLength(40) key?: string | null;
  @IsOptional() @IsString() @MaxLength(40) sourceKey?: string | null;
  @IsOptional() @IsInt() revision?: number;
  @IsString() @MaxLength(40) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsString() @MaxLength(20) category!: string;
  @IsString() @MaxLength(12) type!: string;
  @IsOptional() @IsInt() dueMinutes?: number | null;
  @IsArray() fields!: never[];
}
class PolicyQuery {
  @IsOptional() @IsString() @MaxLength(40) templateKey?: string;
  @IsOptional() @IsString() @MaxLength(40) nodeKey?: string;
}
class PolicyDto {
  @IsOptional() @IsString() @MaxLength(40) templateKey?: string;
  @IsOptional() @IsString() @MaxLength(40) nodeKey?: string;
  @IsObject() policy!: Record<string, unknown>;
  @IsInt() @Min(0) revision!: number;
}
class LedgerQuery {
  @IsOptional() @IsString() @MaxLength(40) templateKey?: string;
  @IsOptional() @IsIn(['all', 'open', 'pending', 'confirmed', 'waived']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
}
class DecideDto {
  @IsIn(['confirmed', 'waived']) status!: string;
  @IsInt() @Min(0) amountCents!: number;
  @IsString() @MaxLength(500) reason!: string;
  @IsInt() @Min(0) revision!: number;
}

/** 流程目录、自建模板生命周期、节点中心、超时与处罚。看需要对应页面的查看权限；改动的细权限（flow.templates.manage / flow.penalties.manage）在服务里按令牌身份判断。 */
@Controller('flow')
export class FlowDesignerController {
  constructor(private readonly designer: FlowDesignerService, private readonly timeout: FlowTimeoutService) {}

  @RequirePermission('flow.templates.view')
  @Get('duty-group-usage/:id')
  dutyGroupUsage(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.designer.dutyGroupUsage(user, id); }

  @RequirePermission('flow.templates.view')
  @Get('directory')
  directory(@CurrentUser() user: AuthUser) { return this.designer.directory(user); }

  @RequirePermission('flow.templates.view')
  @Post('templates')
  create(@CurrentUser() user: AuthUser, @Body() b: CreateDto) { return this.designer.create(user, b); }

  @RequirePermission('flow.templates.view')
  @Put('templates/:key/meta')
  meta(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() b: MetaDto) { return this.designer.updateMeta(user, key, b); }

  @RequirePermission('flow.templates.view')
  @Delete('templates/:key')
  remove(@CurrentUser() user: AuthUser, @Param('key') key: string) { return this.designer.remove(user, key); }

  @RequirePermission('flow.templates.view')
  @Post('definitions/:key/deactivate')
  deactivate(@CurrentUser() user: AuthUser, @Param('key') key: string) { return this.designer.deactivate(user, key); }

  @RequirePermission('flow.templates.view')
  @Post('definitions/:key/activate')
  activate(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() b: ActivateDto) { return this.designer.activate(user, key, b.version); }

  @RequirePermission('flow.templates.view')
  @Post('definitions/:key/discard-draft')
  discard(@CurrentUser() user: AuthUser, @Param('key') key: string) { return this.designer.discardDraft(user, key); }

  @RequirePermission('flow.node-templates.view')
  @Get('node-templates')
  nodeTemplates(@CurrentUser() user: AuthUser) { return this.designer.nodeTemplates(user); }

  /** 套用节点模板时设计器也要读，所以流程配置页的人同样可读 */
  @RequirePermission('flow.templates.view')
  @Get('node-templates/for-designer')
  nodeTemplatesForDesigner(@CurrentUser() user: AuthUser) { return this.designer.nodeTemplates(user); }

  @RequirePermission('flow.node-templates.view')
  @Post('node-templates')
  saveNode(@CurrentUser() user: AuthUser, @Body() b: NodeTemplateDto) { return this.designer.saveNodeTemplate(user, b as never); }

  @RequirePermission('flow.node-templates.view')
  @Delete('node-templates/:key')
  deleteNode(@CurrentUser() user: AuthUser, @Param('key') key: string) { return this.designer.deleteNodeTemplate(user, key); }

  @RequirePermission('flow.timeouts.view')
  @Get('timeout-policy')
  policy(@CurrentUser() user: AuthUser, @Query() q: PolicyQuery) { return this.timeout.getPolicy(user, q.templateKey ?? '', q.nodeKey ?? ''); }

  @RequirePermission('flow.timeouts.view')
  @Put('timeout-policy')
  savePolicy(@CurrentUser() user: AuthUser, @Body() b: PolicyDto) { return this.timeout.savePolicy(user, b.templateKey ?? '', b.nodeKey ?? '', b.policy, b.revision); }

  @RequirePermission('flow.timeouts.view')
  @Get('timeout-ledger')
  ledger(@CurrentUser() user: AuthUser, @Query() q: LedgerQuery) { return this.timeout.ledger(user, { templateKey: q.templateKey, status: q.status, page: q.page ?? 1 }); }

  @RequirePermission('flow.timeouts.view')
  @Post('timeout-penalties/:id/decide')
  decide(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: DecideDto) { return this.timeout.decidePenalty(user, id, b); }
}
