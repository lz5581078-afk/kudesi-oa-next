import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthenticatedOnly, AuthUser, CurrentUser, Public } from '../common/auth.decorators';
import { FeishuAuthService, stateCookie } from './feishu-auth.service';
class BeginDto { @IsInt() @Min(1) companyId!: number }
class CompleteDto { @IsString() @IsNotEmpty() @MaxLength(2000) code!: string; @IsString() @IsNotEmpty() @MaxLength(100) state!: string }
@Controller('auth/feishu')
@Throttle({ default: { limit: 20, ttl: 60000 } })
export class FeishuAuthController {
  constructor(private readonly auth: FeishuAuthService) {}
  @Public() @Get('companies') companies() { return this.auth.companies(); }
  private async begin(companyId: number, res: Response, user?: AuthUser) {
    const r = await this.auth.start(companyId, user);
    res.setHeader('Cache-Control', 'no-store');
    res.cookie(stateCookie(r.state), r.browser, { secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600000 });
    return { authorizationUrl: r.authorizationUrl };
  }
  @Public() @Post('start') start(@Body() b: BeginDto, @Res({ passthrough: true }) res: Response) { return this.begin(b.companyId, res); }
  @AuthenticatedOnly() @Post('bind/start') bindStart(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) { return this.begin(u.companyId, res, u); }
  @AuthenticatedOnly() @Get('binding') binding(@CurrentUser() u: AuthUser) { return this.auth.status(u); }
  private finish(b: CompleteDto, req: Request, res: Response, u?: AuthUser) {
    const name = stateCookie(b.state), raw = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1) ?? '';
    res.setHeader('Cache-Control', 'no-store');
    res.clearCookie(name, { secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
    return this.auth.complete(b.code, b.state, raw, u);
  }
  @Public() @Post('complete') complete(@Body() b: CompleteDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.finish(b, req, res); }
  @AuthenticatedOnly() @Post('bind/complete') bindComplete(@CurrentUser() u: AuthUser, @Body() b: CompleteDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.finish(b, req, res, u); }
}
