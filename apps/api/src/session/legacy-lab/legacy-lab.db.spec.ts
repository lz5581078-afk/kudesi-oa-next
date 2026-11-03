import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createConnection, Connection, RowDataPacket } from 'mysql2/promise';
import { Company, User, PlatformAdmin, PositionPermission, UserPermissionOverride } from '../../entities';
import { JwtAuthGuard } from '../../common/jwt-auth.guard';
import { PermissionsGuard } from '../../common/permissions.guard';
import { buildServices } from '../../test-support';
import { AuthUser } from '../../common/auth.decorators';
import { createLegacyLabHandler, LEGACY_LAB_HANDLER, LegacyLabController, LegacySql } from './lab-bridge';
import { setupLegacyLab } from './lab-fixture';

const lab = process.env.SESSION_LEGACY_LAB === '1' ? describe : describe.skip;
lab('旧店铺登录模块接入新版身份与资料（仅隔离本地样例）', () => {
  let ds: DataSource, connection: Connection, app: INestApplication, base: string;
  let services: ReturnType<typeof buildServices>, boss: AuthUser, foreign: AuthUser;
  let jwt: JwtService, token: string, viewerToken: string, financeOnlyToken: string;
  let storeId: number, legacyId = 101;
  let load: NodeRequire, agentApi: (config: any, url: string, init?: any) => Promise<any>;
  const devices: Record<string, any> = {};
  const temporaryDirs: string[] = [];
  const ws = { finance_withdrawal: 71, company_store_maintenance: 72 };

  const call = async (route: string, opts: { method?: string; body?: unknown; auth?: string; workspace?: keyof typeof ws } = {}) => {
    const response = await fetch(`${base}/api/session-manager${route}${route.includes('?') ? '&' : '?'}workspaceKey=${opts.workspace ?? 'company_store_maintenance'}`, {
      method: opts.method ?? 'GET', headers: { authorization: `Bearer ${opts.auth ?? token}`, 'content-type': 'application/json' },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    return { status: response.status, body: await response.json() as any, cache: response.headers.get('cache-control') };
  };

  beforeAll(async () => {
    if (!/^session_reuse_next_[a-z0-9_]+$/.test(process.env.DB_NAME ?? '') || !/^session_reuse_lab_[a-z0-9_]+$/.test(process.env.SESSION_LEGACY_DB ?? '') || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '3308') {
      throw new Error('Use run-local.cjs with fresh isolated local schemas');
    }
    load = createRequire(path.resolve(process.env.SESSION_LEGACY_SOURCE!, 'package.json'));
    agentApi = load('./agent/api.js').agentApi;
    const { buildDataSourceOptions, alignSessionTimeZone } = await import('../../database/data-source');
    ds = new DataSource({ ...buildDataSourceOptions(), migrationsRun: true });
    await ds.initialize(); await alignSessionTimeZone(ds);
    services = buildServices(ds);
    const makeCompany = async (label: string) => {
      const suffix = randomBytes(5).toString('hex');
      const c = await ds.manager.save(Company, { code: `lab${suffix}`, name: label, status: 'active' });
      const u = await ds.manager.save(User, { companyId: c.id, account: `lab${suffix}`, passwordHash: 'synthetic-no-login', name: '合成测试管理员', status: 'active', employmentType: 'regular', isCompanyAdmin: true, mustChangePassword: false });
      return { id: u.id, companyId: c.id, name: u.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser;
    };
    boss = await makeCompany('本地合成公司'); foreign = await makeCompany('另一合成公司');
    storeId = (await services.resources.create(boss, 'stores', { name: '新版合成店铺', platform: 'pdd', platformStoreId: 'LAB-ONLY-101' })).id;
    connection = await createConnection({ host: '127.0.0.1', port: 3308, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.SESSION_LEGACY_DB, timezone: '+08:00' });
    await connection.query("SET time_zone = '+08:00'");
    await setupLegacyLab(connection, process.env.DB_NAME!, process.env.SESSION_LEGACY_SOURCE!);
    await connection.execute('INSERT INTO legacy_lab_store_ids(legacy_store_id, record_id, company_id) VALUES (?, ?, ?)', [legacyId, storeId, boss.companyId]);
    for (const [key, id] of Object.entries(ws)) await connection.execute(
      'INSERT INTO session_workspaces(id,company_id,workspace_key,name,permission_key,status) VALUES(?,?,?,?,?,?)',
      [id, boss.companyId, key, key, key === 'finance_withdrawal' ? 'finance.session-manager.manage' : 'resources.company-store-maintenance.manage', 'active']);
    const sql: LegacySql = {
      query: async (text, params) => (await connection.query<RowDataPacket[]>(text, params))[0],
      execute: async (text, params) => (await connection.query(text, params))[0],
      withTransaction: async work => {
        await connection.beginTransaction();
        try { const result = await work(sql); await connection.commit(); return result; }
        catch (error) { await connection.rollback(); throw error; }
      },
    };
    const handler = createLegacyLabHandler(process.env.SESSION_LEGACY_SOURCE!, sql, services.crypto);
    const module = await Test.createTestingModule({ controllers: [LegacyLabController], providers: [{ provide: LEGACY_LAB_HANDLER, useValue: handler }] }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    jwt = new JwtService({ secret: randomBytes(48).toString('base64') });
    const reflector = new Reflector();
    app.useGlobalGuards(new JwtAuthGuard(reflector, jwt, ds.getRepository(User), ds.getRepository(PlatformAdmin), ds.getRepository(Company), ds.getRepository(PositionPermission), ds.getRepository(UserPermissionOverride)), new PermissionsGuard(reflector));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    token = jwt.sign({ sub: boss.id, cid: boss.companyId });
    const limited = async (permissions: string[]) => {
      const user = await ds.manager.save(User, { companyId: boss.companyId, account: `lab${randomBytes(5).toString('hex')}`, passwordHash: 'synthetic-no-login', name: '合成受限账号', status: 'active', employmentType: 'regular', isCompanyAdmin: false, mustChangePassword: false });
      for (const permission of permissions) await ds.manager.save(UserPermissionOverride, { userId: user.id, permission, effect: 'allow' });
      return jwt.sign({ sub: user.id, cid: boss.companyId });
    };
    viewerToken = await limited(['resource.company-store-maintenance.view']);
    financeOnlyToken = await limited(['finance.session.view', 'finance.session.manage']);
  }, 120_000);

  afterAll(async () => {
    await app?.close(); await connection?.end(); if (ds?.isInitialized) await ds.destroy();
    // Only remove test-created temporary agent directories, never user Profile paths.
    for (const dir of temporaryDirs) {
      if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('kudesi-legacy-lab-')) throw new Error('Unexpected temporary path');
      await fs.rm(dir, { recursive: true });
    }
  });

  it('真实新版JWT门禁拒绝假令牌、平台令牌、跨用途与伪造请求身份', async () => {
    expect((await call('/overview', { auth: 'invalid' })).status).toBe(401);
    expect((await call('/overview', { auth: jwt.sign({ sub: 1, typ: 'platform' }) })).status).toBe(403);
    expect((await call('/overview', { auth: financeOnlyToken })).status).toBe(403);
    expect((await call('/pairings', { method: 'POST', body: { companyId: foreign.companyId } })).status).toBe(400);
    expect((await call('/pairings', { method: 'POST', body: {}, auth: viewerToken })).status).toBe(403);
    expect((await call('/overview', { auth: jwt.sign({ sub: foreign.id, cid: foreign.companyId }) })).status).toBe(404);
  });

  it('原版注册程序直接通过新JWT创建的绑定码绑定，两用途设备独立且绑定码只用一次', async () => {
    for (const workspace of Object.keys(ws) as Array<keyof typeof ws>) {
      const pairing = await call('/pairings', { method: 'POST', body: {}, workspace });
      expect(pairing.status).toBe(201);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kudesi-legacy-lab-'));
      temporaryDirs.push(directory);
      const previous = process.env.SESSION_MANAGER_AGENT_DATA_DIR;
      process.env.SESSION_MANAGER_AGENT_DATA_DIR = directory;
      try {
        await load('./agent/register-device.js').registerDevice({ serverUrl: base, pairingCode: pairing.body.code, name: `合成-${workspace}` });
        devices[workspace] = await load('./agent/config.js').loadConfig();
        await expect(load('./agent/register-device.js').registerDevice({ serverUrl: base, pairingCode: pairing.body.code })).rejects.toThrow();
      } finally {
        if (previous === undefined) delete process.env.SESSION_MANAGER_AGENT_DATA_DIR; else process.env.SESSION_MANAGER_AGENT_DATA_DIR = previous;
      }
      await agentApi(devices[workspace], '/api/session-manager/agent/heartbeat', { method: 'POST', body: JSON.stringify({ agentVersion: '0.3.44' }) });
      const added = await call('/managed-shops', { method: 'POST', workspace, body: { storeIds: [legacyId], assignedDeviceId: devices[workspace].deviceId } });
      expect(added.status).toBe(201);
    }
    expect(devices.finance_withdrawal.deviceId).not.toBe(devices.company_store_maintenance.deviceId);
  }, 30_000);

  it('真实新版资料映射为旧店铺101，列表无密码且新版编辑立即可见', async () => {
    const before = await call('/overview', { auth: viewerToken });
    expect(before.status).toBe(200);
    expect(before.body.shops[0]).toMatchObject({ id: legacyId, name: '新版合成店铺' });
    expect(before.body.shops[0].password).toBeUndefined();
    await ds.query('UPDATE resource_records SET title = ? WHERE id = ? AND company_id = ?', ['新版更新后的合成店铺', storeId, boss.companyId]);
    const after = await call('/overview');
    expect(after.body.shops[0].name).toBe('新版更新后的合成店铺');
    expect((await call(`/shops/${legacyId}/credentials/reveal`, { method: 'POST', body: { purpose: 'view' }, auth: viewerToken })).status).toBe(403);
  });

  it('复用旧凭据服务，使用新版加密，两套账号隔离且空密码保留', async () => {
    for (const workspace of Object.keys(ws) as Array<keyof typeof ws>) {
      const saved = await call(`/managed-shops/${legacyId}/login-credentials`, { method: 'PATCH', workspace, body: { account: `${workspace}-account`, password: `${workspace}-synthetic-secret` } });
      expect(saved.status).toBe(200);
      const revealed = await call(`/shops/${legacyId}/credentials/reveal`, { method: 'POST', workspace, body: { purpose: 'view' } });
      expect(revealed.status).toBe(200); expect(revealed.cache).toBe('no-store');
      expect(revealed.body.credentials.password).toBe(`${workspace}-synthetic-secret`);
    }
    expect((await call(`/managed-shops/${legacyId}/login-credentials`, { method: 'PATCH', body: { account: 'maintenance-changed', password: '' } })).status).toBe(200);
    const [encrypted] = await connection.query<RowDataPacket[]>('SELECT withdrawal_login_password FROM session_managed_shops WHERE company_id = ? ORDER BY workspace_id', [boss.companyId]);
    expect(encrypted).toHaveLength(2);
    for (const row of encrypted) expect(row.withdrawal_login_password).toMatch(/^v1:k1:/);
    expect(services.crypto.decrypt(encrypted[1].withdrawal_login_password)).toBe('company_store_maintenance-synthetic-secret');
  });

  it('旧助手原HTTP客户端只领取本用途，取消后不能再完成且Profile继续按旧ID定位', async () => {
    for (const workspace of Object.keys(ws) as Array<keyof typeof ws>) {
      const opened = await call('/open-requests', { method: 'POST', workspace, body: { storeId: legacyId, deviceId: devices[workspace].deviceId } });
      expect(opened.status).toBe(201);
      const claimed = await agentApi(devices[workspace], '/api/session-manager/agent/open-requests');
      expect(claimed.request).toMatchObject({ store_id: legacyId, workspace_key: workspace, login_credentials: { password: `${workspace}-synthetic-secret` } });
      const wrong = workspace === 'finance_withdrawal' ? 'company_store_maintenance' : 'finance_withdrawal';
      expect((await agentApi(devices[wrong], '/api/session-manager/agent/open-requests')).request).toBeNull();
      expect((await call(`/open-requests/${opened.body.id}`, { workspace: wrong })).status).toBe(404);
      const state = { shops: {} };
      const config = load('./agent/config.js');
      const first = config.ensureShopProfile(state, legacyId, '合成店铺', 'pdd');
      expect(config.ensureShopProfile(state, legacyId, '合成店铺改名', 'pdd').localProfileId).toBe(first.localProfileId);
      await agentApi(devices[workspace], `/api/session-manager/agent/open-requests/${opened.body.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'waiting_human', progress: 70, currentStep: 'waiting_login' }) });
      expect((await call(`/open-requests/${opened.body.id}`, { workspace })).body.request.status).toBe('waiting_human');
      expect((await call(`/open-requests/${opened.body.id}`, { method: 'DELETE', workspace })).status).toBe(200);
      await expect(agentApi(devices[workspace], `/api/session-manager/agent/open-requests/${opened.body.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed', progress: 100 }) })).rejects.toThrow();
    }
  });

  it('有效证据才能标为已登录，成功回报可重放且终态不能退回；不访问真实平台', async () => {
    const workspace = 'finance_withdrawal' as const;
    const config = devices[workspace];
    const { request } = await (async () => {
      expect((await call('/open-requests', { method: 'POST', workspace, body: { storeId: legacyId, deviceId: config.deviceId } })).status).toBe(201);
      return agentApi(config, '/api/session-manager/agent/open-requests');
    })();
    const profile = load('./agent/config.js').ensureShopProfile({ shops: {} }, legacyId, '合成店铺', 'pdd');
    const binding = { storeId: legacyId, localProfileId: profile.localProfileId, platformCode: 'pdd', loginStatus: 'valid', verification: {
      method: 'platform_page_stable_v2', platformCode: 'pdd', url: 'https://mms.pinduoduo.com/home/', checkedAt: new Date().toISOString(), checks: 2, signals: ['synthetic-dashboard', 'synthetic-navigation'],
    } };
    // Evidence is synthetic input to the real old validator, not real login proof.
    await expect(agentApi(config, '/api/session-manager/agent/bindings', { method: 'POST', body: JSON.stringify({ ...binding, verification: { ...binding.verification, url: 'https://example.com/' } }) })).rejects.toThrow();
    await agentApi(config, '/api/session-manager/agent/bindings', { method: 'POST', body: JSON.stringify(binding) });
    const report = () => agentApi(config, `/api/session-manager/agent/open-requests/${request.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed', progress: 100 }) });
    expect(await report()).toMatchObject({ status: 'completed' });
    expect(await report()).toMatchObject({ unchanged: true });
    await expect(agentApi(config, `/api/session-manager/agent/open-requests/${request.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'running', progress: 70 }) })).rejects.toThrow();
    const overview = await call('/overview', { workspace });
    expect(overview.body.shops[0]).toMatchObject({ loginStatus: 'valid', localProfileId: profile.localProfileId });
    expect(overview.body.shops[0].lastOpenedAt).toBeTruthy();
  });

  it('原助手失败回报的敏感文本不进入请求或审计', async () => {
    const workspace = 'finance_withdrawal' as const, config = devices[workspace];
    await call('/open-requests', { method: 'POST', workspace, body: { storeId: legacyId, deviceId: config.deviceId } });
    const { request } = await agentApi(config, '/api/session-manager/agent/open-requests');
    await agentApi(config, `/api/session-manager/agent/open-requests/${request.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', progress: 100, currentStep: 'failed', errorCode: 'SyntheticSensitiveValue', errorMessage: 'finance_withdrawal-synthetic-secret' }) });
    const state = await call(`/open-requests/${request.id}`, { workspace });
    expect(state.body.request.status).toBe('failed');
    expect(JSON.stringify(state.body)).not.toContain('SyntheticSensitiveValue');
    expect(JSON.stringify(state.body)).not.toContain('synthetic-secret');
  });

  it('撤销只影响对应用途；旧状态写入与远程操作未接通时明确拒绝', async () => {
    expect((await call(`/devices/${devices.company_store_maintenance.deviceId}/revoke`, { method: 'PATCH', body: {} })).status).toBe(200);
    await expect(agentApi(devices.company_store_maintenance, '/api/session-manager/agent/open-requests')).rejects.toThrow();
    expect(await agentApi(devices.finance_withdrawal, '/api/session-manager/agent/heartbeat', { method: 'POST', body: JSON.stringify({}) })).toMatchObject({ authorized: true });
    expect((await call(`/shops/${legacyId}/archive-status`, { method: 'PATCH', body: { status: 'inactive' } })).status).toBe(404);
    expect((await call('/remote-sessions', { method: 'POST', body: {} })).status).toBe(404);
    const [logs] = await connection.query<RowDataPacket[]>('SELECT summary FROM session_audit_logs');
    expect(JSON.stringify(logs)).not.toContain('synthetic-secret');
  });
});
