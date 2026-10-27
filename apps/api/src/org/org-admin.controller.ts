import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min, ValidateIf } from 'class-validator';
import { permissionCatalog } from '@kudesi/shared';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { DUTY_CATEGORIES, EMPLOYMENT_TYPES, OrgAdminService, PAY_TYPES, POSITION_LEVELS, WORKSPACE_TYPES } from './org-admin.service';

const WS = WORKSPACE_TYPES as string[];

class NameDto {
  @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
}
class CreatePositionDto {
  @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(64) positionKey?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) departmentId?: number | null;
  @IsIn(WS) workspaceType!: string;
  @IsOptional() @IsIn([...POSITION_LEVELS]) level?: 'boss' | 'manager' | 'staff';
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) supervisorPositionId?: number | null;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
}
class UpdatePositionDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(64) positionKey?: string | null;
  @IsOptional() @IsIn([...POSITION_LEVELS]) level?: 'boss' | 'manager' | 'staff';
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) supervisorPositionId?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) departmentId?: number | null;
  @IsOptional() @IsIn(WS) workspaceType?: string;
}
class PermissionsDto {
  @IsArray() @IsString({ each: true }) permissions!: string[];
}
class CreateStaffDto {
  @IsString() @Matches(/^[A-Za-z0-9_.-]{2,64}$/, { message: '账号只能用字母、数字、下划线、点和横线，2 到 64 位' }) account!: string;
  @IsString() @IsNotEmpty() @MaxLength(50) name!: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) departmentId?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) positionId?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsInt({ each: true }) @Min(1, { each: true }) extraPositionIds?: number[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) managerId?: number | null;
  @IsOptional() @IsString() @MaxLength(60) title?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) baseSalary?: number | null;
  @IsOptional() @IsIn([...PAY_TYPES]) payType?: 'monthly' | 'hourly';
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) hourlyRate?: number | null;
  @IsOptional() @IsIn([...EMPLOYMENT_TYPES]) employmentType?: 'regular' | 'part_time' | 'temp';
}
class UpdateStaffDto {
  @IsOptional() @IsIn([...PAY_TYPES]) payType?: 'monthly' | 'hourly';
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) hourlyRate?: number | null;
  @IsOptional() @IsIn([...EMPLOYMENT_TYPES]) employmentType?: 'regular' | 'part_time' | 'temp';
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) managerId?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(60) title?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) baseSalary?: number | null;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(50) name?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) departmentId?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) positionId?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsInt({ each: true }) @Min(1, { each: true }) extraPositionIds?: number[];
}
class OverridesDto {
  @IsArray() @IsString({ each: true }) allow!: string[];
  @IsArray() @IsString({ each: true }) deny!: string[];
}
class UpdateDepartmentDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) parentId?: number | null;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) managerId?: number | null;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
class HandoverDto {
  @IsOptional() @IsInt() @Min(1) targetUserId?: number;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
class StatusDto {
  @IsIn(['active', 'disabled']) status!: 'active' | 'disabled';
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
  @IsOptional() @IsInt() @Min(1) handoverToUserId?: number;
}
class DeleteDepartmentDto {
  @IsOptional() @IsInt() @Min(1) transferToId?: number;
}
class DutyDto {
  @IsIn([...DUTY_CATEGORIES]) category!: string;
  @IsString() @IsNotEmpty() @MaxLength(150) title!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(60) frequency?: string;
  @IsOptional() @IsString() @MaxLength(60) relatedModule?: string;
  @IsOptional() @IsString() @MaxLength(1000) completionStandard?: string;
  @IsOptional() isKey?: boolean;
}
class UpdateDutyDto {
  @IsOptional() @IsIn([...DUTY_CATEGORIES]) category?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(150) title?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(60) frequency?: string | null;
  @IsOptional() @IsString() @MaxLength(60) relatedModule?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) completionStandard?: string | null;
  @IsOptional() isKey?: boolean;
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

@Controller('org')
export class OrgAdminController {
  constructor(private readonly admin: OrgAdminService) {}

  /** 权限清单本身不含敏感信息，岗位/员工页都要用 */
  @AuthenticatedOnly()
  @Get('permission-catalog')
  catalog() {
    return permissionCatalog();
  }

