import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createChecker } from '@kudesi/shared';
import { Router, Request, Response } from 'express';
import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { LegacyStore, SessionWorkspace, workspaceKeys } from './legacy-store';
import { legacyRequestPolicy, legacyWorkspace } from './legacy-policy';
import { MaintenanceService } from './maintenance.service';
import { LegacyCaptureService } from './legacy-capture.service';
import { remoteGloballyDisabled } from './remote.service';
import { ensureLegacyStoreMappings } from './legacy-adoption';

type LegacyRequest = Request & { user?: AuthUser; sessionWorkspace?: { id: number; key: SessionWorkspace }; legacyAction?: string; legacyMaintenanceCandidates?: boolean };

@Injectable()
export class LegacySessionRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  private handler?: ReturnType<typeof Router>;
  private tickets?: any;
  private signaling?: { close(): Promise<void> };
  private leaseTimer?: NodeJS.Timeout;
  private sweeping = false;
  private assets?: { getLatestInstaller(): Promise<any>; getLatestUpdate(from?: string): Promise<any> };
  private readonly assetHashes = new Set<string>();
  private readonly logger = new Logger(LegacySessionRuntime.name);

  constructor(readonly store: LegacyStore, private readonly maintenance: MaintenanceService, private readonly captures: LegacyCaptureService, private readonly host: HttpAdapterHost) {}

  async onApplicationBootstrap() {
    if (!this.store.configured()) return;
    this.getHandler();
    const remote = this.store.module('remote-assistance-service');
    this.signaling = this.store.module('webrtc-signaling-server').attachWebRtcSignalingServer({
      server: this.host.httpAdapter.getHttpServer(), ticketStore: this.tickets,
      authorize: async (ticket: any) => {
        // Original normalizeBinding intentionally omits workspaceId. Derive it
        // from the exact persisted session, never from untrusted WS input.
        const scope = await this.ticketScope(ticket.binding);
        return !!scope && await this.store.remoteAllowed(scope.companyId, scope.workspaceId, ticket.binding.deviceId, ticket.binding.userId)
          && await remote.authorizeWebRtcTicket({ ticket, query: this.store.query });
      },
      onSessionClosed: async (binding: any) => {
        const scope = await this.ticketScope(binding);
        if (scope) await remote.disconnectRemoteTransport({ ...binding, ...scope, sessionId: binding.remoteSessionId, execute: this.store.execute });
      },
      logger: { info: () => undefined, warn: () => this.logger.warn('旧远程信令连接已拒绝或关闭'), error: () => this.logger.warn('旧远程信令异常') },
    });
    this.leaseTimer = setInterval(() => void this.sweep().catch(() => this.logger.warn('旧远程授权复核失败，已拒绝新操作')), 5000);
    this.leaseTimer.unref();
  }
  async onModuleDestroy() { if (this.leaseTimer) clearInterval(this.leaseTimer); await this.signaling?.close(); }

  private async ticketScope(binding: any) {
    const [row] = await this.store.query(`SELECT company_id,workspace_id FROM session_remote_sessions r WHERE id=? AND company_id=? AND user_id=? AND device_id=? AND shop_id=? AND browser_session_id=?
      AND NOT EXISTS (SELECT 1 FROM sm_legacy_captures c WHERE c.remote_session_id=r.id AND c.company_id=r.company_id AND c.workspace_id=r.workspace_id AND c.owns_remote=1)`,
      [binding.remoteSessionId, binding.companyId, binding.userId, binding.deviceId, binding.shopId, binding.browserSessionId]);
    return row ? { companyId: Number(row.company_id), workspaceId: Number(row.workspace_id) } : null;
  }

  private getHandler() {
    if (this.handler) return this.handler;
    const router = Router();
    this.tickets = this.store.module('webrtc-ticket-service').createWebRtcTicketStore();
    const originalAssets = this.store.module('agent-release-service').createAgentReleaseService({
      releaseDir: process.env.KUDESI_LEGACY_AGENT_ASSETS || path.join(__dirname, 'legacy-assets'),
    });
    // Preserve original version/hash/update contracts, add existing project's no-symlink boundary.
    const checked = async (release: any) => {
      const directory = path.dirname(release.filePath);
      const stat = await lstat(release.filePath);
      if (stat.isSymbolicLink() || (await lstat(directory)).isSymbolicLink() || (await lstat(path.join(directory, 'latest.json'))).isSymbolicLink() || await realpath(release.filePath) !== path.join(await realpath(directory), release.fileName)) throw new ConflictException('助手发布资产路径无效');
      const key = `${release.filePath}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${release.sha256}`;
      if (!this.assetHashes.has(key)) {
        const hash = createHash('sha256');
        for await (const bytes of createReadStream(release.filePath)) hash.update(bytes);
        if (hash.digest('hex') !== release.sha256) throw new ConflictException('助手资产摘要校验失败');
        if (this.assetHashes.size > 64) this.assetHashes.clear();
        this.assetHashes.add(key);
      }
      return release;
    };
    const assets = {
      getLatestInstaller: async () => checked(await originalAssets.getLatestInstaller()),
      getLatestUpdate: async (from?: string) => checked(await originalAssets.getLatestUpdate(from)),
      sendLatestInstaller: async (res: Response) => { await checked(await originalAssets.getLatestInstaller()); return originalAssets.sendLatestInstaller(res); },
      sendLatestUpdate: async (res: Response, from?: string) => { await checked(await originalAssets.getLatestUpdate(from)); return originalAssets.sendLatestUpdate(res, from); },
    };
    this.assets = assets;
    router.use((req: LegacyRequest, res, next) => { void this.prepare(req, res).then(handled => { if (!handled) this.store.forMaintenanceCandidates(!!req.legacyMaintenanceCandidates, () => next()); }).catch(next); });
    router.use(this.store.module('routes').createSessionManagerRouter({
      asyncRoute: (handler: any) => (req: Request, res: Response, next: any) => Promise.resolve(handler(req, res, next)).catch(next),
      query: this.store.query, execute: this.store.execute, withTransaction: this.store.withTransaction,
      getRequestCompanyId: (req: LegacyRequest) => req.user!.companyId,
      getRequestEmployeeId: (req: LegacyRequest) => req.user!.id,
      authorizeDeviceManagement: async ({ req }: { req: LegacyRequest }) => ['view', 'manage', 'remote'].includes(req.legacyAction ?? ''),
      encryptBusinessSecret: (value: string) => this.store.crypto.encrypt(value),
      decryptBusinessSecret: (value: string) => value ? this.store.crypto.decrypt(value) : '',
      webRtcTicketStore: this.tickets, agentReleaseService: assets,
    }));
    const mounted = Router(); mounted.use('/api/session-manager', router); this.handler = mounted;
    return mounted;
  }

  serve(req: Request, res: Response) {
    if (!this.store.configured()) throw new NotFoundException('旧版登录协议未启用');
    this.getHandler()(req, res, (error?: any) => {
      if (res.headersSent) return;
      const status = typeof error?.getStatus === 'function' ? error.getStatus() : Number(error?.statusCode) || (error ? 500 : 404);
      const message = status >= 500 ? '店铺登录服务暂不可用，请稍后核对状态' : error?.publicMessage || (typeof error?.getResponse === 'function' ? error.getResponse()?.message : undefined) || '请求被拒绝或接口不存在';
      res.status(status).json({ message });
    });
  }

  private async prepare(req: LegacyRequest, res: Response): Promise<boolean> {
    let action = legacyRequestPolicy(req);
    if (action === 'manage' && req.method === 'DELETE' && /^\/open-requests\/[\da-f-]{36}$/i.test(req.path) && req.user) {
      const keys = workspaceKeys(legacyWorkspace(req));
      if (!createChecker(req.user.permissions)(keys.manage)) action = 'remote';
    }
    req.legacyAction = action;
    if (action === 'agent') {
      let namespace: string | undefined;
      const minimumVersion = '0.3.45';
      const versions = this.store.module('agent-update-service');
      if (req.path === '/agent/register') {
        if (versions.compareVersions(req.body?.agentVersion, minimumVersion) < 0) throw new ConflictException('请使用0.3.45或以上兼容助手，旧版不会自动复用到新用途');
        const hash = createHash('sha256').update(String(req.body?.pairingCode ?? '').trim().toUpperCase()).digest('hex');
        const [binding] = await this.store.query(`SELECT p.company_id,w.workspace_key FROM session_device_pairings p
          JOIN session_workspaces w ON w.id=p.workspace_id AND w.company_id=p.company_id AND w.status='active'
          JOIN sm_legacy_company_adoptions a ON a.company_id=p.company_id
          WHERE p.code_hash=? AND p.used_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP LIMIT 1`, [hash]);
        if (!binding) throw new BadRequestException('绑定码无效、已使用或工作区未就绪');
        namespace = `v1:${binding.company_id}:${binding.workspace_key}`;
      }
      if (req.path !== '/agent/register') {
        const device = await this.store.module('device-auth').authenticateAgent({ authorization: req.headers.authorization, query: this.store.query });
        if (!device) throw new ForbiddenException('助手认证失败或授权已撤销');
        if (versions.compareVersions(req.path === '/agent/heartbeat' ? req.body?.agentVersion : device.agentVersion, minimumVersion) < 0) throw new ConflictException('负责电脑需升级到0.3.45或以上兼容助手');
        const adopted = await this.store.ds.query('SELECT company_id FROM sm_legacy_company_adoptions WHERE company_id = ?', [device.companyId]);
        if (!adopted.length) throw new ConflictException('设备所属公司尚未启用兼容工作区');
        if (req.path === '/agent/heartbeat') {
          const [workspace] = await this.store.query("SELECT workspace_key FROM session_workspaces WHERE id=? AND company_id=? AND status='active'", [device.workspaceId, device.companyId]);
          if (!workspace) throw new ForbiddenException('设备所属工作区已失效');
          namespace = `v1:${device.companyId}:${workspace.workspace_key}`;
        }
        await this.sweep(device.id);
      }
      if (namespace) {
        const send = res.json.bind(res);
        res.json = (body: any) => send(body && (body.deviceToken || body.authorized === true) ? { ...body, profileNamespace: namespace } : body);
      }
      if (req.body) {
        for (const key of ['error', 'errorMessage', 'lastError']) if (req.body[key]) req.body[key] = '助手回报异常，敏感详情未保存';
        if (req.body.errorCode) req.body.errorCode = 'AGENT_ERROR';
        if (req.body.failureCode) req.body.failureCode = 'AGENT_ERROR';
        if (req.body.currentStep && !(req.path === '/agent/heartbeat' ? /^(opening_shop|idle)$/ : /^(opening_profile|checking_local|auto_login|waiting_login|verifying|completed|failed|claimed|running|waiting_human|opening|restoring)$/).test(req.body.currentStep)) throw new BadRequestException('进度阶段无效');
      }
      return false;
    }
    const user = req.user;
    if (!user) throw new ForbiddenException('请先登录');
    const ws = legacyWorkspace(req), workspaceId = await this.store.workspace(user, ws, action);
    if (action === 'remote') {
      const remoteId = /^\/remote-sessions\/([\da-f-]{36})/i.exec(req.path)?.[1];
      if (remoteId) {
        const [captureOnly] = await this.store.ds.query('SELECT id FROM sm_legacy_captures WHERE company_id=? AND workspace_id=? AND remote_session_id=? AND owns_remote=1 LIMIT 1', [user.companyId, workspaceId, remoteId]);
        if (captureOnly) throw new ForbiddenException('此会话仅用于提现截图，不提供远程控制或浏览器关闭');
      }
    }
    req.legacyMaintenanceCandidates = ws === 'company_store_maintenance' && (req.path === '/shop-candidates' || (req.path === '/managed-shops' && req.method === 'POST'));
    if (req.path === '/managed-shops' && req.method === 'POST') {
      const ids = [...new Set<number>(req.body.storeIds ?? [])].sort((a, b) => a - b);
      if (!ids.length) throw new BadRequestException('至少选择一家店铺');
      const placeholders = ids.map(() => '?').join(',');
      const result = await this.store.forMaintenanceCandidates(!!req.legacyMaintenanceCandidates, () => this.store.withTransaction(async tx => {
        // Serialize first-time additions too: locking only an existing managed
        // row leaves competing inserts on different devices unprotected.
        await tx.query(`SELECT id FROM sm_legacy_store_ids WHERE company_id=? AND id IN (${placeholders}) ORDER BY id FOR UPDATE`, [user.companyId, ...ids]);
        const managed = await tx.query(`SELECT store_id,status FROM session_managed_shops WHERE company_id=? AND workspace_id=? AND store_id IN (${placeholders}) ORDER BY store_id FOR UPDATE`, [user.companyId, workspaceId, ...ids]);
        if (managed.some(row => row.status === 'active')) throw new ConflictException('所选店铺已在当前清单，请刷新；更换电脑请使用分配操作');
        // Removed entries may still own a browser or remote session. Restoring
        // must not silently move that live environment to another device.
        for (const [table, column, statuses] of [
          ['session_open_requests', 'store_id', "'queued','claimed','running','waiting_human','opening','restoring','waiting_login'"],
          ['managed_browser_sessions', 'shop_id', "'open','closing'"],
          ['session_remote_sessions', 'shop_id', "'requested','connected','closing'"],
        ]) {
          const live = await tx.query(`SELECT id FROM ${table} WHERE company_id=? AND workspace_id=? AND ${column} IN (${placeholders}) AND status IN (${statuses}) LIMIT 1 FOR UPDATE`, [user.companyId, workspaceId, ...ids]);
          if (live.length) throw new ConflictException('店铺仍有登录任务、浏览器或远程会话，请结束并安全关闭后再加入');
        }
        const added = await this.store.module('managed-shop-service').addManagedShops({ companyId: user.companyId, workspaceId, employeeId: user.id,
          storeIds: ids, assignedDeviceId: req.body.assignedDeviceId, withTransaction: (work: (sql: typeof tx) => Promise<unknown>) => work(tx) });
        await tx.execute(`INSERT INTO session_audit_logs(company_id,workspace_id,employee_id,device_id,event_type,outcome,summary)
          VALUES(?,?,?,?,'managed_shops_added','success',?)`, [user.companyId, workspaceId, user.id, added.assignedDevice.id, `已将 ${added.selected} 家店铺加入登录态管理`]);
        return added;
      }));
      res.status(201).json(result); return true;
    }
    if (action === 'remote' && req.method === 'DELETE' && /^\/open-requests\/[\da-f-]{36}$/i.test(req.path)) {
      const id = req.path.split('/').pop();
      const [request] = await this.store.query('SELECT id FROM session_open_requests WHERE id=? AND company_id=? AND workspace_id=? AND requested_by_employee_id=?', [id, user.companyId, workspaceId, user.id]);
      if (!request) throw new NotFoundException('打开请求不存在或不属于本人');
    }
    if (req.path === '/oa-context') { res.json(await this.context(user, ws, workspaceId)); return true; }
    if (req.path === '/releases/windows/latest') {
      const installer = await this.assets!.getLatestInstaller();
      let updateAvailable = false;
      try { const update = await this.assets!.getLatestUpdate(); updateAvailable = update.version === installer.version; } catch { /* A valid installer is still usable without an update ZIP. */ }
      res.json({ product: installer.product, version: installer.version, platform: installer.platform, fileName: installer.fileName, sha256: installer.sha256, size: installer.size, signed: installer.signed, updateAvailable, downloadUrl: '/api/session-manager/releases/windows/download' });
      return true;
    }
    if (req.path === '/shop-candidates' && req.method === 'GET') await this.ensureStoreMappings(user);
    if (req.path === '/open-requests' && req.method === 'POST') {
      const [device] = await this.store.query("SELECT agent_version FROM session_devices WHERE id=? AND company_id=? AND workspace_id=? AND status='active'", [req.body.deviceId, user.companyId, workspaceId]);
      if (device && this.store.module('agent-update-service').compareVersions(device.agent_version, '0.3.45') < 0) throw new ConflictException('负责电脑需升级到0.3.45或以上兼容助手');
    }
    if (req.path.startsWith('/oa-remote/')) { res.json(await this.remoteConfiguration(req, user, ws, workspaceId)); return true; }
    const capture = /^\/oa-capture\/(\d+)$/.exec(req.path);
    if (capture) { res.json(await this.captures.begin(user, ws, Number(capture[1]))); return true; }
    const captureState = /^\/oa-requests\/([\da-f-]{36})$/i.exec(req.path);
    if (captureState) { res.json(await this.captures.get(user, ws, captureState[1])); return true; }
    const status = /^\/shops\/(\d+)\/archive-status$/.exec(req.path);
    if (status) {
      if (ws !== 'company_store_maintenance') throw new ForbiddenException('提现工作区不能修改公共店铺状态');
      const result = await this.maintenance.setStoreStatusFrom(user, async em => {
        const [row] = await this.store.forManager(em).query(`SELECT m.record_id FROM session_managed_shops s JOIN sm_legacy_store_ids m ON m.id = s.store_id AND m.company_id = s.company_id WHERE s.company_id = ? AND s.workspace_id = ? AND s.store_id = ? AND s.status = 'active' FOR UPDATE`, [user.companyId, workspaceId, Number(status[1])]);
        if (!row) throw new NotFoundException('店铺不在当前维护清单'); return Number(row.record_id);
      }, { status: req.body.status, abnormalReasonId: req.body.abnormalReasonId, reason: req.body.reason ?? req.body.abnormalReason }, async em => {
        await this.store.forManager(em).execute("INSERT INTO session_audit_logs(company_id,workspace_id,employee_id,store_id,event_type,outcome,summary) VALUES(?,?,?,?, 'store_archive_status_updated','success','店铺档案状态已通过新版资料事务更新')", [user.companyId, workspaceId, user.id, Number(status[1])]);
      });
      res.json(result); return true;
    }
    const rename = /^\/oa-devices\/([\da-f-]{36})\/name$/i.exec(req.path);
    if (rename) {
      if (typeof req.body.name !== 'string' || !req.body.name.trim() || req.body.name.length > 80) throw new BadRequestException('电脑名称需为1–80字');
      const result = await this.store.execute("UPDATE session_devices SET name = ? WHERE id = ? AND company_id = ? AND workspace_id = ? AND status <> 'deleted'", [req.body.name.trim(), rename[1], user.companyId, workspaceId]);
      if (!result.affectedRows) throw new NotFoundException('电脑不存在'); res.json({ ok: true }); return true;
    }
    if (action === 'remote') {
      // Cleanup and its exact owner-scoped status poll remain possible after a
      // device policy is disabled. This does not allow frame, ticket or input.
      const cleanup = req.method === 'DELETE' || req.path.endsWith('/end') ||
        (req.method === 'GET' && /^\/remote-sessions\/[\da-f-]{36}$/i.test(req.path));
      if (!cleanup && (req.path === '/remote-sessions' || req.path === '/open-requests')) {
        if (!await this.store.remoteAllowed(user.companyId, workspaceId, req.body.deviceId, user.id)) throw new ForbiddenException('该电脑未允许远程控制');
      } else if (!cleanup) {
        const id = /^\/remote-sessions\/([\da-f-]{36})/i.exec(req.path)?.[1];
        if (id) {
          const [remote] = await this.store.query('SELECT device_id FROM session_remote_sessions WHERE id = ? AND company_id = ? AND workspace_id = ? AND user_id = ?', [id, user.companyId, workspaceId, user.id]);
          if (!remote) throw new NotFoundException('远程会话不存在');
          if (!await this.store.remoteAllowed(user.companyId, workspaceId, remote.device_id, user.id)) throw new ForbiddenException('远程授权已停用');
        }
      }
    }
    if (req.method === 'POST' && req.path === '/remote-sessions') {
      const result = await this.store.withTransaction(async tx => {
        // Serialize against screenshot preparation on the same browser. Ordinary
        // control must not take over its temporary frame-only lease mid-upload.
        await tx.query('SELECT id FROM managed_browser_sessions WHERE id=? AND company_id=? AND workspace_id=? FOR UPDATE', [req.body.browserSessionId, user.companyId, workspaceId]);
        const [capture] = await tx.query(`SELECT r.id FROM session_remote_sessions r JOIN sm_legacy_captures c ON c.remote_session_id=r.id AND c.company_id=r.company_id AND c.workspace_id=r.workspace_id
          WHERE r.browser_session_id=? AND r.company_id=? AND r.workspace_id=? AND c.owns_remote=1 AND c.status='pending' AND r.status IN ('requested','connected','closing') AND r.expires_at>CURRENT_TIMESTAMP LIMIT 1 FOR UPDATE`, [req.body.browserSessionId, user.companyId, workspaceId]);
        if (capture) throw new ConflictException('正在获取提现凭证截图，请稍后再发起远程');
        return this.store.module('remote-assistance-service').createRemoteSession({ companyId: user.companyId, workspaceId, userId: user.id,
          browserSessionId: req.body.browserSessionId, deviceId: req.body.deviceId, shopId: req.body.shopId,
          withTransaction: (work: (sql: typeof tx) => Promise<unknown>) => work(tx) });
      });
      res.status(201).json(result); return true;
    }
    return false;
  }

  async ensureStoreMappings(user: AuthUser) {
    await this.store.ds.transaction(async em => {
      const records: Array<{ id: number }> = await em.query("SELECT id FROM resource_records WHERE company_id=? AND type='stores' AND archived_at IS NULL ORDER BY id FOR UPDATE", [user.companyId]);
      await ensureLegacyStoreMappings(em, user.companyId, records.map(r => Number(r.id)));
    });
  }

  private async context(user: AuthUser, ws: SessionWorkspace, workspaceId: number) {
    const stores = await this.store.query(`SELECT s.store_id AS id,m.record_id AS resourceStoreId,s.withdrawal_login_account AS loginAccount,(s.withdrawal_login_password IS NOT NULL AND s.withdrawal_login_password <> '') AS hasPassword,
      CAST(JSON_UNQUOTE(JSON_EXTRACT(r.data,'$.abnormalReason')) AS UNSIGNED) AS abnormalReasonId
      FROM session_managed_shops s JOIN sm_legacy_store_ids m ON m.id=s.store_id AND m.company_id=s.company_id JOIN resource_records r ON r.id=m.record_id AND r.company_id=m.company_id AND r.type='stores' AND r.archived_at IS NULL
      WHERE s.company_id=? AND s.workspace_id=? AND s.status='active'`, [user.companyId, workspaceId]);
    const rows = await this.store.query(`SELECT s.store_id AS shopId,s.assigned_device_id AS deviceId,d.status,d.last_seen_at,p.enabled,p.allow_control,
      remote.id AS remoteId,remote.status AS remoteStatus,remote.user_id AS requestedBy,owner.name AS requestedByName FROM session_managed_shops s
      LEFT JOIN session_devices d ON d.id=s.assigned_device_id AND d.company_id=s.company_id AND d.workspace_id=s.workspace_id
      LEFT JOIN sm_legacy_remote_policies p ON p.device_id=d.id AND p.company_id=s.company_id AND p.workspace_id=s.workspace_id
      LEFT JOIN session_remote_sessions remote ON remote.device_id=d.id AND remote.shop_id=s.store_id AND remote.company_id=s.company_id AND remote.workspace_id=s.workspace_id AND remote.status IN ('requested','connected','closing')
      LEFT JOIN employees owner ON owner.id=remote.user_id AND owner.company_id=remote.company_id WHERE s.company_id=? AND s.workspace_id=? AND s.status='active'`, [user.companyId, workspaceId]);
    const can = createChecker(user.permissions), keys = workspaceKeys(ws);
    return { engine: 'legacy', canManage: can(keys.manage), canRemote: can(keys.remote), globalDisabled: remoteGloballyDisabled(), stores: stores.map(s => ({ ...s, id: Number(s.id), resourceStoreId: Number(s.resourceStoreId), hasPassword: !!s.hasPassword })), remoteStates: rows.map(s => ({ shopId: Number(s.shopId), remoteEnabled: !remoteGloballyDisabled() && !!s.enabled, allowControl: !!s.allow_control, maxMinutes: 10,
      deviceOnline: s.status === 'active' && Date.now() - new Date(s.last_seen_at ?? 0).getTime() < 15_000, live: s.remoteId ? { id: s.remoteId, status: s.remoteStatus === 'requested' ? 'requested' : 'active', mode: 'control', mine: Number(s.requestedBy) === user.id, requestedByName: s.requestedByName ?? '' } : null })) };
  }

  private async remoteConfiguration(req: LegacyRequest, user: AuthUser, ws: SessionWorkspace, workspaceId: number) {
    const keys = workspaceKeys(ws), can = createChecker(user.permissions);
    if (req.path === '/oa-remote/devices' && req.method === 'GET') {
      const devices = await this.store.query(`SELECT d.id AS deviceId,p.enabled,p.allow_control AS allowControl FROM session_devices d LEFT JOIN sm_legacy_remote_policies p ON p.device_id=d.id AND p.company_id=d.company_id AND p.workspace_id=d.workspace_id WHERE d.company_id=? AND d.workspace_id=? AND d.status<>'deleted'`, [user.companyId, workspaceId]);
      let iceConfigured = false;
      try {
        this.store.module('webrtc-ticket-service').createIceServerCredentials({ binding: { companyId: 1, userId: 1, shopId: 1,
          deviceId: '00000000-0000-0000-0000-000000000001', browserSessionId: '00000000-0000-0000-0000-000000000002', remoteSessionId: '00000000-0000-0000-0000-000000000003' },
          stunUrls: process.env.WEBRTC_STUN_URLS, turnUrls: process.env.WEBRTC_TURN_URLS, turnSharedSecret: process.env.WEBRTC_TURN_SHARED_SECRET });
        iceConfigured = true;
      } catch { /* Report actual core configuration validity without exposing secrets. */ }
      return { globalDisabled: remoteGloballyDisabled(), iceConfigured, canManage: can(keys.manage), canRemote: can(keys.remote), limits: { minMinutes: 10, hardCapMinutes: 10 }, devices: devices.map(d => ({ ...d, enabled: !!d.enabled, allowControl: !!d.allowControl, maxMinutes: 10 })) };
    }
    if (req.path === '/oa-remote/history') {
      if (!can(keys.manage) && !can(keys.remote)) throw new ForbiddenException('没有查看远程日志的权限');
      const rows = await this.store.query(`SELECT s.id,st.name AS storeName,d.name AS deviceName,e.name AS requestedByName,s.status,s.created_at AS requestedAt,s.connected_at AS acceptedAt,s.closed_at AS endedAt FROM session_remote_sessions s LEFT JOIN stores st ON st.id=s.shop_id AND st.company_id=s.company_id LEFT JOIN session_devices d ON d.id=s.device_id AND d.company_id=s.company_id LEFT JOIN employees e ON e.id=s.user_id AND e.company_id=s.company_id WHERE s.company_id=? AND s.workspace_id=? ${can(keys.manage) ? '' : 'AND s.user_id=?'} ORDER BY s.created_at DESC LIMIT 100`, can(keys.manage) ? [user.companyId, workspaceId] : [user.companyId, workspaceId, user.id]);
      return rows.map(r => ({ ...r, mode: 'control', reason: '店铺远程协助', endReason: null, endReasonLabel: r.status === 'ended' ? '已结束' : null, endedByName: '', durationSeconds: r.acceptedAt ? Math.max(0, Math.round((new Date(r.endedAt ?? Date.now()).getTime() - new Date(r.acceptedAt).getTime()) / 1000)) : 0, inputCount: null, extendCount: null }));
    }
    if (req.path === '/oa-remote/stop-all') {
      const ended = await this.store.execute("UPDATE session_remote_sessions SET status='closed',closed_at=CURRENT_TIMESTAMP,frame_data=NULL WHERE company_id=? AND workspace_id=? AND status IN ('requested','connected')", [user.companyId, workspaceId]);
      const disabled = await this.store.ds.query('UPDATE sm_legacy_remote_policies SET enabled=0 WHERE company_id=? AND workspace_id=?', [user.companyId, workspaceId]);
      return { ended: ended.affectedRows, disabledDevices: disabled.affectedRows };
    }
    const deviceId = req.path.split('/').pop()!;
    if (typeof req.body.enabled !== 'boolean' || (req.body.enabled && req.body.allowControl !== true) || (req.body.maxMinutes !== undefined && req.body.maxMinutes !== 10)) throw new BadRequestException('旧助手远程仅支持明确授权的控制模式和10分钟会话');
    await this.store.withTransaction(async tx => {
      const [device] = await tx.query("SELECT id FROM session_devices WHERE id=? AND company_id=? AND workspace_id=? AND status<>'deleted' FOR UPDATE", [deviceId, user.companyId, workspaceId]);
      if (!device) throw new NotFoundException('电脑不存在');
      await tx.execute('INSERT INTO sm_legacy_remote_policies(company_id,workspace_id,device_id,enabled,allow_control,max_minutes) VALUES(?,?,?,?,?,10) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),allow_control=VALUES(allow_control)', [user.companyId, workspaceId, deviceId, req.body.enabled ? 1 : 0, req.body.allowControl ? 1 : 0]);
      if (!req.body.enabled) await tx.execute("UPDATE session_remote_sessions SET status='closed',closed_at=CURRENT_TIMESTAMP,frame_data=NULL WHERE company_id=? AND workspace_id=? AND device_id=? AND status IN ('requested','connected')", [user.companyId, workspaceId, deviceId]);
    });
    return { ok: true };
  }

  async sweep(deviceId?: string) {
    if (this.sweeping && !deviceId) return;
    this.sweeping = true;
    try {
      if (!deviceId) {
        const expired = await this.store.ds.query("SELECT id FROM sm_legacy_captures WHERE status='pending' AND (created_at<DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 30 SECOND) OR ?=1) LIMIT 100", [remoteGloballyDisabled() ? 1 : 0]);
        for (const candidate of expired) await this.store.ds.transaction(async em => {
          const [capture] = await em.query("SELECT * FROM sm_legacy_captures WHERE id=? AND status='pending' FOR UPDATE", [candidate.id]);
          if (!capture || (!remoteGloballyDisabled() && Date.now() - new Date(capture.created_at).getTime() <= 30_000)) return;
          await em.query("UPDATE sm_legacy_captures SET status='failed',error_text='截图超时或远程已停用',finished_at=CURRENT_TIMESTAMP(3) WHERE id=? AND company_id=? AND workspace_id=? AND status='pending'", [capture.id, capture.company_id, capture.workspace_id]);
          if (capture.owns_remote) await this.store.forManager(em).execute("UPDATE session_remote_sessions SET status='closed',closed_at=CURRENT_TIMESTAMP,frame_data=NULL WHERE id=? AND company_id=? AND workspace_id=? AND user_id=? AND status IN ('requested','connected')", [capture.remote_session_id, capture.company_id, capture.workspace_id, capture.user_id]);
        });
      }
      const sessions = await this.store.query(`SELECT id,company_id,workspace_id,user_id,device_id FROM session_remote_sessions WHERE status IN ('requested','connected') ${deviceId ? 'AND device_id=?' : ''}`, deviceId ? [deviceId] : []);
      for (const s of sessions) {
        if (await this.store.remoteAllowed(Number(s.company_id), Number(s.workspace_id), s.device_id, Number(s.user_id))) continue;
        // A screenshot lease never inherits queued input from an earlier control
        // session. The original agent's JPEG claim must receive no commands.
        await this.store.execute(`UPDATE session_remote_commands c JOIN session_remote_sessions r ON r.id=c.session_id
          SET c.status='failed',c.error_message='远程控制权限已停止，输入已取消',c.completed_at=CURRENT_TIMESTAMP
          WHERE r.id=? AND r.company_id=? AND r.workspace_id=? AND c.status IN ('queued','running')`, [s.id, s.company_id, s.workspace_id]);
        if (await this.store.captureAllowed(Number(s.company_id), Number(s.workspace_id), s.device_id, Number(s.user_id), s.id)) continue;
        await this.store.execute("UPDATE session_remote_sessions SET status='closed',closed_at=CURRENT_TIMESTAMP,frame_data=NULL,error_message='远程权限已失效' WHERE id=? AND company_id=? AND workspace_id=? AND status IN ('requested','connected')", [s.id, s.company_id, s.workspace_id]);
      }
    } finally { this.sweeping = false; }
  }
}
