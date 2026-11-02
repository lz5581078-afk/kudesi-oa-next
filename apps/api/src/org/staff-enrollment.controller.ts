import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { AuthUser, CurrentUser, Public, RequirePermission } from '../common/auth.decorators';
import { StaffEnrollmentService } from './staff-enrollment.service';

class CreateInviteDto {
  @IsIn(['general', 'position']) mode!: 'general' | 'position';
  @IsOptional() @IsInt() @Min(1) positionId?: number;
  @IsOptional() @IsIn([7, 30, 90]) validDays?: number;
}
class TokenDto { @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token!: string }
class JoinDto extends TokenDto {
  @IsString() @IsNotEmpty() @MaxLength(50) name!: string;
  @IsString() @Matches(/^1[3-9]\d{9}$/, { message: '请填写有效的11位手机号' }) phone!: string;
  @IsString() @MinLength(10, { message: '登录密码至少10位' }) @MaxLength(64) password!: string;
  @IsOptional() @IsInt() @Min(1) positionId?: number;
}

@Controller('org/enrollment-invites')
export class StaffEnrollmentAdminController {
  constructor(private readonly service: StaffEnrollmentService) {}
  @RequirePermission('org.staff.create') @Get() list(@CurrentUser() user: AuthUser) { return this.service.list(user); }
  @RequirePermission('org.staff.create') @Post() create(@CurrentUser() user: AuthUser, @Body() body: CreateInviteDto) { return this.service.create(user, body); }
  @RequirePermission('org.staff.create') @Post(':id/revoke') revoke(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.service.revoke(user, id); }
}

@Controller('enrollment')
export class StaffEnrollmentPublicController {
  constructor(private readonly service: StaffEnrollmentService) {}
  @Public() @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Post('preview') preview(@Body() body: TokenDto) { return this.service.preview(body.token); }
  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('join') join(@Body() body: JoinDto) { return this.service.join(body); }
}
