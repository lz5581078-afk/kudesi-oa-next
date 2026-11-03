import 'reflect-metadata';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { Company, ResourceRecord, SessionDevice, SessionOpenRequest, SessionShop, User, UserPermissionOverride } from '../entities';
import { buildServices } from '../test-support';
import { LegacyStore } from './legacy-store';
import { LegacyAdoptionService, ensureLegacyStoreMappings, legacyAdoptionFingerprint } from './legacy-adoption';
import { LegacyCaptureService } from './legacy-capture.service';
import { LEGACY_NEW_STORE_BASE, newLegacyStoreId } from './legacy-identity';
import { LEGACY_VENDOR_ROOT, verifyLegacySnapshot } from './legacy-runtime/snapshot';

const db = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
db('旧登录模块资料迁入与真实帧凭证桥接（独立MySQL）', () => {
  let ds: DataSource, services: ReturnType<typeof buildServices>, store: LegacyStore;
  let adoption: LegacyAdoptionService, capture: LegacyCaptureService;
  let user: AuthUser, resourceId: number, nativeDevice: SessionDevice, shops: SessionShop[], legacyId: number;
  const mode = process.env.KUDESI_SESSION_ENGINE;
  const killed = process.env.KUDESI_REMOTE_ASSIST_DISABLED;

  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '') || !/^(?:session_reuse_next_|kudesi_oa_test)/.test(process.env.TEST_DB_NAME ?? process.env.DB_NAME ?? '')) throw new Error('Requires an isolated loopback test database');
    const { buildDataSourceOptions, alignSessionTimeZone } = await import('../database/data-source');
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? process.env.DB_NAME }), migrationsRun: true });
    await ds.initialize(); await alignSessionTimeZone(ds);
    services = buildServices(ds); store = new LegacyStore(ds, services.crypto);
    adoption = new LegacyAdoptionService(store); capture = new LegacyCaptureService(store, services.files);
    process.env.KUDESI_SESSION_ENGINE = 'legacy';
  }, 120000);
  afterAll(async () => { if (mode === undefined) delete process.env.KUDESI_SESSION_ENGINE; else process.env.KUDESI_SESSION_ENGINE = mode; if (killed === undefined) delete process.env.KUDESI_REMOTE_ASSIST_DISABLED; else process.env.KUDESI_REMOTE_ASSIST_DISABLED = killed; if (ds?.isInitialized) await ds.destroy(); });
  beforeEach(async () => {
    services.storage.objects.clear(); services.storage.removed.length = 0; services.storage.failUpload = false;
    process.env.KUDESI_REMOTE_ASSIST_DISABLED = '0';
    const suffix = randomBytes(6).toString('hex');
    const company = await ds.manager.save(Company, { code: `ops${suffix}`, name: '隔离操作回归公司', status: 'active' });
    const actor = await ds.manager.save(User, { companyId: company.id, account: `ops${suffix}`, passwordHash: 'synthetic-only', name: '合成管理员', status: 'active', isCompanyAdmin: true, mustChangePassword: false });
    user = { id: actor.id, companyId: company.id, name: actor.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    await services.settings.saveQiniu(user, { accessKey: 'synthetic-ak', secretKey: 'synthetic-sk', bucket: 'lab', zone: 'z2', domain: 'https://cdn.example.com', isPrivate: true });
    resourceId = (await services.resources.create(user, 'stores', { name: '迁入合成店', platform: 'pdd', platformStoreId: 'SYNTHETIC-ONLY' })).id;
    legacyId = randomInt(100_000_000, 900_000_000);
    await ds.query("INSERT INTO legacy_import_links (source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES ('legacy-oa',999,?,?,'stores',?,'synthetic')", [company.id, `stores:${legacyId}`, resourceId]);
    nativeDevice = await ds.manager.save(SessionDevice, { companyId: company.id, deviceNo: randomBytes(6).toString('hex'), name: '合成负责电脑', remark: '保留备注', agentVersion: '1.2.1', tokenHash: randomBytes(32).toString('hex'), status: 'active', lastSeenAt: new Date() });
    shops = [];
    for (const workspace of ['finance_withdrawal', 'company_store_maintenance']) shops.push(await ds.manager.save(SessionShop, {
      companyId: company.id, workspace, storeId: resourceId, deviceId: nativeDevice.id, loginAccount: `${workspace}-account`,
      loginPasswordEnc: services.crypto.encrypt(`${workspace}-synthetic-secret`), autoLogin: true, loginState: 'valid', status: 'active',
    }));
  });

  const adopt = async () => {
    const p = await adoption.preview(user);
    expect(p.blockers).toEqual([]);
    return adoption.adopt(user, p.sourceHash, `company:${user.companyId}:both-session-workspaces`);
  };
  const countTarget = async () => Number((await ds.query('SELECT COUNT(*) n FROM sm_legacy_session_managed_shops WHERE company_id=?', [user.companyId]))[0].n);

  it('预览不写入，精确旧ID/双用途凭据迁入；设备均撤销且原native记录不改', async () => {
    const p = await adoption.preview(user);
    expect(p).toMatchObject({ alreadyApplied: false, shops: 2, devicesPerWorkspace: 1, preservedLegacyStoreIds: 1 });
    expect(await countTarget()).toBe(0);
    await expect(adoption.adopt(user, '0'.repeat(64), `company:${user.companyId}:both-session-workspaces`)).rejects.toThrow(/变化/);
    const result = await adopt(); expect(result.alreadyApplied).toBe(true);
    const [mapping] = await ds.query('SELECT id FROM sm_legacy_store_ids WHERE company_id=? AND record_id=?', [user.companyId, resourceId]);
    expect(Number(mapping.id)).toBe(legacyId);
    const target = await store.query('SELECT workspace_id,withdrawal_login_account,withdrawal_login_password FROM session_managed_shops WHERE company_id=? ORDER BY workspace_id', [user.companyId]);
    expect(target).toHaveLength(2);
    expect(target.map(r => services.crypto.decrypt(r.withdrawal_login_password)).sort()).toEqual(['company_store_maintenance-synthetic-secret', 'finance_withdrawal-synthetic-secret']);
    const devices = await store.query('SELECT status,last_seen_at,token_hash FROM session_devices WHERE company_id=?', [user.companyId]);
    expect(devices).toHaveLength(2); expect(devices.every(d => d.status === 'revoked' && d.last_seen_at === null && d.token_hash !== nativeDevice.tokenHash)).toBe(true);
    expect(await ds.manager.count(SessionShop, { where: { companyId: user.companyId } })).toBe(2);
    expect((await ds.manager.findOneByOrFail(SessionDevice, { id: nativeDevice.id })).status).toBe('active');
  });

  it('无旧账本使用显式高段编号，原助手不会命中已保留的低编号Profile', async () => {
    await ds.query("DELETE FROM legacy_import_links WHERE company_id=? AND target_type='stores' AND target_id=?", [user.companyId, resourceId]);
    const p = await adoption.preview(user);
    expect(p.preservedLegacyStoreIds).toBe(0);
    expect(p.warnings.join('')).toMatch(/核实旧来源店铺ID最大值/);
    await adoption.adopt(user, p.sourceHash, `company:${user.companyId}:both-session-workspaces`);
    const [mapping] = await ds.query('SELECT id FROM sm_legacy_store_ids WHERE company_id=? AND record_id=?', [user.companyId, resourceId]);
    expect(Number(mapping.id)).toBe(newLegacyStoreId(resourceId)); expect(Number(mapping.id)).toBeGreaterThan(LEGACY_NEW_STORE_BASE);
    verifyLegacySnapshot();
    const { ensureShopProfile } = require(path.join(LEGACY_VENDOR_ROOT, 'agent/config.js'));
    const oldProfile = randomUUID(), state = { shops: { '1': { storeId: '1', storeName: '旧保留店铺', platformCode: 'pdd', localProfileId: oldProfile } } };
    expect(ensureShopProfile(state, 1, '旧保留店铺', 'pdd').localProfileId).toBe(oldProfile);
    expect(ensureShopProfile(state, Number(mapping.id), '新建店铺', 'pdd').localProfileId).not.toBe(oldProfile);
    expect(state.shops['1'].localProfileId).toBe(oldProfile);
  });

  it.each([LEGACY_NEW_STORE_BASE, Number.MAX_SAFE_INTEGER + 1, 0])('旧账本编号 %s 不安全或进入保留段时阻止迁入', async invalidId => {
    await ds.query("UPDATE legacy_import_links SET source_key=? WHERE company_id=? AND target_type='stores' AND target_id=?", [`stores:${invalidId}`, user.companyId, resourceId]);
    const p = await adoption.preview(user);
    expect(p.blockers.join('')).toMatch(/正安全整数或进入新编号保留段/);
    await expect(adoption.adopt(user, p.sourceHash, `company:${user.companyId}:both-session-workspaces`)).rejects.toThrow(/正安全整数或进入新编号保留段/);
    expect(await countTarget()).toBe(0);
  });

  it('候选资料共用映射助手：清单外旧账本保留准确ID，新资料用高段；重复和歧义不覆盖', async () => {
    const linked = (await services.resources.create(user, 'stores', { name: '未加入清单的旧店', platform: 'pdd' })).id;
    const fresh = (await services.resources.create(user, 'stores', { name: '未加入清单的新店', platform: 'pdd' })).id;
    await ds.query("INSERT INTO legacy_import_links (source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES ('legacy-oa',999,?,?,'stores',?,'synthetic')", [user.companyId, `stores:${legacyId + 1}`, linked]);
    const mappings = await ds.transaction(em => ensureLegacyStoreMappings(em, user.companyId, [linked, fresh]));
    expect(mappings.get(linked)).toBe(legacyId + 1); expect(mappings.get(fresh)).toBe(newLegacyStoreId(fresh));
    expect(await ds.transaction(em => ensureLegacyStoreMappings(em, user.companyId, [linked, fresh]))).toEqual(mappings);
    expect(await ds.manager.count(SessionShop, { where: { companyId: user.companyId } })).toBe(2);
    await ds.query("INSERT INTO legacy_import_links (source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES ('legacy-oa',998,?,?,'stores',?,'synthetic')", [user.companyId, `stores:${legacyId + 2}`, linked]);
    await expect(ds.transaction(em => ensureLegacyStoreMappings(em, user.companyId, [linked]))).rejects.toThrow(/来源不唯一/);
    expect(Number((await ds.query('SELECT id FROM sm_legacy_store_ids WHERE company_id=? AND record_id=?', [user.companyId, linked]))[0].id)).toBe(legacyId + 1);
  });

  it('拒绝旧预览、进行中任务/升级；失败事务不留下半批迁入', async () => {
    const p = await adoption.preview(user);
    await ds.manager.update(SessionShop, shops[0].id, { loginAccount: 'new-manual-edit' });
    await expect(adoption.adopt(user, p.sourceHash, `company:${user.companyId}:both-session-workspaces`)).rejects.toThrow(/变化/);
    const request = await ds.manager.save(SessionOpenRequest, { companyId: user.companyId, shopId: shops[0].id, deviceId: nativeDevice.id, kind: 'first', status: 'pending', requestedBy: user.id });
    expect((await adoption.preview(user)).blockers.join('')).toMatch(/进行中/);
    await ds.manager.update(SessionOpenRequest, request.id, { status: 'cancelled' });
    await ds.manager.update(SessionDevice, nativeDevice.id, { updateStatus: 'queued' });
    expect((await adoption.preview(user)).blockers.join('')).toMatch(/升级/);
    await ds.manager.update(SessionDevice, nativeDevice.id, { updateStatus: null });
    const fresh = await adoption.preview(user);
    const transaction = ds.transaction.bind(ds);
    const spy = jest.spyOn(ds, 'transaction').mockImplementationOnce((async (...args: any[]) => transaction('SERIALIZABLE', async em => {
      const query = em.query.bind(em);
      jest.spyOn(em, 'query').mockImplementation((async (sql: string, params?: any[]) => {
        if (sql.startsWith('INSERT INTO sm_legacy_company_adoptions')) throw new Error('synthetic-commit-failure');
        return query(sql, params);
      }) as any);
      return args[args.length - 1](em);
    })) as any);
    await expect(adoption.adopt(user, fresh.sourceHash, `company:${user.companyId}:both-session-workspaces`)).rejects.toThrow('synthetic-commit-failure');
    spy.mockRestore();
    expect(await countTarget()).toBe(0);
    expect(Number((await ds.query('SELECT COUNT(*) n FROM sm_legacy_store_ids WHERE company_id=?', [user.companyId]))[0].n)).toBe(0);
    expect(Number((await ds.query('SELECT COUNT(*) n FROM sm_legacy_company_adoptions WHERE company_id=?', [user.companyId]))[0].n)).toBe(0);
  });

  it('复跑保留迁入后的编辑，来源摘要忽略心跳/主资料变化但检测native凭据变化', async () => {
    const p = await adopt();
    await store.execute("UPDATE session_managed_shops SET withdrawal_login_account='legacy-manual-edit' WHERE company_id=?", [user.companyId]);
    await adoption.adopt(user, p.sourceHash, `company:${user.companyId}:both-session-workspaces`);
    expect((await store.query('SELECT withdrawal_login_account FROM session_managed_shops WHERE company_id=?', [user.companyId])).every(r => r.withdrawal_login_account === 'legacy-manual-edit')).toBe(true);
    expect((await store.query('SELECT id FROM session_devices WHERE company_id=?', [user.companyId]))).toHaveLength(2);
    await ds.manager.update(SessionDevice, nativeDevice.id, { lastSeenAt: new Date(Date.now() + 1000) });
    await ds.manager.update(ResourceRecord, resourceId, { title: '资料可继续维护' });
    expect(await legacyAdoptionFingerprint(ds, user.companyId, user.id)).toBe(p.sourceHash);
    await ds.manager.update(SessionShop, shops[0].id, { loginAccount: 'native-after-adoption' });
    expect(await legacyAdoptionFingerprint(ds, user.companyId, user.id)).not.toBe(p.sourceHash);
  });

  const browserFixture = async (owner: AuthUser = user) => {
    await adopt();
    const [workspace] = await store.query("SELECT id FROM session_workspaces WHERE company_id=? AND workspace_key='finance_withdrawal'", [user.companyId]);
    const [deviceRow] = await store.query('SELECT id FROM session_devices WHERE company_id=? AND workspace_id=?', [user.companyId, workspace.id]);
    const device = { id: deviceRow.id, companyId: user.companyId, workspaceId: Number(workspace.id), agentVersion: '0.3.45' };
    await store.execute("UPDATE session_devices SET status='active',last_seen_at=CURRENT_TIMESTAMP,agent_version='0.3.45' WHERE id=? AND company_id=?", [device.id, user.companyId]);
    await ds.query('INSERT INTO sm_legacy_remote_policies (company_id,workspace_id,device_id,enabled,allow_control,max_minutes) VALUES (?,?,?,1,1,10)', [user.companyId, workspace.id, device.id]);
    const opening = store.module('open-request-service');
    const request = await opening.createOpenRequest({ companyId: user.companyId, workspaceId: workspace.id, employeeId: owner.id, storeId: legacyId, deviceId: device.id, withTransaction: store.withTransaction });
    await opening.claimNextOpenRequest({ device, withTransaction: store.withTransaction });
    const profileId = randomUUID();
    await store.module('session-service').reportBinding({ device, binding: { storeId: legacyId, localProfileId: profileId, loginStatus: 'pending', platformCode: 'pdd' }, query: store.query, execute: store.execute });
    const browser = await store.module('managed-browser-session-service').createManagedBrowserSession({ device, openRequestId: request.id, storeId: legacyId, localProfileId: profileId, platformCode: 'pdd', pageUrl: 'https://mms.pinduoduo.com/home/', withTransaction: store.withTransaction });
    return { workspaceId: Number(workspace.id), device, browser };
  };
  const sendFrame = async (device: any, sessionId: string) => store.module('remote-assistance-service').uploadRemoteFrame({ device, sessionId, pageUrl: 'https://mms.pinduoduo.com/home/', width: 100, height: 100,
    frameBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'), query: store.query, execute: store.execute });

  it('仅原有提现创建权限、没有remote权限的真实非管理员可截取本人店铺凭证', async () => {
    const viewer = await ds.manager.save(User, { companyId: user.companyId, account: `capture${randomBytes(6).toString('hex')}`, passwordHash: 'synthetic-only', name: '仅提现制单员', status: 'active', isCompanyAdmin: false, mustChangePassword: false });
    const allow = ['finance.doc-withdrawal.view', 'finance.docs.create'];
    for (const permission of allow) await ds.manager.save(UserPermissionOverride, { userId: viewer.id, permission, effect: 'allow' });
    const limited: AuthUser = { id: viewer.id, companyId: user.companyId, name: viewer.name, permissions: { isCompanyAdmin: false, allow, deny: [] } };
    const { device } = await browserFixture(limited);
    const actualOwner = await store.sessionOwner(user.companyId, limited.id);
    expect(actualOwner?.permissions.isCompanyAdmin).toBe(false);
    expect(actualOwner?.permissions.allow).not.toContain('finance.session.remote');
    expect(() => store.require(limited, 'finance_withdrawal', 'remote')).toThrow(/权限/);
    const begin = await capture.begin(limited, 'finance_withdrawal', legacyId);
    const [request] = await ds.query('SELECT remote_session_id FROM sm_legacy_captures WHERE id=? AND company_id=? AND user_id=?', [begin.id, user.companyId, limited.id]);
    const [workspace] = await store.query("SELECT id FROM session_workspaces WHERE company_id=? AND workspace_key='finance_withdrawal'", [user.companyId]);
    expect(await store.remoteAllowed(user.companyId, Number(workspace.id), device.id, limited.id)).toBe(false);
    expect(await store.captureAllowed(user.companyId, Number(workspace.id), device.id, limited.id, request.remote_session_id, begin.id)).toBe(true);
    expect(await store.captureAllowed(user.companyId, Number(workspace.id), device.id, limited.id, randomUUID(), begin.id)).toBe(false);
    expect(await store.captureAllowed(user.companyId, Number(workspace.id), device.id, limited.id, request.remote_session_id, randomUUID())).toBe(false);
    await sendFrame(device, request.remote_session_id);
    const result = await capture.get(limited, 'finance_withdrawal', begin.id);
    expect(result.status).toBe('succeeded'); expect(result.file?.id).toBeTruthy();
    expect(() => store.require(limited, 'finance_withdrawal', 'remote')).toThrow(/权限/);
    expect(await store.remoteAllowed(user.companyId, Number(workspace.id), device.id, limited.id)).toBe(false);
    expect((await store.query('SELECT status FROM session_remote_sessions WHERE id=? AND company_id=?', [request.remote_session_id, user.companyId]))[0].status).toBe('closed');
  });

  it('新帧落真实凭证，两个并发轮询只上传一次，结束临时远程但保留浏览器', async () => {
    const { device, browser } = await browserFixture();
    const begin = await capture.begin(user, 'finance_withdrawal', legacyId);
    expect(await capture.begin(user, 'finance_withdrawal', legacyId)).toEqual(begin);
    const [request] = await ds.query('SELECT remote_session_id FROM sm_legacy_captures WHERE id=? AND company_id=?', [begin.id, user.companyId]);
    expect((await capture.get(user, 'finance_withdrawal', begin.id)).status).toBe('pending');
    await sendFrame(device, request.remote_session_id);
    const results = await Promise.all([capture.get(user, 'finance_withdrawal', begin.id), capture.get(user, 'finance_withdrawal', begin.id)]);
    expect(results[0].status).toBe('succeeded'); expect(results[0].file?.id).toBe(results[1].file?.id); expect(services.storage.objects.size).toBe(1);
    expect((await store.query('SELECT status FROM session_remote_sessions WHERE id=? AND company_id=?', [request.remote_session_id, user.companyId]))[0].status).toBe('closed');
    expect((await store.query('SELECT status FROM managed_browser_sessions WHERE id=? AND company_id=?', [browser.id, user.companyId]))[0].status).toBe('open');
  });

  it('仅制单权限可截取管理员打开的闲置浏览器，临时会话归制单员但浏览器所有者不变', async () => {
    const clerk = await ds.manager.save(User, { companyId: user.companyId, account: `shared${randomBytes(6).toString('hex')}`, passwordHash: 'synthetic-only', name: '共享电脑制单员', status: 'active', isCompanyAdmin: false, mustChangePassword: false });
    const allow = ['finance.doc-withdrawal.view', 'finance.docs.create'];
    for (const permission of allow) await ds.manager.save(UserPermissionOverride, { userId: clerk.id, permission, effect: 'allow' });
    const limited: AuthUser = { id: clerk.id, companyId: user.companyId, name: clerk.name, permissions: { isCompanyAdmin: false, allow, deny: [] } };
    const { device, browser, workspaceId } = await browserFixture();
    const begin = await capture.begin(limited, 'finance_withdrawal', legacyId);
    const [request] = await ds.query('SELECT remote_session_id,owns_remote FROM sm_legacy_captures WHERE id=? AND company_id=? AND user_id=?', [begin.id, user.companyId, clerk.id]);
    expect(Number(request.owns_remote)).toBe(1);
    const [session] = await store.query('SELECT user_id,browser_session_id,transport_mode,expires_at FROM session_remote_sessions WHERE id=?', [request.remote_session_id]);
    expect(Number(session.user_id)).toBe(clerk.id); expect(session.browser_session_id).toBe(browser.id); expect(session.transport_mode).toBe('jpeg_fallback');
    expect(new Date(session.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(30_000);
    expect(await store.remoteAllowed(user.companyId, workspaceId, device.id, clerk.id)).toBe(false);
    await sendFrame(device, request.remote_session_id);
    const result = await capture.get(limited, 'finance_withdrawal', begin.id);
    expect(result.status).toBe('succeeded'); expect(result.file?.id).toBeTruthy();
    const [preserved] = await store.query('SELECT user_id,status FROM managed_browser_sessions WHERE id=?', [browser.id]);
    expect(Number(preserved.user_id)).toBe(user.id); expect(preserved.status).toBe('open');
    expect((await store.query('SELECT status FROM session_remote_sessions WHERE id=?', [request.remote_session_id]))[0].status).toBe('closed');
  });

  it('共享截图拒绝已被管理员远程占用或已离开平台的浏览器，不改变原会话', async () => {
    const clerk = await ds.manager.save(User, { companyId: user.companyId, account: `busy${randomBytes(6).toString('hex')}`, passwordHash: 'synthetic-only', name: '制单员', status: 'active', isCompanyAdmin: false, mustChangePassword: false });
    const allow = ['finance.doc-withdrawal.view', 'finance.docs.create'];
    for (const permission of allow) await ds.manager.save(UserPermissionOverride, { userId: clerk.id, permission, effect: 'allow' });
    const limited: AuthUser = { id: clerk.id, companyId: user.companyId, name: clerk.name, permissions: { isCompanyAdmin: false, allow, deny: [] } };
    const { device, browser, workspaceId } = await browserFixture();
    const remote = store.module('remote-assistance-service');
    const session = await remote.createRemoteSession({ companyId: user.companyId, workspaceId, userId: user.id, browserSessionId: browser.id, deviceId: device.id, shopId: legacyId, withTransaction: store.withTransaction });
    await expect(capture.begin(limited, 'finance_withdrawal', legacyId)).rejects.toThrow(/已有远程/);
    expect(Number((await store.query('SELECT user_id FROM session_remote_sessions WHERE id=?', [session.id]))[0].user_id)).toBe(user.id);
    await remote.closeRemoteSession({ companyId: user.companyId, workspaceId, userId: user.id, sessionId: session.id, withTransaction: store.withTransaction });
    await store.execute('UPDATE managed_browser_sessions SET page_url=? WHERE id=?', ['https://example.com/', browser.id]);
    await expect(capture.begin(limited, 'finance_withdrawal', legacyId)).rejects.toThrow(/平台允许/);
    expect(Number((await ds.query('SELECT COUNT(*) n FROM sm_legacy_captures WHERE company_id=?', [user.companyId]))[0].n)).toBe(0);
  });

  it('上传后授权复核使用截图同一事务queryRunner，不再向连接池借第二条连接', async () => {
    const { device } = await browserFixture();
    const begin = await capture.begin(user, 'finance_withdrawal', legacyId);
    const [request] = await ds.query('SELECT remote_session_id FROM sm_legacy_captures WHERE id=? AND company_id=?', [begin.id, user.companyId]);
    await sendFrame(device, request.remote_session_id);
    const putBlob = services.files.putBlob.bind(services.files), authorize = store.captureAllowed.bind(store);
    let uploadRunner: unknown, authorizationRunner: unknown, active = false, extraRunners = 0;
    const uploadSpy = jest.spyOn(services.files, 'putBlob').mockImplementationOnce(async (...args) => {
      uploadRunner = args[5]?.queryRunner;
      return putBlob(...args);
    });
    const authorizationSpy = jest.spyOn(store, 'captureAllowed').mockImplementationOnce(async (...args) => {
      authorizationRunner = args[6]?.queryRunner;
      active = !!args[6]?.queryRunner?.isTransactionActive;
      const createRunner = ds.createQueryRunner.bind(ds);
      const runnerSpy = jest.spyOn(ds, 'createQueryRunner').mockImplementation((...runnerArgs) => {
        extraRunners++; return createRunner(...runnerArgs);
      });
      try { return await authorize(...args); } finally { runnerSpy.mockRestore(); }
    });
    try {
      const result = await capture.get(user, 'finance_withdrawal', begin.id);
      expect(result.status).toBe('succeeded');
      expect(authorizationSpy).toHaveBeenCalledTimes(1);
      expect(uploadRunner).toBeTruthy(); expect(authorizationRunner).toBe(uploadRunner);
      expect(active).toBe(true); expect(extraRunners).toBe(0);
    } finally { uploadSpy.mockRestore(); authorizationSpy.mockRestore(); }
  });

  it('不采用旧帧，不关闭复用的本人JPEG远程；跨人和维护工作区不能取凭证', async () => {
    const { device, browser, workspaceId } = await browserFixture();
    const remote = store.module('remote-assistance-service');
    const session = await remote.createRemoteSession({ companyId: user.companyId, workspaceId, userId: user.id, browserSessionId: browser.id, deviceId: device.id, shopId: legacyId, withTransaction: store.withTransaction });
    await remote.requestJpegFallback({ companyId: user.companyId, workspaceId, userId: user.id, sessionId: session.id, withTransaction: store.withTransaction });
    await sendFrame(device, session.id);
    const begin = await capture.begin(user, 'finance_withdrawal', legacyId);
    expect((await capture.get(user, 'finance_withdrawal', begin.id)).status).toBe('pending');
    await expect(capture.get({ ...user, id: user.id + 100000 }, 'finance_withdrawal', begin.id)).rejects.toThrow(/不存在/);
    await expect(capture.get(user, 'company_store_maintenance', begin.id)).rejects.toThrow(/不提供/);
    await sendFrame(device, session.id);
    expect((await capture.get(user, 'finance_withdrawal', begin.id)).status).toBe('succeeded');
    expect((await store.query('SELECT status FROM session_remote_sessions WHERE id=? AND company_id=?', [session.id, user.companyId]))[0].status).toBe('connected');
  });

  it('过期请求终止临时远程，上传失败不伪装成功或反复上传', async () => {
    const { device } = await browserFixture();
    const expired = await capture.begin(user, 'finance_withdrawal', legacyId);
    await ds.query('UPDATE sm_legacy_captures SET created_at=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 2 MINUTE) WHERE id=? AND company_id=?', [expired.id, user.companyId]);
    expect((await capture.get(user, 'finance_withdrawal', expired.id)).status).toBe('failed');
    const retry = await capture.begin(user, 'finance_withdrawal', legacyId);
    const [r] = await ds.query('SELECT remote_session_id FROM sm_legacy_captures WHERE id=? AND company_id=?', [retry.id, user.companyId]);
    await sendFrame(device, r.remote_session_id); services.storage.failUpload = true;
    expect((await capture.get(user, 'finance_withdrawal', retry.id)).status).toBe('failed');
    services.storage.failUpload = false;
    expect((await capture.get(user, 'finance_withdrawal', retry.id)).file).toBeNull();
    expect(services.storage.objects.size).toBe(0);
  });

  it('对象已上传而数据库落库失败时，补偿清除对象并将请求标失败', async () => {
    const { device } = await browserFixture();
    const begin = await capture.begin(user, 'finance_withdrawal', legacyId);
    const [r] = await ds.query('SELECT remote_session_id FROM sm_legacy_captures WHERE id=? AND company_id=?', [begin.id, user.companyId]);
    await sendFrame(device, r.remote_session_id);
    const transaction = ds.transaction.bind(ds);
    let injected = 0;
    const spy = jest.spyOn(ds, 'transaction').mockImplementation((async (...args: any[]) => {
      const work = async (em: any) => {
      const query = em.query.bind(em);
      jest.spyOn(em, 'query').mockImplementation((async (sql: string, params?: any[]) => {
        if (sql.startsWith("UPDATE sm_legacy_captures SET status='succeeded'")) { injected++; throw new Error('synthetic-after-upload-failure'); }
        return query(sql, params);
      }) as any);
      return args[args.length - 1](em);
      };
      return typeof args[0] === 'string' ? transaction(args[0] as any, work) : transaction(work);
    }) as any);
    const result = await capture.get(user, 'finance_withdrawal', begin.id);
    spy.mockRestore();
    expect(injected).toBe(1);
    expect(result.status).toBe('failed'); expect(result.file).toBeNull();
    expect(services.storage.objects.size).toBe(0);
    expect(services.storage.removed.length).toBeGreaterThan(0);
    expect(Number((await ds.query("SELECT COUNT(*) n FROM resource_files WHERE company_id=? AND resource_type='withdrawal-voucher'", [user.companyId]))[0].n)).toBe(0);
  });

  it('全局停止后拒绝新截图，进行中请求转失败并仅结束临时远程', async () => {
    const { browser } = await browserFixture();
    const begin = await capture.begin(user, 'finance_withdrawal', legacyId);
    const [request] = await ds.query('SELECT remote_session_id FROM sm_legacy_captures WHERE id=? AND company_id=?', [begin.id, user.companyId]);
    process.env.KUDESI_REMOTE_ASSIST_DISABLED = '1';
    await expect(capture.begin(user, 'finance_withdrawal', legacyId)).rejects.toThrow(/关闭/);
    expect((await capture.get(user, 'finance_withdrawal', begin.id)).status).toBe('failed');
    expect((await store.query('SELECT status FROM session_remote_sessions WHERE id=? AND company_id=?', [request.remote_session_id, user.companyId]))[0].status).toBe('closed');
    expect((await store.query('SELECT status FROM managed_browser_sessions WHERE id=? AND company_id=?', [browser.id, user.companyId]))[0].status).toBe('open');
    expect(services.storage.objects.size).toBe(0);
  });

  it('数据库已提交但确认丢失时，回读成功记录而不误删已引用凭证', async () => {
    const { device } = await browserFixture();
    const begin = await capture.begin(user, 'finance_withdrawal', legacyId);
    const [r] = await ds.query('SELECT remote_session_id FROM sm_legacy_captures WHERE id=? AND company_id=?', [begin.id, user.companyId]);
    await sendFrame(device, r.remote_session_id);
    const transaction = ds.transaction.bind(ds);
    let lost = false;
    const spy = jest.spyOn(ds, 'transaction').mockImplementation((async (...args: any[]) => {
      let savedCapture = false;
      const work = async (em: any) => {
        const query = em.query.bind(em);
        jest.spyOn(em, 'query').mockImplementation((async (sql: string, params?: any[]) => {
          if (sql.startsWith("UPDATE sm_legacy_captures SET status='succeeded'")) savedCapture = true;
          return query(sql, params);
        }) as any);
        return args[args.length - 1](em);
      };
      const result = await (typeof args[0] === 'string' ? transaction(args[0] as any, work) : transaction(work));
      if (savedCapture && !lost) { lost = true; throw new Error('synthetic-lost-commit-ack'); }
      return result;
    }) as any);
    const result = await capture.get(user, 'finance_withdrawal', begin.id);
    spy.mockRestore();
    expect(lost).toBe(true); expect(result.status).toBe('succeeded'); expect(result.file?.id).toBeTruthy();
    expect(services.storage.objects.size).toBe(1); expect(services.storage.removed).toHaveLength(0);
    expect((await capture.get(user, 'finance_withdrawal', begin.id)).file?.id).toBe(result.file?.id);
  });

  it.each(['global-stop', 'device-revoked', 'policy-disabled'] as const)('上传等待期间 %s 必须回滚凭证并补偿对象', async change => {
    const { device, workspaceId } = await browserFixture();
    const begin = await capture.begin(user, 'finance_withdrawal', legacyId);
    const [r] = await ds.query('SELECT remote_session_id FROM sm_legacy_captures WHERE id=? AND company_id=?', [begin.id, user.companyId]);
    await sendFrame(device, r.remote_session_id);
    const upload = services.storage.upload.bind(services.storage);
    let started!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = jest.spyOn(services.storage, 'upload').mockImplementationOnce(async (...args) => {
      started(); await gate; return upload(...args);
    });
    const poll = capture.get(user, 'finance_withdrawal', begin.id);
    try {
      await waiting;
      if (change === 'global-stop') process.env.KUDESI_REMOTE_ASSIST_DISABLED = '1';
      if (change === 'device-revoked') await store.execute("UPDATE session_devices SET status='revoked' WHERE id=? AND company_id=? AND workspace_id=?", [device.id, user.companyId, workspaceId]);
      if (change === 'policy-disabled') await ds.query('UPDATE sm_legacy_remote_policies SET enabled=0 WHERE company_id=? AND workspace_id=? AND device_id=?', [user.companyId, workspaceId, device.id]);
      release();
      const result = await poll;
      expect(result.status).toBe('failed'); expect(result.file).toBeNull();
      expect(services.storage.objects.size).toBe(0); expect(services.storage.removed).toHaveLength(1);
      expect(Number((await ds.query("SELECT COUNT(*) n FROM resource_files WHERE company_id=? AND resource_type='withdrawal-voucher'", [user.companyId]))[0].n)).toBe(0);
    } finally { release(); spy.mockRestore(); }
  });
});
