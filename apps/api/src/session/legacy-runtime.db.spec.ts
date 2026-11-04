import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { WebSocket } from 'ws';
import { Company, User, PlatformAdmin, PositionPermission, UserPermissionOverride, SessionDevice, SessionShop } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { PermissionsGuard } from '../common/permissions.guard';
import { configureBodyParsers } from '../common/body-parsers';
import { buildServices } from '../test-support';
import { LegacyStore, SessionWorkspace } from './legacy-store';
import { LegacySessionRuntime } from './legacy-session.service';
import { LegacySessionController, LegacySessionEngineController } from './legacy-session.controller';
import { LegacyCaptureService } from './legacy-capture.service';
import { LegacyAdoptionService } from './legacy-adoption';
import { MaintenanceService } from './maintenance.service';
import { SessionService } from './session.service';
import { SessionController, AgentController, MaintenanceController } from './session.controller';
import { NativeSessionFence } from './native-session-fence';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

const db = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
db('发布快照在真实Nest中的页面协议与远程信令接入（隔离MySQL）', () => {
  let ds: DataSource, app: INestApplication, base: string, jwt: JwtService;
  let store: LegacyStore, runtime: LegacySessionRuntime, services: ReturnType<typeof buildServices>;
  let boss: AuthUser, token: string, viewer: string, remoteToken: string, recordId: number, shopId: number;
  const devices: Record<string, { deviceId: string; deviceToken: string }> = {};
  let openId: string, browserId: string, profileId: string, remoteId: string;
  const sockets: WebSocket[] = [];
  const temporaryAgentDirs: string[] = [];
  const previous = { mode: process.env.KUDESI_SESSION_ENGINE, stun: process.env.WEBRTC_STUN_URLS, disabled: process.env.KUDESI_REMOTE_ASSIST_DISABLED };
  const workspace: SessionWorkspace = 'finance_withdrawal';
  const call = async (p: string, options: { body?: unknown; method?: string; auth?: string; ws?: SessionWorkspace } = {}) => {
    const response = await fetch(`${base}/api${p}${p.includes('?') ? '&' : '?'}workspaceKey=${options.ws ?? workspace}`, {
      method: options.method ?? 'GET', headers: { authorization: `Bearer ${options.auth ?? token}`, 'content-type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const body = response.status === 204 ? null : await response.json();
    return { status: response.status, body: body as any };
  };
  const old = (p: string, o: Parameters<typeof call>[1] = {}) => call(`/session-manager${p}`, o);
  const agent = (p: string, body?: unknown, method = 'POST', ws: SessionWorkspace = workspace) => old(`/agent${p}`, { auth: devices[ws].deviceToken, method, body, ws });
  const frames = (socket: WebSocket) => {
    const queue: any[] = [], waiters: Array<(value: any) => void> = [];
    socket.on('message', raw => { const value = JSON.parse(String(raw)); const resolve = waiters.shift(); if (resolve) resolve(value); else queue.push(value); });
    return () => queue.length ? Promise.resolve(queue.shift()) : new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { const index = waiters.indexOf(done); if (index >= 0) waiters.splice(index, 1); reject(new Error('WebSocket test response timeout')); }, 5000);
      const done = (value: any) => { clearTimeout(timer); resolve(value); }; waiters.push(done);
    });
  };

  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '') || !/^(session_reuse_next_|kudesi_oa_test)/.test(process.env.TEST_DB_NAME ?? '')) throw new Error('Isolated local database required');
    const { buildDataSourceOptions, alignSessionTimeZone } = await import('../database/data-source');
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true });
    await ds.initialize(); await alignSessionTimeZone(ds); services = buildServices(ds); store = new LegacyStore(ds, services.crypto);
    const suffix = randomBytes(6).toString('hex');
    const company = await ds.manager.save(Company, { code: `rt${suffix}`, name: '正式协议合成公司', status: 'active' });
    const user = await ds.manager.save(User, { companyId: company.id, account: `rt${suffix}`, passwordHash: 'synthetic-only', name: '合成管理员', status: 'active', isCompanyAdmin: true, mustChangePassword: false });
    boss = { id: user.id, companyId: company.id, name: user.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    recordId = (await services.resources.create(boss, 'stores', { name: '保持新版的店铺', platform: 'pdd', platformStoreId: 'SYNTHETIC-ONLY' })).id;
    const nativeDevice = await ds.manager.save(SessionDevice, { companyId: company.id, name: '原电脑', deviceNo: randomBytes(6).toString('hex'), tokenHash: 'a'.repeat(64), status: 'revoked', agentVersion: '1.2.1' });
    for (const ws of [workspace, 'company_store_maintenance']) await ds.manager.save(SessionShop, { companyId: company.id, workspace: ws, storeId: recordId, deviceId: nativeDevice.id, loginAccount: `${ws}-account`, loginPasswordEnc: services.crypto.encrypt(`${ws}-secret`), autoLogin: true, status: 'active', loginState: 'none' });
    const adoption = new LegacyAdoptionService(store), preview = await adoption.preview(boss);
    await adoption.adopt(boss, preview.sourceHash, `company:${boss.companyId}:both-session-workspaces`);
    [shopId] = (await ds.query('SELECT id FROM sm_legacy_store_ids WHERE record_id=? AND company_id=?', [recordId, company.id])).map((r: any) => Number(r.id));
    const maintenance = new MaintenanceService(ds, services.crypto, services.files, services.resources);
    const capture = new LegacyCaptureService(store, services.files);
    const native = new SessionService(ds, services.crypto, services.files);
    const module = await Test.createTestingModule({ controllers: [LegacySessionController, LegacySessionEngineController, SessionController, AgentController, MaintenanceController], providers: [
      LegacySessionRuntime, NativeSessionFence, { provide: LegacyStore, useValue: store }, { provide: MaintenanceService, useValue: maintenance },
      { provide: LegacyCaptureService, useValue: capture }, { provide: SessionService, useValue: native },
    ] }).compile();
    process.env.KUDESI_SESSION_ENGINE = 'legacy'; process.env.WEBRTC_STUN_URLS = 'stun:127.0.0.1:3478'; delete process.env.KUDESI_REMOTE_ASSIST_DISABLED;
    app = module.createNestApplication({ logger: false, bodyParser: false }); configureBodyParsers(app); app.setGlobalPrefix('api');
    jwt = new JwtService({ secret: randomBytes(48).toString('base64') });
    const reflector = new Reflector();
    app.useGlobalGuards(new JwtAuthGuard(reflector, jwt, ds.getRepository(User), ds.getRepository(PlatformAdmin), ds.getRepository(Company), ds.getRepository(PositionPermission), ds.getRepository(UserPermissionOverride)), new PermissionsGuard(reflector));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl(); runtime = module.get(LegacySessionRuntime);
    token = jwt.sign({ sub: boss.id, cid: boss.companyId });
    const limited = async (permissions: string[]) => {
      const u = await ds.manager.save(User, { companyId: boss.companyId, account: `rt${randomBytes(6).toString('hex')}`, passwordHash: 'synthetic', name: '受限测试用户', status: 'active', isCompanyAdmin: false, mustChangePassword: false });
      for (const permission of permissions) await ds.manager.save(UserPermissionOverride, { userId: u.id, permission, effect: 'allow' });
      return jwt.sign({ sub: u.id, cid: u.companyId });
    };
    viewer = await limited(['finance.doc-withdrawal.view']);
    remoteToken = await limited(['finance.doc-withdrawal.view', 'finance.session.remote']);
  }, 120000);
  afterAll(async () => {
    for (const s of sockets) s.terminate();
    await app?.close(); if (ds?.isInitialized) await ds.destroy();
    for (const [field, value] of Object.entries(previous)) {
      const key = field === 'mode' ? 'KUDESI_SESSION_ENGINE' : field === 'stun' ? 'WEBRTC_STUN_URLS' : 'KUDESI_REMOTE_ASSIST_DISABLED';
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const directory of temporaryAgentDirs) {
      const resolved = await fs.realpath(directory), root = await fs.realpath(os.tmpdir());
      if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('kudesi-runtime-agent-test-')) throw new Error('Unexpected agent test cleanup path');
      await fs.rm(resolved, { recursive: true });
    }
  });

  it('原页面权限与引擎发现生效，native写入口封闭但提现凭证接口保留', async () => {
    expect((await call('/session/engine', { auth: viewer })).body).toMatchObject({ engine: 'legacy' });
    expect((await old('/oa-context', { auth: viewer })).body.stores[0]).toMatchObject({ id: shopId, resourceStoreId: recordId, loginAccount: `${workspace}-account`, hasPassword: true });
    expect((await old('/shops/'+shopId+'/credentials/reveal', { method: 'POST', body: {}, auth: viewer })).status).toBe(403);
    expect((await call('/session/shops', { method: 'POST', body: {} })).status).toBe(409);
    expect((await call('/session/docs/9999999/vouchers')).status).toBe(404);
    expect((await old('/overview', { auth: 'invalid' })).status).toBe(401);
  });

  it('两个用途的重复加入不能改绑电脑，恢复必须等待旧浏览器关闭，并发加入只有一个成功', async () => {
    const load = createRequire(path.resolve(__dirname, '../../../agent/legacy-runtime/index.js'));
    const publicKeyPem = load('./config.js').createDeviceKeyPair().publicKey;
    for (const ws of [workspace, 'company_store_maintenance'] as SessionWorkspace[]) {
      const localDevices: any[] = [];
      for (let i = 0; i < 2; i++) {
        const pairing = await old('/pairings', { method: 'POST', ws, body: {} });
        const device = await old('/agent/register', { method: 'POST', ws, body: { pairingCode: pairing.body.code,
          name: `加入保护-${i}`, hostname: 'synthetic-only', platform: 'win32', arch: 'x64', agentVersion: '0.3.45', publicKeyPem } });
        expect(device.status).toBe(201); localDevices.push(device.body);
        expect((await old('/agent/heartbeat', { method: 'POST', ws, auth: device.body.deviceToken,
          body: { agentVersion: '0.3.45', currentStep: 'idle', currentRequestId: null, activeBrowserSessionIds: [] } })).status).toBe(200);
      }
      const name = `加入保护-${randomBytes(5).toString('hex')}`;
      await services.resources.create(boss, 'stores', { name, platform: 'pdd' });
      const candidates = await old('/shop-candidates', { ws });
      const id = candidates.body.shops.find((row: any) => row.name === name).id;
      const add = (deviceId: string) => old('/managed-shops', { method: 'POST', ws, body: { storeIds: [id], assignedDeviceId: deviceId } });
      const results = await Promise.all(localDevices.map(d => add(d.deviceId)));
      expect(results.map(r => r.status).sort()).toEqual([201, 409]);
      const owner = localDevices[results.findIndex(r => r.status === 201)];
      const other = localDevices.find(d => d !== owner);
      expect((await add(owner.deviceId)).status).toBe(409);
      expect((await add(other.deviceId)).status).toBe(409);
      await store.execute('UPDATE session_managed_shops SET withdrawal_login_account=?,withdrawal_login_password=? WHERE company_id=? AND store_id=?',
        ['preserved-account', services.crypto.encrypt('synthetic-preserved-secret'), boss.companyId, id]);
      const opened = await old('/open-requests', { method: 'POST', ws, body: { storeId: id, deviceId: owner.deviceId } });
      expect(opened.status).toBe(201);
      // A stale restore must not reassign even a queued login request.
      await store.execute("UPDATE session_managed_shops SET status='removed' WHERE company_id=? AND store_id=?", [boss.companyId, id]);
      expect((await add(other.deviceId)).status).toBe(409);
      await store.execute("UPDATE session_open_requests SET status='completed' WHERE id=?", [opened.body.id]);
      const [scope] = await store.query('SELECT workspace_id FROM session_managed_shops WHERE company_id=? AND store_id=?', [boss.companyId, id]);
      const browserId = randomUUID();
      await store.execute(`INSERT INTO managed_browser_sessions(id,company_id,workspace_id,user_id,device_id,shop_id,local_profile_id,page_url,status)
        VALUES(?,?,?,?,?,?,?,?,'open')`, [browserId, boss.companyId, scope.workspace_id, boss.id, owner.deviceId, id, randomUUID(), 'https://mms.pinduoduo.com/home/']);
      expect((await add(other.deviceId)).status).toBe(409);
      const [unchanged] = await store.query('SELECT assigned_device_id,withdrawal_login_account,withdrawal_login_password FROM session_managed_shops WHERE company_id=? AND store_id=?', [boss.companyId, id]);
      expect(unchanged.assigned_device_id).toBe(owner.deviceId);
      expect(unchanged.withdrawal_login_account).toBe('preserved-account');
      expect(services.crypto.decrypt(unchanged.withdrawal_login_password)).toBe('synthetic-preserved-secret');
      await store.execute("UPDATE managed_browser_sessions SET status='closed',closed_at=CURRENT_TIMESTAMP WHERE id=?", [browserId]);
      const remoteId = randomUUID();
      await store.execute(`INSERT INTO session_remote_sessions(id,company_id,workspace_id,user_id,device_id,shop_id,browser_session_id,status,expires_at)
        VALUES(?,?,?,?,?,?,?,'requested',DATE_ADD(CURRENT_TIMESTAMP,INTERVAL 10 MINUTE))`, [remoteId, boss.companyId, scope.workspace_id, boss.id, owner.deviceId, id, browserId]);
      expect((await add(other.deviceId)).status).toBe(409);
      await store.execute("UPDATE session_remote_sessions SET status='ended',closed_at=CURRENT_TIMESTAMP WHERE id=?", [remoteId]);
      expect((await add(other.deviceId)).status).toBe(201);
      expect((await store.query('SELECT assigned_device_id FROM session_managed_shops WHERE company_id=? AND store_id=?', [boss.companyId, id]))[0].assigned_device_id).toBe(other.deviceId);
    }
  }, 30000);

  it('原助手完整心跳字段可用，两个用途分别绑定且分配CAS拒绝过时页面', async () => {
    const helperRoot = path.resolve(__dirname, '../../../agent/legacy-runtime');
    const load = createRequire(path.join(helperRoot, 'index.js'));
    const helperConfig = load('./config.js'), helperApi = load('./api.js').agentApi;
    const registerDevice = load('./register-device.js').registerDevice;
    const helperConfigs: Partial<Record<SessionWorkspace, { config: any; directory: string }>> = {};
    expect(helperConfig.AGENT_VERSION).toBe('0.3.45');
    for (const ws of [workspace, 'company_store_maintenance'] as SessionWorkspace[]) {
      const paired = await old('/pairings', { method: 'POST', ws, body: {} }); expect(paired.status).toBe(201);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kudesi-runtime-agent-test-'));
      temporaryAgentDirs.push(directory);
      const previousDataDir = process.env.SESSION_MANAGER_AGENT_DATA_DIR;
      const nativeFetch = globalThis.fetch;
      let registeredNamespace: unknown;
      process.env.SESSION_MANAGER_AGENT_DATA_DIR = directory;
      // Observe the real HTTP response; do not mock its status, payload or server.
      globalThis.fetch = async (input, init) => {
        const response = await nativeFetch(input, init);
        if (new URL(String(input), base).pathname === '/api/session-manager/agent/register') {
          registeredNamespace = (await response.clone().json()).profileNamespace;
        }
        return response;
      };
      try {
        await registerDevice({ serverUrl: base, pairingCode: paired.body.code, name: `合成-${ws}` });
        const config = await helperConfig.loadConfig();
        const expectedNamespace = `v1:${boss.companyId}:${ws}`;
        expect(registeredNamespace).toBe(expectedNamespace);
        expect(config.profileNamespace).toBe(expectedNamespace);
        helperConfigs[ws] = { config, directory };
        devices[ws] = { deviceId: config.deviceId, deviceToken: config.deviceToken };
        const heartbeat = await helperApi(config, '/api/session-manager/agent/heartbeat', { method: 'POST',
          body: JSON.stringify({ agentVersion: '0.3.45', currentStep: 'idle', currentRequestId: null, activeBrowserSessionIds: [] }) });
        expect(heartbeat).toMatchObject({ authorized: true, profileNamespace: expectedNamespace });
        expect((await helperConfig.loadConfig()).profileNamespace).toBe(expectedNamespace);
      } finally {
        globalThis.fetch = nativeFetch;
        if (previousDataDir === undefined) delete process.env.SESSION_MANAGER_AGENT_DATA_DIR;
        else process.env.SESSION_MANAGER_AGENT_DATA_DIR = previousDataDir;
      }
      const current = await old(`/shops/${shopId}`, { ws });
      expect((await old(`/managed-shops/${shopId}/assigned-device`, { method: 'PATCH', ws, body: { deviceId: devices[ws].deviceId, expectedDeviceId: current.body.shop.assignedDeviceId } })).status).toBe(200);
      expect((await old(`/managed-shops/${shopId}/assigned-device`, { method: 'PATCH', ws, body: { deviceId: null, expectedDeviceId: current.body.shop.assignedDeviceId } })).status).toBe(409);
    }
    const opened = await old('/open-requests', { method: 'POST', body: { storeId: shopId, deviceId: devices[workspace].deviceId } }); expect(opened.status).toBe(201); openId = opened.body.id;
    expect((await agent('/open-requests', undefined, 'GET', 'company_store_maintenance')).body.request).toBeNull();
    const claim = await agent('/open-requests', undefined, 'GET'); expect(claim.body.request.login_credentials.password).toBe(`${workspace}-secret`);
    const rawStoreId = String(claim.body.request.store_id); // Original open-shop keeps this field as a string.
    expect(Number(rawStoreId)).toBe(shopId);
    const helper = helperConfigs[workspace]!;
    const previousDataDir = process.env.SESSION_MANAGER_AGENT_DATA_DIR;
    process.env.SESSION_MANAGER_AGENT_DATA_DIR = helper.directory;
    try {
      profileId = helperConfig.ensureShopProfile(helper.config, rawStoreId, '合成受管店铺', 'pdd').localProfileId;
      await helperConfig.saveConfig(helper.config);
      expect(helper.config.shops[helperConfig.shopProfileKey(helper.config, rawStoreId)].localProfileId).toBe(profileId);
      expect(await load('./sessions.js').updateBinding(helper.config, rawStoreId, profileId,
        { loginStatus: 'pending', sessionVersion: 0, appliedSessionVersion: 0, localStateHash: '', lastError: '' })).toMatchObject({ ok: true });
    } finally {
      if (previousDataDir === undefined) delete process.env.SESSION_MANAGER_AGENT_DATA_DIR;
      else process.env.SESSION_MANAGER_AGENT_DATA_DIR = previousDataDir;
    }
    const browser = await agent('/browser-sessions', { openRequestId: openId, storeId: rawStoreId, localProfileId: profileId, platformCode: 'pdd', pageUrl: 'https://mms.pinduoduo.com/home/' }); expect(browser.status).toBe(201); browserId = browser.body.id;
    expect((await agent(`/open-requests/${openId}`, { status: 'completed', progress: 100, currentStep: 'completed' }, 'PATCH')).status).toBe(200);
  }, 30000);

  it('默认不允许远程；显式授权后签发票据；错误Profile和跨用途拒绝', async () => {
    expect((await old('/remote-sessions', { method: 'POST', body: { browserSessionId: browserId, deviceId: devices[workspace].deviceId, shopId } })).status).toBe(403);
    expect((await old(`/oa-remote/devices/${devices[workspace].deviceId}`, { method: 'POST', body: { enabled: true, allowControl: true, maxMinutes: 10 } })).status).toBe(200);
    expect((await old(`/oa-remote/devices/${devices[workspace].deviceId}`, { method: 'POST', body: { enabled: true, allowControl: false } })).status).toBe(400);
    const created = await old('/remote-sessions', { method: 'POST', body: { browserSessionId: browserId, deviceId: devices[workspace].deviceId, shopId } }); expect(created.status).toBe(201); remoteId = created.body.id;
    expect((await old(`/remote-sessions/${remoteId}`, { ws: 'company_store_maintenance' })).status).toBe(404);
    expect((await old(`/remote-sessions/${remoteId}/webrtc-ticket`, { method: 'POST', body: {}, auth: remoteToken })).status).toBe(404);
    expect((await agent('/browser-sessions', { openRequestId: openId, storeId: String(shopId), localProfileId: randomUUID(), platformCode: 'pdd', pageUrl: 'https://mms.pinduoduo.com/home/' })).status).toBe(409);
  });

  it('真实新版前端适配器直接调用运行中的后端，不用预设HTTP返回值', async () => {
    const { buildSync } = require('esbuild');
    const root = path.resolve(__dirname, '../../../..');
    const bundle = buildSync({ stdin: { contents: "export {makeSessionApi} from './apps/web/src/pages/finance/sessionApi'; export {tokenStore} from './apps/web/src/api/client';", resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' }).outputFiles[0].text;
    const memoryStorage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }; };
    const holder = { exports: {} as any };
    runInNewContext(bundle, { module: holder, exports: holder.exports, URLSearchParams, URL, Headers, FormData, Blob, crypto: globalThis.crypto, setTimeout, clearTimeout,
      localStorage: memoryStorage(), sessionStorage: memoryStorage(), fetch: (input: string, init: RequestInit) => fetch(new URL(input, base), init) });
    holder.exports.tokenStore.set(token);
    const client = holder.exports.makeSessionApi('/session');
    const page = await client.overview({ storeId: recordId });
    expect(page.shops[0]).toMatchObject({ id: shopId, storeId: recordId, deviceId: devices[workspace].deviceId, loginAccount: `${workspace}-account` });
    const rows = await client.devices();
    expect(rows.find((r: any) => r.id === devices[workspace].deviceId)).toMatchObject({ online: true, agentVersion: '0.3.45' });
    expect(await client.reveal(shopId)).toMatchObject({ account: `${workspace}-account`, password: `${workspace}-secret` });
    await client.updateShop(shopId, { loginAccount: 'front-connected-account', loginPassword: '' });
    expect((await client.overview({ storeId: recordId })).shops[0].loginAccount).toBe('front-connected-account');
    await expect(client.updateShop(shopId, { deviceId: devices[workspace].deviceId, expectedDeviceId: null })).rejects.toThrow();
  }, 20000);

  it('真实WebSocket握手、双方票据、信令转发与票据单次使用（非媒体连接）', async () => {
    const viewerTicket = await old(`/remote-sessions/${remoteId}/webrtc-ticket`, { method: 'POST', body: {} }); expect(viewerTicket.status).toBe(201);
    const agentTicket = await agent(`/remote-sessions/${remoteId}/webrtc-ticket`, {}); expect(agentTicket.status).toBe(201);
    const make = async (issued: any) => {
      const s = new WebSocket(base.replace(/^http/, 'ws') + issued.signalingPath); sockets.push(s); const next = frames(s);
      await new Promise<void>((resolve, reject) => { s.once('open', resolve); s.once('error', reject); });
      s.send(JSON.stringify({ type: 'authenticate', role: issued.role, ticket: issued.ticket })); return { s, next };
    };
    const view = await make(viewerTicket.body); expect((await view.next()).type).toBe('waiting');
    const peer = await make(agentTicket.body); expect((await peer.next()).type).toBe('paired'); expect((await view.next()).type).toBe('paired');
    peer.s.send(JSON.stringify({ type: 'offer', sdp: 'synthetic-signaling-only' })); expect(await view.next()).toMatchObject({ type: 'offer', sdp: 'synthetic-signaling-only' });
    const replay = new WebSocket(base.replace(/^http/, 'ws') + viewerTicket.body.signalingPath); sockets.push(replay);
    const closed = new Promise<number>(resolve => replay.once('close', resolve));
    replay.once('open', () => replay.send(JSON.stringify({ type: 'authenticate', role: 'viewer', ticket: viewerTicket.body.ticket })));
    expect(await closed).toBe(1008);
    view.s.close(); peer.s.close();
  }, 20000);

  it('旧大帧JSON走局部解析，非法域名拒绝，安全关闭只由匹配设备/Profile确认', async () => {
    expect((await old(`/remote-sessions/${remoteId}/jpeg-fallback`, { method: 'POST', body: {} })).status).toBe(200);
    // Deliberately synthetic protocol bytes, never presented as a real screenshot.
    const frame = Buffer.alloc(120000); frame[0] = 0xff; frame[1] = 0xd8;
    expect((await agent('/remote', { action: 'frame', sessionId: remoteId, pageUrl: 'https://example.com/', width: 100, height: 100, frame: frame.toString('base64') })).status).toBe(403);
    // The original core may terminate a session on a forbidden merchant URL.
    const [state] = await store.query('SELECT status FROM session_remote_sessions WHERE id=?', [remoteId]);
    if (!['requested', 'connected'].includes(state.status)) {
      const created = await old('/remote-sessions', { method: 'POST', body: { browserSessionId: browserId, deviceId: devices[workspace].deviceId, shopId } }); remoteId = created.body.id;
      await old(`/remote-sessions/${remoteId}/jpeg-fallback`, { method: 'POST', body: {} });
    }
    expect((await agent('/remote', { action: 'frame', sessionId: remoteId, pageUrl: 'https://mms.pinduoduo.com/home/', width: 100, height: 100, frame: frame.toString('base64') })).status).toBe(200);
    expect((await old(`/remote-sessions/${remoteId}`, { method: 'DELETE' })).body.status).toBe('closing');
    expect((await agent('/remote', { action: 'browser_closed', sessionId: remoteId, browserSessionId: browserId, shopId: String(shopId), localProfileId: randomUUID() })).status).toBe(403);
    expect((await agent('/remote', { action: 'browser_closed', sessionId: remoteId, browserSessionId: browserId, shopId: String(shopId), localProfileId: profileId })).body).toMatchObject({ status: 'ended', browserStatus: 'closed' });
  });

  it('保留公共资料单一事务；紧急停止和实际ICE配置状态不会伪报正常', async () => {
    const reason = await services.resources.create(boss, 'store-abnormal-reasons', { reason: '合成异常原因' });
    expect((await old(`/shops/${shopId}/archive-status`, { method: 'PATCH', ws: 'company_store_maintenance', body: { status: 'abnormal', abnormalReasonId: reason.id } })).status).toBe(200);
    expect((await services.resources.get(boss, 'stores', recordId)).status).toBe('abnormal');
    expect((await old(`/shops/${shopId}/archive-status`, { method: 'PATCH', body: { status: 'normal' } })).status).toBe(403);
    const oldStun = process.env.WEBRTC_STUN_URLS, oldTurn = process.env.WEBRTC_TURN_URLS;
    delete process.env.WEBRTC_STUN_URLS; delete process.env.WEBRTC_TURN_URLS;
    expect((await old('/oa-remote/devices')).body.iceConfigured).toBe(false);
    if (oldStun !== undefined) process.env.WEBRTC_STUN_URLS = oldStun;
    if (oldTurn !== undefined) process.env.WEBRTC_TURN_URLS = oldTurn;
    process.env.KUDESI_REMOTE_ASSIST_DISABLED = '1';
    expect((await old('/oa-context')).body.globalDisabled).toBe(true);
    expect((await old('/oa-remote/devices')).body.globalDisabled).toBe(true);
    expect(await store.remoteAllowed(boss.companyId, Number((await store.query('SELECT id FROM session_workspaces WHERE company_id=? AND workspace_key=?', [boss.companyId, workspace]))[0].id), devices[workspace].deviceId, boss.id)).toBe(false);
    await runtime.sweep(); delete process.env.KUDESI_REMOTE_ASSIST_DISABLED;
  });

  it('维护清单仍可加入异常/停用店铺，财务仍限正常；候选映射不复用历史低编号', async () => {
    const extra = await services.resources.create(boss, 'stores', { name: '新版停用合成店', platform: 'pdd' });
    await ds.transaction(em => services.resources.saveChecked(em, boss, 'stores', extra.id, {}, { status: 'inactive', statusReason: '合成停用原因' }));
    const maintenance = await old('/shop-candidates', { ws: 'company_store_maintenance' });
    expect(maintenance.status).toBe(200);
    const candidate = maintenance.body.shops.find((s: any) => s.name === '新版停用合成店');
    expect(candidate.id).toBeGreaterThan(2 ** 40);
    expect((await old('/shop-candidates')).body.shops.some((s: any) => s.id === candidate.id)).toBe(false);
    expect((await old('/managed-shops', { method: 'POST', ws: 'company_store_maintenance', body: { storeIds: [candidate.id], assignedDeviceId: devices.company_store_maintenance.deviceId } })).status).toBe(201);
    expect((await old('/managed-shops', { method: 'POST', body: { storeIds: [candidate.id], assignedDeviceId: devices[workspace].deviceId } })).status).toBe(400);
  });

  it('只授予查看+远程的用户可为本人发起、取消和远程，不能读取明文或接管他人请求', async () => {
    const body = { storeId: shopId, deviceId: devices[workspace].deviceId };
    expect((await old('/open-requests', { method: 'POST', auth: remoteToken, body })).status).toBe(403);
    expect((await old(`/shops/${shopId}/credentials/reveal`, { method: 'POST', auth: remoteToken, body: {} })).status).toBe(403);
    expect((await old(`/open-requests/${openId}`, { method: 'DELETE', auth: remoteToken })).status).toBe(404);
    const first = await old('/open-requests', { method: 'POST', auth: remoteToken, body: { ...body, purpose: 'remote' } }); expect(first.status).toBe(201);
    expect((await old(`/open-requests/${first.body.id}`, { method: 'DELETE', auth: remoteToken })).status).toBe(200);
    const opened = await old('/open-requests', { method: 'POST', auth: remoteToken, body: { ...body, purpose: 'remote' } }); expect(opened.status).toBe(201);
    expect(Number((await agent('/open-requests', undefined, 'GET')).body.request.requested_by_employee_id)).toBe(jwt.decode(remoteToken).sub);
    const registration = { openRequestId: opened.body.id, storeId: String(shopId), localProfileId: profileId, platformCode: 'pdd', pageUrl: 'https://mms.pinduoduo.com/home/' };
    const [browser, duplicate] = await Promise.all([agent('/browser-sessions', registration), agent('/browser-sessions', registration)]);
    expect(browser.status).toBe(201); expect(duplicate.status).toBe(201);
    expect(duplicate.body.id).toBe(browser.body.id);
    const [active] = await store.query("SELECT COUNT(*) n FROM managed_browser_sessions WHERE device_id=? AND local_profile_id=? AND status='open'", [devices[workspace].deviceId, profileId]);
    expect(Number(active.n)).toBe(1);
    const created = await old('/remote-sessions', { method: 'POST', auth: remoteToken, body: { browserSessionId: browser.body.id, deviceId: devices[workspace].deviceId, shopId } }); expect(created.status).toBe(201);
    expect((await old(`/remote-sessions/${created.body.id}/webrtc-ticket`, { method: 'POST', auth: remoteToken, body: {} })).status).toBe(201);
    expect((await old(`/remote-sessions/${created.body.id}/webrtc-ticket`, { method: 'POST', body: {} })).status).toBe(404);
    process.env.KUDESI_REMOTE_ASSIST_DISABLED = '1';
    expect((await old(`/remote-sessions/${created.body.id}/webrtc-ticket`, { method: 'POST', auth: remoteToken, body: {} })).status).toBe(403);
    await runtime.sweep();
    expect((await store.query('SELECT status FROM session_remote_sessions WHERE id=?', [created.body.id]))[0].status).toBe('closed');
    delete process.env.KUDESI_REMOTE_ASSIST_DISABLED;
  });

  it('撤销远程权限后精确截图租约只保留JPEG，不保留输入或WS控制，浏览器不被关闭', async () => {
    const ownerId = Number(jwt.decode(remoteToken).sub);
    await ds.manager.save(UserPermissionOverride, { userId: ownerId, permission: 'finance.docs.create', effect: 'allow' });
    const [ws] = await store.query('SELECT id FROM session_workspaces WHERE company_id=? AND workspace_key=?', [boss.companyId, workspace]);
    const [browser] = await store.query("SELECT id FROM managed_browser_sessions WHERE company_id=? AND workspace_id=? AND user_id=? AND device_id=? AND status='open' ORDER BY created_at DESC LIMIT 1",
      [boss.companyId, ws.id, ownerId, devices[workspace].deviceId]);
    expect(browser?.id).toBeTruthy();
    expect((await agent('/heartbeat', { agentVersion: '0.3.45', currentStep: 'idle', currentRequestId: null, activeBrowserSessionIds: [browser.id] })).status).toBe(200);
    const created = await old('/remote-sessions', { method: 'POST', auth: remoteToken, body: { browserSessionId: browser.id, deviceId: devices[workspace].deviceId, shopId } });
    expect(created.status).toBe(201);
    const sessionId = created.body.id;
    const issued = await old(`/remote-sessions/${sessionId}/webrtc-ticket`, { method: 'POST', auth: remoteToken, body: {} });
    expect(issued.status).toBe(201);
    expect((await old(`/remote-sessions/${sessionId}/jpeg-fallback`, { method: 'POST', auth: remoteToken, body: {} })).status).toBe(200);
    const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // Synthetic protocol bytes, not a real screenshot.
    // Original input endpoint correctly refuses a session until its first frame
    // changes requested -> connected. Establish that real protocol state first.
    expect((await agent('/remote', { action: 'frame', sessionId, pageUrl: 'https://mms.pinduoduo.com/home/', width: 1, height: 1, frame: frame.toString('base64') })).status).toBe(200);
    const capture = await old(`/oa-capture/${shopId}`, { method: 'POST', auth: remoteToken, body: {} });
    expect(capture.status).toBe(200);
    expect((await old(`/remote-sessions/${sessionId}/commands`, { method: 'POST', auth: remoteToken,
      body: { kind: 'click', point: { x: 0.25, y: 0.5 } } })).status).toBe(409); // JPEG is already read-only.
    // Seed persisted backlog to represent a late insert from an earlier control
    // request racing the transport switch. Do not bypass the HTTP guard in code.
    for (const status of ['queued', 'running']) await store.execute(
      'INSERT INTO session_remote_commands(session_id,kind,payload,status) VALUES(?,?,?,?)',
      [sessionId, 'click', JSON.stringify({ point: { x: 0.25, y: 0.5 } }), status]);
    const before = await store.query('SELECT status FROM session_remote_commands WHERE session_id=? ORDER BY id', [sessionId]);
    expect(before.map((row: any) => row.status)).toEqual(['queued', 'running']);
    await ds.manager.update(UserPermissionOverride, { userId: ownerId, permission: 'finance.session.remote' }, { effect: 'deny' });
    expect(await store.remoteAllowed(boss.companyId, Number(ws.id), devices[workspace].deviceId, ownerId)).toBe(false);
    expect(await store.captureAllowed(boss.companyId, Number(ws.id), devices[workspace].deviceId, ownerId, sessionId, capture.body.id)).toBe(true);
    await runtime.sweep();
    expect((await store.query('SELECT status FROM session_remote_sessions WHERE id=?', [sessionId]))[0].status).toMatch(/^(requested|connected)$/);
    const commands = await store.query('SELECT status FROM session_remote_commands WHERE session_id=? ORDER BY id', [sessionId]);
    expect(commands.map((row: any) => row.status)).toEqual(['failed', 'failed']);
    const claimed = await agent('/remote', undefined, 'GET');
    expect(claimed.status).toBe(200);
    expect(claimed.body.session.id).toBe(sessionId); expect(claimed.body.commands).toEqual([]);
    expect((await agent('/remote', { action: 'frame', sessionId, pageUrl: 'https://mms.pinduoduo.com/home/', width: 1, height: 1, frame: frame.toString('base64') })).status).toBe(200);
    expect((await old(`/remote-sessions/${sessionId}/webrtc-ticket`, { method: 'POST', auth: remoteToken, body: {} })).status).toBe(403);
    const replay = new WebSocket(base.replace(/^http/, 'ws') + issued.body.signalingPath); sockets.push(replay);
    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Revoked WebSocket authorization did not close')), 5000);
      replay.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    replay.once('open', () => replay.send(JSON.stringify({ type: 'authenticate', role: 'viewer', ticket: issued.body.ticket })));
    expect(await closed).toBe(1008);
    expect((await store.query('SELECT status FROM managed_browser_sessions WHERE id=?', [browser.id]))[0].status).toBe('open');
  }, 20000);

  it('真实HTTP制单员可截取管理员打开的闲置共享浏览器，不能接管或关闭该浏览器', async () => {
    const load = createRequire(path.resolve(__dirname, '../../../agent/legacy-runtime/index.js'));
    const publicKeyPem = load('./config.js').createDeviceKeyPair().publicKey;
    const paired = await old('/pairings', { method: 'POST', body: {} });
    const registration = await old('/agent/register', { method: 'POST', body: { pairingCode: paired.body.code,
      name: '共享截图合成电脑', hostname: 'synthetic-shared', platform: 'win32', arch: 'x64', agentVersion: '0.3.45', publicKeyPem } });
    expect(registration.status).toBe(201);
    const device = registration.body;
    const deviceCall = (p: string, body?: unknown, method = 'POST') => old(`/agent${p}`, { method, body, auth: device.deviceToken });
    expect((await deviceCall('/heartbeat', { agentVersion: '0.3.45', currentStep: 'idle', currentRequestId: null, activeBrowserSessionIds: [] })).status).toBe(200);
    const storeName = `共享截图合成店-${randomBytes(4).toString('hex')}`;
    await services.resources.create(boss, 'stores', { name: storeName, platform: 'pdd' });
    const candidates = await old('/shop-candidates');
    const candidate = candidates.body.shops.find((row: any) => row.name === storeName);
    expect(candidate?.id).toBeTruthy();
    expect((await old('/managed-shops', { method: 'POST', body: { storeIds: [candidate.id], assignedDeviceId: device.deviceId } })).status).toBe(201);
    const opened = await old('/open-requests', { method: 'POST', body: { storeId: candidate.id, deviceId: device.deviceId } });
    expect(opened.status).toBe(201);
    expect((await deviceCall('/open-requests', undefined, 'GET')).body.request.id).toBe(opened.body.id);
    const profile = randomUUID();
    expect((await deviceCall('/bindings', { storeId: String(candidate.id), localProfileId: profile, platformCode: 'pdd', loginStatus: 'pending' })).status).toBe(200);
    const browser = await deviceCall('/browser-sessions', { openRequestId: opened.body.id, storeId: String(candidate.id), localProfileId: profile,
      platformCode: 'pdd', pageUrl: 'https://mms.pinduoduo.com/home/' });
    expect(browser.status).toBe(201);
    expect((await deviceCall(`/open-requests/${opened.body.id}`, { status: 'completed', progress: 100, currentStep: 'completed' }, 'PATCH')).status).toBe(200);
    expect((await old(`/oa-remote/devices/${device.deviceId}`, { method: 'POST', body: { enabled: true, allowControl: true, maxMinutes: 10 } })).status).toBe(200);
    const clerk = await ds.manager.save(User, { companyId: boss.companyId, account: `clerk${randomBytes(6).toString('hex')}`, passwordHash: 'synthetic-only', name: '仅制单共享电脑用户', status: 'active', isCompanyAdmin: false, mustChangePassword: false });
    for (const permission of ['finance.doc-withdrawal.view', 'finance.docs.create']) await ds.manager.save(UserPermissionOverride, { userId: clerk.id, permission, effect: 'allow' });
    const clerkToken = jwt.sign({ sub: clerk.id, cid: clerk.companyId });
    expect((await old('/open-requests', { method: 'POST', auth: clerkToken, body: { storeId: candidate.id, deviceId: device.deviceId } })).status).toBe(403);
    // Occupied means unavailable, even if the clerk only wants a voucher image.
    const occupied = await old('/remote-sessions', { method: 'POST', body: { browserSessionId: browser.body.id, deviceId: device.deviceId, shopId: candidate.id } });
    expect(occupied.status).toBe(201);
    expect((await old(`/oa-capture/${candidate.id}`, { method: 'POST', auth: clerkToken, body: {} })).status).toBe(409);
    expect((await old(`/remote-sessions/${occupied.body.id}/end`, { method: 'POST', body: {} })).status).toBe(200);
    const begun = await old(`/oa-capture/${candidate.id}`, { method: 'POST', auth: clerkToken, body: {} });
    expect(begun.status).toBe(200);
    const [capture] = await ds.query('SELECT remote_session_id,owns_remote FROM sm_legacy_captures WHERE id=? AND company_id=? AND user_id=?', [begun.body.id, boss.companyId, clerk.id]);
    expect(Number(capture.owns_remote)).toBe(1);
    const [owned] = await store.query('SELECT user_id,browser_session_id,transport_mode FROM session_remote_sessions WHERE id=?', [capture.remote_session_id]);
    expect(Number(owned.user_id)).toBe(clerk.id); expect(owned.browser_session_id).toBe(browser.body.id); expect(owned.transport_mode).toBe('jpeg_fallback');
    // Even adding the normal remote permission cannot turn the capture lease
    // into control of somebody else's browser or expose a viewer ticket.
    await ds.manager.save(UserPermissionOverride, { userId: clerk.id, permission: 'finance.session.remote', effect: 'allow' });
    for (const endpoint of ['webrtc-ticket', 'end']) expect((await old(`/remote-sessions/${capture.remote_session_id}/${endpoint}`, { method: 'POST', auth: clerkToken, body: {} })).status).toBe(403);
    expect((await old(`/remote-sessions/${capture.remote_session_id}`, { method: 'DELETE', auth: clerkToken })).status).toBe(403);
    expect((await old(`/remote-sessions/${capture.remote_session_id}/commands`, { method: 'POST', auth: clerkToken, body: { kind: 'click', point: { x: 0.5, y: 0.5 } } })).status).toBe(403);
    const claimed = await deviceCall('/remote', undefined, 'GET');
    expect(claimed.body.session.id).toBe(capture.remote_session_id); expect(claimed.body.commands).toEqual([]);
    const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // Synthetic bytes, not merchant footage.
    expect((await deviceCall('/remote', { action: 'frame', sessionId: capture.remote_session_id, pageUrl: 'https://mms.pinduoduo.com/home/', width: 1, height: 1, frame: frame.toString('base64') })).status).toBe(200);
    await services.settings.saveQiniu(boss, { accessKey: 'synthetic-ak', secretKey: 'synthetic-sk', bucket: 'lab', zone: 'z2', domain: 'https://cdn.example.test', isPrivate: true });
    const result = await old(`/oa-requests/${begun.body.id}`, { auth: clerkToken });
    expect(result.status).toBe(200); expect(result.body.status).toBe('succeeded'); expect(result.body.file.id).toBeTruthy();
    const [preserved] = await store.query('SELECT user_id,status,local_profile_id FROM managed_browser_sessions WHERE id=?', [browser.body.id]);
    expect(Number(preserved.user_id)).toBe(boss.id); expect(preserved.status).toBe('open'); expect(preserved.local_profile_id).toBe(profile);
    expect((await store.query('SELECT status FROM session_remote_sessions WHERE id=?', [capture.remote_session_id]))[0].status).toBe('closed');
  }, 30000);
  async function closeFixture(ws: SessionWorkspace) {
    const load = createRequire(path.resolve(__dirname, '../../../agent/legacy-runtime/index.js'));
    const userCall = (p: string, options: Parameters<typeof old>[1] = {}) => old(p, { ...options, ws });
    const paired = await userCall('/pairings', { method: 'POST', body: {} });
    const registered = await userCall('/agent/register', { method: 'POST', body: { pairingCode: paired.body.code,
      name: '关闭协议合成电脑', hostname: 'synthetic-close', platform: 'win32', arch: 'x64', agentVersion: '0.3.45',
      publicKeyPem: load('./config.js').createDeviceKeyPair().publicKey } });
    expect(registered.status).toBe(201);
    const device = registered.body;
    const deviceCall = (p: string, body?: unknown, method = 'POST') => userCall(`/agent${p}`, { method, body, auth: device.deviceToken });
    expect((await deviceCall('/heartbeat', { agentVersion: '0.3.45', currentStep: 'idle', currentRequestId: null, activeBrowserSessionIds: [] })).status).toBe(200);
    const name = `关闭协议合成店-${randomBytes(5).toString('hex')}`;
    await services.resources.create(boss, 'stores', { name, platform: 'pdd' });
    const candidates = await userCall('/shop-candidates');
    const shop = candidates.body.shops.find((row: any) => row.name === name);
    expect(shop?.id).toBeTruthy();
    expect((await userCall('/managed-shops', { method: 'POST', body: { storeIds: [shop.id], assignedDeviceId: device.deviceId } })).status).toBe(201);
    const opened = await userCall('/open-requests', { method: 'POST', body: { storeId: shop.id, deviceId: device.deviceId } });
    expect(opened.status).toBe(201);
    expect((await deviceCall('/open-requests', undefined, 'GET')).body.request.id).toBe(opened.body.id);
    const profile = randomUUID();
    expect((await deviceCall('/bindings', { storeId: String(shop.id), localProfileId: profile, platformCode: 'pdd', loginStatus: 'pending' })).status).toBe(200);
    const browser = await deviceCall('/browser-sessions', { openRequestId: opened.body.id, storeId: String(shop.id), localProfileId: profile,
      platformCode: 'pdd', pageUrl: 'https://mms.pinduoduo.com/home/' });
    expect(browser.status).toBe(201);
    expect((await deviceCall(`/open-requests/${opened.body.id}`, { status: 'completed', progress: 100, currentStep: 'completed' }, 'PATCH')).status).toBe(200);
    expect((await userCall(`/oa-remote/devices/${device.deviceId}`, { method: 'POST', body: { enabled: true, allowControl: true, maxMinutes: 10 } })).status).toBe(200);
    const remote = await userCall('/remote-sessions', { method: 'POST', body: { browserSessionId: browser.body.id, deviceId: device.deviceId, shopId: shop.id } });
    expect(remote.status).toBe(201);
    return { userCall, deviceCall, device, browser: browser.body, shop, profile, id: remote.body.id,
      acknowledgement: { action: 'browser_closed', sessionId: remote.body.id, browserSessionId: browser.body.id, shopId: String(shop.id), localProfileId: profile } };
  }

  it.each((['finance_withdrawal', 'company_store_maintenance'] as SessionWorkspace[]).flatMap(ws =>
    ['stop-all', 'device-policy', 'sweep'].map(mode => ({ ws, mode }))))('$ws $mode仅停止媒体；仍可精确关闭并等设备确认', async ({ ws, mode }) => {
    const f = await closeFixture(ws);
    const previousDisabled = process.env.KUDESI_REMOTE_ASSIST_DISABLED;
    try {
      if (mode === 'stop-all') expect((await f.userCall('/oa-remote/stop-all', { method: 'POST', body: {} })).status).toBe(200);
      if (mode === 'device-policy') expect((await f.userCall(`/oa-remote/devices/${f.device.deviceId}`, { method: 'POST', body: { enabled: false } })).status).toBe(200);
      if (mode === 'sweep') { process.env.KUDESI_REMOTE_ASSIST_DISABLED = '1'; await runtime.sweep(); }
      const stopped = await f.userCall(`/remote-sessions/${f.id}`);
      expect(stopped.status).toBe(200); expect(stopped.body).toMatchObject({ status: 'closed', browserStatus: 'open' });
      expect((await f.userCall(`/remote-sessions/${f.id}/frame`)).status).toBe(403);
      expect((await f.userCall(`/remote-sessions/${f.id}/webrtc-ticket`, { method: 'POST', body: {} })).status).toBe(403);
      expect((await f.userCall(`/remote-sessions/${f.id}/commands`, { method: 'POST', body: { kind: 'click', point: { x: 0.5, y: 0.5 } } })).status).toBe(403);
      expect((await old(`/remote-sessions/${f.id}`, { ws: ws === 'finance_withdrawal' ? 'company_store_maintenance' : 'finance_withdrawal' })).status).toBe(404);
      const requested = await f.userCall(`/remote-sessions/${f.id}`, { method: 'DELETE' });
      expect(requested.status).toBe(200); expect(requested.body).toMatchObject({ status: 'closing', browserStatus: 'closing' });
      const jobs = await f.deviceCall('/remote?transport=webrtc', undefined, 'GET');
      expect(jobs.status).toBe(200); expect(jobs.body.sessions).toEqual([]);
      expect(jobs.body.closeJobs).toEqual(expect.arrayContaining([expect.objectContaining({ remoteSessionId: f.id, browserSessionId: f.browser.id, localProfileId: f.profile })]));
      expect((await f.deviceCall('/remote', { ...f.acknowledgement, localProfileId: randomUUID() })).status).toBe(403);
      expect((await f.userCall(`/remote-sessions/${f.id}`)).body.browserStatus).toBe('closing');
      expect((await f.deviceCall('/remote', f.acknowledgement)).body).toMatchObject({ status: 'ended', browserStatus: 'closed' });
      expect((await f.userCall(`/remote-sessions/${f.id}`)).body).toMatchObject({ status: 'ended', browserStatus: 'closed', closeStage: 'safe_closed' });
      expect((await store.query('SELECT status,local_profile_id FROM managed_browser_sessions WHERE id=?', [f.browser.id]))[0]).toMatchObject({ status: 'closed', local_profile_id: f.profile });
    } finally {
      if (previousDisabled === undefined) delete process.env.KUDESI_REMOTE_ASSIST_DISABLED; else process.env.KUDESI_REMOTE_ASSIST_DISABLED = previousDisabled;
    }
  }, 30000);

  it('历史ended/open必须重新关闭；超时不假成功，精确迟到确认才完成', async () => {
    const f = await closeFixture(workspace);
    await store.execute("UPDATE session_remote_sessions SET status='ended' WHERE id=?", [f.id]);
    expect((await f.userCall(`/remote-sessions/${f.id}`, { method: 'DELETE' })).body).toMatchObject({ status: 'closing', browserStatus: 'closing' });
    await store.execute('UPDATE session_remote_sessions SET close_requested_at=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 2 MINUTE) WHERE id=?', [f.id]);
    const timedOut = await f.userCall(`/remote-sessions/${f.id}`);
    expect(timedOut.status).toBe(200); expect(timedOut.body).toMatchObject({ status: 'error', closeStage: 'close_failed', browserStatus: 'closing' });
    expect((await f.deviceCall('/remote', f.acknowledgement)).body).toMatchObject({ status: 'ended', browserStatus: 'closed' });
  }, 30000);

  it('当前权限不足或设备关闭失败不能冒充成功，失败保留Profile并可重试', async () => {
    const f = await closeFixture(workspace);
    expect((await f.userCall(`/remote-sessions/${f.id}`, { method: 'DELETE', auth: viewer })).status).toBe(403);
    expect((await store.query('SELECT status FROM managed_browser_sessions WHERE id=?', [f.browser.id]))[0].status).toBe('open');
    expect((await f.userCall(`/remote-sessions/${f.id}`, { method: 'DELETE' })).body.status).toBe('closing');
    const failed = await f.deviceCall('/remote', { action: 'browser_close_failed', sessionId: f.id, error: 'synthetic: browser still open' });
    expect(failed.status).toBe(200); expect(failed.body).toMatchObject({ status: 'error', closeStage: 'close_failed' });
    expect((await f.userCall(`/remote-sessions/${f.id}`)).body).toMatchObject({ status: 'error', closeStage: 'close_failed', browserStatus: 'open' });
    // A delayed acknowledgement after explicit failure is insufficient while
    // the persisted browser is open; a new exact close request is required.
    expect((await f.deviceCall('/remote', f.acknowledgement)).status).toBe(409);
    expect((await store.query('SELECT status,local_profile_id FROM managed_browser_sessions WHERE id=?', [f.browser.id]))[0]).toMatchObject({ status: 'open', local_profile_id: f.profile });
    expect((await f.userCall(`/remote-sessions/${f.id}`, { method: 'DELETE' })).body).toMatchObject({ status: 'closing', browserStatus: 'closing' });
    expect((await f.deviceCall('/remote', f.acknowledgement)).body).toMatchObject({ status: 'ended', browserStatus: 'closed' });
  }, 30000);
});
