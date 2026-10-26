import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { OrgService } from './org.service';

class CreateDepartmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  parentId?: number;
}

// 注意：companyId、操作人都不在请求体里，只取自登录令牌
@Controller('org')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @RequirePermission('org.structure.view')
  @Get('departments')
  departments(@CurrentUser() user: AuthUser) {
    return this.org.departmentTree(user);
  }

  /** 员工通讯录（只含 id/姓名/是否在职），资料页的“选择员工”要用；不含账号等信息 */
  @AuthenticatedOnly()
  @Get('users')
  users(@CurrentUser() user: AuthUser) {
    return this.org.directory(user);
  }

  @AuthenticatedOnly()
  @Get('department-directory')
  departmentDirectory(@CurrentUser() user: AuthUser) {
    return this.org.departmentDirectory(user);
  }

  @RequirePermission('org.structure.create')
  @Post('departments')
  createDepartment(@CurrentUser() user: AuthUser, @Body() dto: CreateDepartmentDto) {
    return this.org.createDepartment(user, { name: dto.name, parentId: dto.parentId ?? null });
  }
}
