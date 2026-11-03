import { All, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthenticatedOnly, AuthUser, CurrentUser, Public, RequirePermission } from '../common/auth.decorators';
import { LegacySessionRuntime } from './legacy-session.service';
import { LegacyStore } from './legacy-store';

/** Two existing page entry points use the same engine decision; no new menu. */
@Controller()
export class LegacySessionEngineController {
  constructor(private readonly store: LegacyStore) {}
  @RequirePermission('finance.doc-withdrawal.view') @Get('session/engine')
  async finance(@CurrentUser() user: AuthUser) { return { engine: await this.store.engine(user), workspace: 'finance_withdrawal' }; }
  @RequirePermission('resource.company-store-maintenance.view') @Get('store-maintenance/engine')
  async maintenance(@CurrentUser() user: AuthUser) { return { engine: await this.store.engine(user), workspace: 'company_store_maintenance' }; }
}

@Controller('session-manager')
export class LegacySessionController {
  constructor(private readonly runtime: LegacySessionRuntime) {}
  // Keep the application's existing rate limit for one-time binding attempts.
  @Public() @Post('agent/register')
  register(@Req() req: Request, @Res() res: Response) { this.runtime.serve(req, res); }
  /** Every allowed original agent route verifies its own device token/binding code. */
  @Public() @SkipThrottle() @All('agent/{*path}')
  agent(@Req() req: Request, @Res() res: Response) { this.runtime.serve(req, res); }
  @AuthenticatedOnly() @SkipThrottle() @All('remote-sessions/{*path}')
  remote(@Req() req: Request, @Res() res: Response) { this.runtime.serve(req, res); }
  /** Existing global JWT/permissions guards run before the workspace/action gate. */
  @AuthenticatedOnly() @All('{*path}')
  employee(@Req() req: Request, @Res() res: Response) { this.runtime.serve(req, res); }
}
