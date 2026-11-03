import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createChecker } from '@kudesi/shared';
import { AuthenticatedOnly, AuthUser, Public } from '../../common/auth.decorators';
import { CryptoService } from '../../common/crypto.service';

/** Opt-in local feasibility sample. Not imported by AppModule or production main. */
export const LEGACY_LAB_HANDLER = Symbol('legacy-lab-handler');
export interface LegacySql {
  // Old query/execute have deliberately different return conventions.
  query(sql: string, params?: unknown[]): Promise<any[]>;
  execute(sql: string, params?: unknown[]): Promise<any>;
  withTransaction<T>(work: (tx: Omit<LegacySql, 'withTransaction'>) => Promise<T>): Promise<T>;
}
type Route = { method: string; path: RegExp; action: 'view' | 'manage' | 'agent'; fields?: string[] };
const ROUTES: Route[] = [
  { method: 'GET', path: /^\/(overview|devices|audit-logs)$/, action: 'view' },
  { method: 'POST', path: /^\/pairings$/, action: 'manage', fields: [] },
  { method: 'POST', path: /^\/managed-shops$/, action: 'manage', fields: ['storeIds', 'assignedDeviceId'] },
  { method: 'PATCH', path: /^\/managed-shops\/\d+\/login-credentials$/, action: 'manage', fields: ['account', 'password', 'clearPassword'] },
  { method: 'PATCH', path: /^\/managed-shops\/\d+\/auto-login$/, action: 'manage', fields: ['enabled'] },
  { method: 'POST', path: /^\/shops\/\d+\/credentials\/reveal$/, action: 'manage', fields: ['purpose'] },
  { method: 'POST', path: /^\/open-requests$/, action: 'manage', fields: ['storeId', 'deviceId'] },
  { method: 'GET', path: /^\/open-requests\/[\da-f-]{36}$/i, action: 'view' },
  { method: 'DELETE', path: /^\/open-requests\/[\da-f-]{36}$/i, action: 'manage' },
  { method: 'PATCH', path: /^\/devices\/[\da-f-]{36}\/revoke$/i, action: 'manage', fields: [] },
  { method: 'POST', path: /^\/agent\/register$/, action: 'agent', fields: ['pairingCode', 'name', 'hostname', 'platform', 'arch', 'agentVersion', 'publicKeyPem'] },
  { method: 'POST', path: /^\/agent\/heartbeat$/, action: 'agent', fields: ['agentVersion', 'currentRequestId', 'activeBrowserSessionIds'] },
  { method: 'GET', path: /^\/agent\/open-requests$/, action: 'agent' },
  { method: 'PATCH', path: /^\/agent\/open-requests\/[\da-f-]{36}$/i, action: 'agent', fields: ['status', 'progress', 'currentStep', 'errorCode', 'errorMessage'] },
  { method: 'POST', path: /^\/agent\/bindings$/, action: 'agent', fields: ['storeId', 'localProfileId', 'platformCode', 'loginStatus', 'sessionVersion', 'appliedSessionVersion', 'localStateHash', 'lastError', 'verification'] },
];

export function createLegacyLabHandler(sourceRoot: string, sql: LegacySql, crypto: CryptoService): RequestHandler {
  if (process.env.SESSION_LEGACY_LAB !== '1' || process.env.NODE_ENV === 'production') {
    throw new Error('Legacy bridge is available only in the explicitly enabled local lab');
  }
  const load = createRequire(path.resolve(sourceRoot, 'package.json'));
  const { createSessionManagerRouter } = load('./server/modules/session-manager/routes.js');
  const express = load('express');
  const router = express.Router();
  // Route allowlist is intentionally narrow: no old store UPDATEs, remote input,
  // packages or unrelated module endpoints are enabled by this first sample.
  router.use((req: Request & { user?: AuthUser; labAction?: Route['action'] }, res: Response, next: NextFunction) => {
    const route = ROUTES.find(r => req.method === r.method && r.path.test(req.path));
    if (!route) return res.status(404).json({ message: '此接口不在本地接入样例范围内' });
    if (route.fields && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(k => !route.fields!.includes(k)))) {
      return res.status(400).json({ message: '请求包含未允许的字段' });
    }
    req.labAction = route.action;
    if (route.action === 'agent' && req.body) {
      // This sample accepts task outcomes, not arbitrary agent text which might
      // contain credentials. Preserve the old business state machine itself.
      for (const field of ['errorMessage', 'lastError']) if (req.body[field]) req.body[field] = '助手回报异常，详情未保存';
      if (req.body.errorCode) req.body.errorCode = 'AGENT_ERROR';
      if (req.body.currentStep && !['opening_profile', 'checking_local', 'auto_login', 'waiting_login', 'verifying', 'claimed', 'running', 'waiting_human', 'opening', 'restoring', 'completed', 'failed'].includes(req.body.currentStep)) {
        return res.status(400).json({ message: '不支持的任务进度阶段' });
      }
    }
    if (route.action !== 'agent') {
      const user = req.user;
      if (!user) return res.status(401).json({ message: '请先登录' });
      const key = req.headers['x-session-workspace'] ?? req.query.workspaceKey ?? 'finance_withdrawal';
      const owner = key === 'finance_withdrawal' ? 'finance.session' : key === 'company_store_maintenance' ? 'resource.company-store-maintenance' : null;
      if (!owner) return res.status(404).json({ message: '工作区不存在' });
      const can = createChecker(user.permissions);
      if (!can(`${owner}.view`) || (route.action === 'manage' && !can(`${owner}.manage`))) {
        return res.status(403).json({ message: '没有当前用途的操作权限' });
      }
    }
    next();
  });
  router.use(createSessionManagerRouter({
    ...sql,
    asyncRoute: (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
      (req: Request, res: Response, next: NextFunction) => Promise.resolve(handler(req, res, next)).catch(next),
    getRequestCompanyId: (req: Request & { user: AuthUser }) => req.user.companyId,
    getRequestEmployeeId: (req: Request & { user: AuthUser }) => req.user.id,
    // The scoped action gate above already used the real new-OA permissions.
    authorizeDeviceManagement: async ({ req }: { req: { labAction?: Route['action'] } }) => ['view', 'manage'].includes(req.labAction ?? ''),
    encryptBusinessSecret: (value: string) => crypto.encrypt(value),
    decryptBusinessSecret: (value: string) => value ? crypto.decrypt(value) : '',
  }));
  const mount = express.Router();
  mount.use('/api/session-manager', router);
  return (req, res, next) => mount(req, res, (error?: unknown) => {
    if (!error) return next();
    // Never expose SQL, payloads or raw legacy exception text.
    const status = Number((error as { statusCode?: number }).statusCode) || 500;
    res.status(status).json({ message: status >= 500 ? '本地接入执行失败' : '旧接口拒绝此操作' });
  });
}

/** Must be mounted with the existing JwtAuthGuard and PermissionsGuard.
 * The lab test does that with real repositories and signed new-OA JWTs. */
@Controller('session-manager')
export class LegacyLabController {
  constructor(@Inject(LEGACY_LAB_HANDLER) private readonly handler: RequestHandler) {}

  // Legacy router, not employee JWT auth, verifies every device request.
  @Public() @All('agent/{*path}')
  agent(@Req() req: Request, @Res() res: Response) { return this.forward(req, res); }

  @AuthenticatedOnly() @All('{*path}')
  employee(@Req() req: Request, @Res() res: Response) { return this.forward(req, res); }

  private forward(req: Request, res: Response) {
    this.handler(req, res, () => { if (!res.headersSent) res.status(404).json({ message: '接口不存在' }); });
  }
}
