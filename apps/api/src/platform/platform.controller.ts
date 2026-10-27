import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { APPLY_PASSWORD_MIN, PHONE_PATTERN } from '@kudesi/shared';
import { CurrentPlatformAdmin, PlatformAdminUser, PlatformOnly, Public } from '../common/auth.decorators';
import { PlatformIntegrationService } from './platform-integrations.service';
import { PlatformService } from './platform.service';

class ApplyDto {
  @IsString() @Length(2, 100) companyName!: string;
  @IsString() @Length(1, 50) contactName!: string;
  @Matches(PHONE_PATTERN, { message: '请输入 11 位手机号' }) contactPhone!: string;
  @IsString() @MinLength(APPLY_PASSWORD_MIN, { message: `管理员密码至少 ${APPLY_PASSWORD_MIN} 位` }) @MaxLength(128) password!: string;
  @IsOptional() @IsString() @MaxLength(50) contactTitle?: string;
  @IsOptional() @IsString() @MaxLength(500) remark?: string;
}

class RejectDto {
  @IsString() @IsNotEmpty() @MaxLength(300) reason!: string;
}

class IntegrationAppDto {
  @IsString() @MaxLength(30) integrationKey!: string;
  @IsString() @MaxLength(16) environment!: string;
  @IsOptional() @IsString() @MaxLength(200) appKey?: string;
  @IsOptional() @IsString() @MaxLength(300) appSecret?: string;
  @IsOptional() @IsString() @MaxLength(200) baseUrl?: string;
  @IsOptional() @IsIn(['active', 'disabled']) status?: 'active' | 'disabled';
  @IsOptional() @IsString() @MaxLength(200) remark?: string;
}

class CompanyStatusDto {
  @IsIn(['active', 'suspended']) status!: 'active' | 'suspended';
}

/** 公开：企业申请开通。没有登录，所以限流收紧（每个来源每小时 5 次）。 */
@Controller('company-applications')
export class CompanyApplyController {
  constructor(private readonly platform: PlatformService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post()
  async apply(@Body() dto: ApplyDto) {
    await this.platform.apply(dto);
    return { ok: true };
  }
}

/** 平台后台：只有平台管理员能用。 */
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @PlatformOnly()
  @Get('me')
  me(@CurrentPlatformAdmin() admin: PlatformAdminUser) {
    return admin;
  }

  @PlatformOnly()
  @Get('company-applications')
  applications() {
    return this.platform.listApplications();
  }

  @PlatformOnly()
  @HttpCode(200)
  @Post('company-applications/:id/approve')
  approve(@CurrentPlatformAdmin() admin: PlatformAdminUser, @Param('id', ParseIntPipe) id: number) {
    return this.platform.approve(admin, id);
  }

  @PlatformOnly()
  @HttpCode(200)
  @Post('company-applications/:id/reject')
  async reject(@CurrentPlatformAdmin() admin: PlatformAdminUser, @Param('id', ParseIntPipe) id: number, @Body() dto: RejectDto) {
    await this.platform.reject(admin, id, dto.reason);
    return { ok: true };
  }

  @PlatformOnly()
  @Get('companies')
  companies() {
    return this.platform.listCompanies();
  }

  @PlatformOnly()
  @HttpCode(200)
  @Post('companies/:id/status')
  async setStatus(@CurrentPlatformAdmin() admin: PlatformAdminUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CompanyStatusDto) {
    await this.platform.setCompanyStatus(admin, id, dto.status);
    return { ok: true };
  }
}

/** 平台级接口应用配置（聚水潭等的应用密钥）：只有平台管理员；Secret 永不返回。 */
@Controller('platform/integration-apps')
export class PlatformIntegrationController {
  constructor(private readonly apps: PlatformIntegrationService) {}

  @PlatformOnly()
  @Get()
  list() { return this.apps.list(); }

  @PlatformOnly()
  @Put()
  save(@CurrentPlatformAdmin() admin: PlatformAdminUser, @Body() dto: IntegrationAppDto) { return this.apps.save(admin, dto); }

  @PlatformOnly()
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) { return this.apps.remove(id); }
}