  @RequirePermission('org.structure.edit')
  @Patch('departments/:id')
  updateDepartment(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateDepartmentDto) {
    return this.admin.updateDepartment(u, id, dto);
  }

  @RequirePermission('org.structure.delete')
  @Delete('departments/:id')
  deleteDepartment(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: DeleteDepartmentDto) {
    return this.admin.deleteDepartment(u, id, dto?.transferToId);
  }

  @RequirePermission('org.structure.view')
  @Get('departments/:id/profile')
  departmentProfile(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.admin.departmentProfile(u, id);
  }

  @RequirePermission('org.structure.view')
  @Get('positions')
  positions(@CurrentUser() u: AuthUser) {
    return this.admin.listPositions(u);
  }

  @RequirePermission('org.structure.create')
  @Post('positions')
  createPosition(@CurrentUser() u: AuthUser, @Body() dto: CreatePositionDto) {
    return this.admin.createPosition(u, { name: dto.name, positionKey: dto.positionKey, departmentId: dto.departmentId, workspaceType: dto.workspaceType as never, level: dto.level, supervisorPositionId: dto.supervisorPositionId, description: dto.description });
  }

  @RequirePermission('org.structure.edit')
  @Patch('positions/:id')
  updatePosition(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePositionDto) {
    return this.admin.updatePosition(u, id, { ...dto, workspaceType: dto.workspaceType as never });
  }

  @RequirePermission('org.structure.view')
  @Get('positions/:id/profile')
  positionProfile(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.admin.positionProfile(u, id);
  }

  @RequirePermission('org.structure.edit')
  @Post('positions/:id/duties')
  createDuty(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: DutyDto) {
    return this.admin.createDuty(u, id, dto);
  }

  @RequirePermission('org.structure.edit')
  @Patch('position-duties/:id')
  updateDuty(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateDutyDto) {
    return this.admin.updateDuty(u, id, dto);
  }

  @RequirePermission('org.structure.edit')
  @Delete('position-duties/:id')
  @HttpCode(204)
  async deleteDuty(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.admin.deleteDuty(u, id);
  }

  @RequirePermission('org.structure.edit')
  @Put('positions/:id/permissions')
  setPositionPermissions(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: PermissionsDto) {
    return this.admin.setPositionPermissions(u, id, dto.permissions);
  }

  @RequirePermission('org.structure.delete')
  @Delete('positions/:id')
  @HttpCode(204)
  async deletePosition(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.admin.deletePosition(u, id);
  }

  @RequirePermission('org.staff.view')
  @Get('staff')
  staff(@CurrentUser() u: AuthUser) {
    return this.admin.listStaff(u);
  }

  @RequirePermission('org.staff.view')
  @Get('staff/:id')
  staffOne(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.admin.getStaff(u, id);
  }

  @RequirePermission('org.staff.create')
  @Post('staff')
  createStaff(@CurrentUser() u: AuthUser, @Body() dto: CreateStaffDto) {
    return this.admin.createStaff(u, dto);
  }

  @RequirePermission('org.staff.edit')
  @Patch('staff/:id')
  updateStaff(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateStaffDto) {
    return this.admin.updateStaff(u, id, dto);
  }

  @RequirePermission('org.staff.edit')
  @Put('staff/:id/overrides')
  overrides(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: OverridesDto) {
    return this.admin.setOverrides(u, id, dto.allow, dto.deny);
  }

  @RequirePermission('org.staff.view')
  @Get('staff/:id/records')
  records(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.admin.staffRecords(u, id);
  }

  @RequirePermission('org.staff.disable')
  @Post('staff/:id/handover')
  handover(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: HandoverDto) {
    return this.admin.handover(u, id, dto);
  }

  @RequirePermission('org.staff.disable')
  @Get('staff/:id/handover-preview')
  handoverPreview(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.admin.handoverPreview(u, id);
  }

  @RequirePermission('org.staff.disable')
  @Post('staff/:id/status')
  status(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: StatusDto) {
    return this.admin.setStatus(u, id, dto.status, dto.reason, dto.handoverToUserId);
  }

  @RequirePermission('org.staff.reset')
  @Post('staff/:id/reset-password')
  reset(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.admin.resetPassword(u, id);
  }
}
