import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { AllowUnboundFeishu, AuthenticatedOnly, AuthUser, CurrentUser, Public } from '../common/auth.decorators';
import { FeishuAuthService, stateCookie } from './feishu-auth.service';
class BeginDto { @IsInt() @Min(1) companyId!: number }
class PollDesktopDto { @IsString() @IsNotEmpty() @MaxLength(100) state!: string }
class CompleteDto { @IsString() @IsNotEmpty() @MaxLength(2000) code!: string; @IsString() @IsNotEmpty() @MaxLength(100) state!: string }
@Controller('auth/feishu')
@Throttle({ default: { limit: 20, ttl: 60000 } })
export class FeishuAuthController {
  constructor(private readonly auth: FeishuAuthService) {}
  @Public() @Get('companies') companies() { return this.auth.companies(); }
  private async begin(companyId: number, res: Response, user?: AuthUser, desktop = false) {
    const r = desktop ? await this.auth.startDesktop(companyId) : await this.auth.start(companyId, user);
    res.setHeader('Cache-Control', 'no-store');
    res.cookie(stateCookie(r.state), r.browser, { secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600000 });
    return { authorizationUrl: r.authorizationUrl, ...(desktop ? { state: r.state } : {}) };
  }
  @Public() @Post('start') start(@Body() b: BeginDto, @Res({ passthrough: true }) res: Response) { return this.begin(b.companyId, res); }
  @Public() @Post('desktop/start') startDesktop(@Body() b: BeginDto, @Res({ passthrough: true }) res: Response) { return this.begin(b.companyId, res, undefined, true); }
  @Public() @Post('desktop/relay') relayDesktop(@Body() b: CompleteDto) { return this.auth.relayDesktop(b.code, b.state); }
  @Public() @Throttle({ default: { limit: 240, ttl: 60000 } }) @Post('desktop/poll')
  async pollDesktop(@Body() b: PollDesktopDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { name, browser } = this.browserCookie(b.state, req);
    res.setHeader('Cache-Control', 'no-store');
    const result = await this.auth.pollDesktop(b.state, browser);
    if (result.login) res.clearCookie(name, { secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
    return result;
  }
  @AllowUnboundFeishu() @AuthenticatedOnly() @Post('bind/start') bindStart(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) { return this.begin(u.companyId, res, u); }
  @AllowUnboundFeishu() @AuthenticatedOnly() @Get('binding') binding(@CurrentUser() u: AuthUser) { return this.auth.status(u); }
  private browserCookie(state: string, req: Request) {
    const name = stateCookie(state);
    const browser = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1) ?? '';
    return { name, browser };
  }
  private finish(b: CompleteDto, req: Request, res: Response, u?: AuthUser) {
    const { name, browser } = this.browserCookie(b.state, req);
    res.setHeader('Cache-Control', 'no-store');
    res.clearCookie(name, { secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
    return this.auth.complete(b.code, b.state, browser, u);
  }
  @Public() @Post('complete') complete(@Body() b: CompleteDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.finish(b, req, res); }
  @AllowUnboundFeishu() @AuthenticatedOnly() @Post('bind/complete') bindComplete(@CurrentUser() u: AuthUser, @Body() b: CompleteDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.finish(b, req, res, u); }
}
