import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, Public } from '../common/auth.decorators';
import { AuthService } from './auth.service';

class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  companyCode!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  account!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}

class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  oldPassword!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  newPassword!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // 登录接口单独收紧：每分钟最多 10 次
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.companyCode, dto.account, dto.password);
  }

  @AuthenticatedOnly()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id, user.companyId);
  }

  @AuthenticatedOnly()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('change-password')
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(user.id, user.companyId, dto.oldPassword, dto.newPassword);
    return { ok: true };
  }
}
