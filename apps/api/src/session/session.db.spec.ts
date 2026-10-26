/** 店铺提现登录管理 + 提现单登记的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test npx jest session */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { alignSessionTimeZone, buildDataSourceOptions } from '../database/data-source';
import { Company, SessionAuditLog, SessionShop, User } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { SessionService } from './session.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('店铺提现（真实数据库）', () => {
  let services: ReturnType<typeof buildServices>;
  let ds: DataSource, svc: SessionService, docs: FinanceDocumentsService, res: ReturnType<typeof buildServices>['resources'], crypt: ReturnType<typeof buildServices>['crypto'];
  let boss: AuthUser, viewer: AuthUser;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    await alignSessionTimeZone(ds); // 和应用启动时一致，数据库默认时间才和程序时间同一个时区
    const s = buildServices(ds); services = s;
    res = s.resources; crypt = s.crypto;
    svc = new SessionService(ds, crypt, s.files);
    docs = new FinanceDocumentsService(ds);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `s${crypto.randomBytes(5).toString('hex')}`, name: '提现测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    viewer = { id: u.id, companyId: c.id, name: '看的人', permissions: { isCompanyAdmin: false, allow: ['finance.doc-withdrawal.view'], deny: [] } };
    ids.store = (await res.create(boss, 'stores', { platform: 'pdd', name: '提现店A' })).id;
    ids.store2 = (await res.create(boss, 'stores', { platform: 'taobao', name: '提现店B' })).id;
    ids.bank = (await res.create(boss, 'bank-accounts', { kind: 'company_public', accountName: '公户', bank: '测试银行', accountNo: '6222000011112222', balance: 0 })).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  const pair = async () => {
    const { code } = await svc.createBindCode(boss);
    return svc.agentRegister({ code, name: '办公室电脑', os: 'Windows 11', agentVersion: '1.0.0' });
  };

  it('绑定码只能用一次；错误/过期的不行；撤销后令牌立即失效', async () => {
    const { code } = await svc.createBindCode(boss);
    const dev = await svc.agentRegister({ code, name: '电脑1' });
    expect(dev.token).toHaveLength(64);
    await expect(svc.agentRegister({ code, name: '电脑2' })).rejects.toThrow(/无效或已过期/);
    await expect(svc.agentRegister({ code: 'ABC', name: 'x' })).rejects.toThrow(/绑定码不对/);
    expect((await svc.agentHeartbeat(dev.token, { agentVersion: '1.0.1' })).ok).toBe(true);
    await expect(svc.agentHeartbeat('0'.repeat(64), {})).rejects.toThrow(/未授权/);
    await expect(svc.agentHeartbeat(undefined, {})).rejects.toThrow(/未授权/);
    await svc.setDeviceStatus(boss, dev.deviceId, 'revoked');
    await expect(svc.agentHeartbeat(dev.token, {})).rejects.toThrow(/未授权/);
    await expect(svc.createBindCode(viewer)).rejects.toThrow(/权限/);
  });

  it('添加店铺 → 填凭据（首次填全默认自动登录）→ 请求登录 → 助手领取并交付凭据 → 回报成功', async () => {
    const dev = await pair();
    await svc.agentHeartbeat(dev.token, {});
    await expect(svc.addShops(viewer, { storeIds: [ids.store], deviceId: dev.deviceId })).rejects.toThrow(/权限/);
    expect((await svc.availableStores(boss)).map((x) => x.name)).toContain('提现店A');
    await svc.addShops(boss, { storeIds: [ids.store], deviceId: dev.deviceId });
    await expect(svc.addShops(boss, { storeIds: [ids.store], deviceId: dev.deviceId })).rejects.toThrow(/已经在列表里/);
    expect((await svc.availableStores(boss)).map((x) => x.name)).not.toContain('提现店A');
    let shop = (await svc.overview(boss)).shops[0];
    expect(shop).toMatchObject({ storeName: '提现店A', deviceStatus: 'online', loginState: 'none', hasPassword: false, autoLogin: false });
    await svc.updateShop(boss, shop.id, { loginAccount: 'pdd_boss', loginPassword: 'S3cret!pw' });
    shop = (await svc.overview(boss)).shops[0];
    expect(shop).toMatchObject({ hasPassword: true, autoLogin: true, loginAccount: 'pdd_boss' });
    expect(JSON.stringify(shop)).not.toContain('S3cret'); // 列表里永远没有密码
    const row = await ds.manager.findOneByOrFail(SessionShop, { id: shop.id });
    expect(row.loginPasswordEnc).not.toContain('S3cret'); // 库里是密文
    expect(await svc.revealPassword(boss, shop.id)).toEqual({ account: 'pdd_boss', password: 'S3cret!pw' });
    await expect(svc.revealPassword(viewer, shop.id)).rejects.toThrow(/权限/);

    const req = await svc.requestOpen(boss, shop.id);
    expect(req.kind).toBe('first');
    await expect(svc.requestOpen(boss, shop.id)).rejects.toThrow(/进行中/);
    const claimed = (await svc.agentClaim(dev.token)).request!;
    expect(claimed).toMatchObject({ id: req.id, store: { name: '提现店A', platform: 'pdd' }, credentials: { account: 'pdd_boss', password: 'S3cret!pw' } });
    expect((await svc.agentClaim(dev.token)).request).toBeNull(); // 已领取，不会重复发
    await svc.agentReport(dev.token, req.id, { status: 'succeeded' });
    await expect(svc.agentReport(dev.token, req.id, { status: 'succeeded' })).rejects.toThrow(/不是进行中/);
    expect((await svc.overview(boss)).shops[0].loginState).toBe('valid');
    expect((await svc.requestOpen(boss, shop.id)).kind).toBe('now'); // 登录有效 → 立即登录
    // 失败回报：错误文案里不能带出密码
    const r2 = (await svc.agentClaim(dev.token)).request!;
    await svc.agentReport(dev.token, r2.id, { status: 'failed', errorCode: 'login_expired', errorText: '密码 S3cret!pw 过期' });
    const hist = await svc.history(boss, shop.id);
    expect(hist[0]).toMatchObject({ status: 'failed', errorCode: 'login_expired' });
    expect(hist[0].errorText).not.toContain('S3cret');
    expect((await svc.overview(boss)).shops[0].loginState).toBe('expired');
    const logs = await ds.manager.find(SessionAuditLog, { where: { companyId: boss.companyId } });
    expect(logs.map((l) => l.eventType)).toEqual(expect.arrayContaining(['credential_viewed', 'auto_login_credentials_delivered', 'shop_open_completed', 'shop_open_failed']));
    expect(JSON.stringify(logs)).not.toContain('S3cret'); // 日志里没有密码
    // 清除密码同时关闭自动登录
    await svc.updateShop(boss, shop.id, { clearPassword: true });
    expect((await svc.overview(boss)).shops[0]).toMatchObject({ hasPassword: false, autoLogin: false });
  });

  it('助手离线不能请求；电脑撤销取消进行中的请求；有进行中请求不能移除；移除后可重新添加', async () => {
    const dev = await pair();
    await svc.addShops(boss, { storeIds: [ids.store2], deviceId: dev.deviceId });
    const shop = (await svc.overview(boss)).shops.find((s) => s.storeId === ids.store2)!;
    await ds.manager.update('session_devices', { id: dev.deviceId }, { lastSeenAt: new Date(Date.now() - 10 * 60_000) });
    await expect(svc.requestOpen(boss, shop.id)).rejects.toThrow(/不在线/);
    await svc.agentHeartbeat(dev.token, {});
    await svc.requestOpen(boss, shop.id);
    await expect(svc.removeShop(boss, shop.id)).rejects.toThrow(/进行中/);
    await svc.setDeviceStatus(boss, dev.deviceId, 'revoked');
    expect((await svc.history(boss, shop.id))[0].status).toBe('cancelled');
    await svc.removeShop(boss, shop.id);
    expect((await svc.overview(boss)).shops.find((s) => s.storeId === ids.store2)).toBeUndefined();
    const dev2 = await pair();
    await svc.addShops(boss, { storeIds: [ids.store2], deviceId: dev2.deviceId }); // 恢复
    expect((await svc.overview(boss)).shops.find((s) => s.storeId === ids.store2)?.deviceId).toBe(dev2.deviceId);
  });

  it('提现单：必须选店铺并填平台流水号；同一流水号不能登记两次；红冲后银行余额还原', async () => {
    const base = { type: 'withdrawal' as const, date: '2026-10-25', storeId: ids.store, bankAccountId: ids.bank, amountCents: 50000 };
    const noRef = await docs.createDraft(boss, { ...base });
    await expect(docs.issue(boss, noRef.id)).rejects.toThrow(/平台提现流水号/);
    await expect(docs.createDraft(boss, { ...base, storeId: 999999, refNo: 'X1' })).rejects.toThrow(/店铺不存在/);
    const a = await docs.createDraft(boss, { ...base, refNo: 'PDD20261025001' });
    expect(a.storeName).toBe('提现店A');
    await expect(docs.createDraft(boss, { ...base, refNo: 'PDD20261025001' })).rejects.toThrow(/已经登记过/);
    const posted = await docs.post(boss, a.id);
    expect(posted.entries.map((e) => [e.kind, e.amountCents])).toEqual([['bank', 50000], ['receivable', -50000]]);
    expect((await docs.bankBalances(boss)).find((b) => b.id === ids.bank)!.balanceCents).toBe(50000);
    await docs.reverse(boss, a.id, '平台提现失败退回');
    expect((await docs.bankBalances(boss)).find((b) => b.id === ids.bank)!.balanceCents).toBe(0);
    await expect(docs.createDraft(boss, { ...base, refNo: 'PDD20261025001' })).rejects.toThrow(/已经登记过/); // 红冲后流水号仍占用
  });

  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

  it('提现凭证：助手截图上传 → 网页取到文件 → 绑定到提现单 → 可换可删，别的类型/公司的单据不能绑', async () => {
    await services.settings.saveQiniu(boss, { accessKey: 'AK', secretKey: 'SK', bucket: 'b', zone: 'z2', domain: 'https://cdn.example.com', isPrivate: true } as never);
    const dev = await pair();
    await svc.agentHeartbeat(dev.token, {});
    const st = (await res.create(boss, 'stores', { platform: 'pdd', name: '凭证店' })).id;
    await svc.addShops(boss, { storeIds: [st], deviceId: dev.deviceId });
    const shop = (await svc.overview(boss)).shops.find((x) => x.storeId === st)!;
    // 请求截图
    const cap = await svc.requestCapture(boss, shop.id);
    await expect(svc.requestCapture(boss, shop.id)).rejects.toThrow(/进行中/);
    const claimed = await svc.agentClaim(dev.token);
    expect(claimed.request).toMatchObject({ id: cap.id, kind: 'capture', credentials: null });
    await expect(svc.agentUpload(dev.token, cap.id, { originalname: 'x.exe', buffer: Buffer.from('MZ not an image'), size: 15 })).rejects.toThrow(/只能上传/);
    const up = await svc.agentUpload(dev.token, cap.id, { originalname: 'shot.png', buffer: PNG, size: PNG.length });
    await expect(svc.agentUpload(dev.token, cap.id, { originalname: 'shot.png', buffer: PNG, size: PNG.length })).rejects.toThrow(/不是进行中/);
    const status = await svc.requestStatus(boss, cap.id);
    expect(status).toMatchObject({ status: 'succeeded', kind: 'capture' });
    expect(status.file?.id).toBe(up.fileId);
    expect((await svc.overview(boss)).shops.find((x) => x.storeId === st)!.loginState).toBe('none'); // 截图不改登录状态
    // 手工上传
    const manual = await svc.uploadVoucher(boss, { originalname: '回单.png', buffer: PNG, size: PNG.length });
    await expect(svc.uploadVoucher(viewer, { originalname: 'a.png', buffer: PNG, size: PNG.length })).rejects.toThrow(/权限/);
    // 绑定到提现单
    const d = await docs.createDraft(boss, { type: 'withdrawal', date: '2026-10-25', storeId: st, bankAccountId: ids.bank, amountCents: 100, refNo: 'VCH-001' });
    const bound = await svc.bindVouchers(boss, d.id, [up.fileId, manual.id]);
    expect(bound.map((f) => f.id).sort()).toEqual([up.fileId, manual.id].sort());
    expect((await svc.voucherUrl(boss, up.fileId)).url).toContain('fake.example.com');
    const after = await svc.bindVouchers(boss, d.id, [manual.id]); // 去掉一个
    expect(after.map((f) => f.id)).toEqual([manual.id]);
    expect(services.storage.removed.length).toBe(1);
    await expect(svc.voucherUrl(boss, up.fileId)).rejects.toThrow(/不存在/);
    // 已被别的单据占用的文件、非提现单都不能绑
    const d2 = await docs.createDraft(boss, { type: 'withdrawal', date: '2026-10-25', storeId: st, bankAccountId: ids.bank, amountCents: 100, refNo: 'VCH-002' });
    await expect(svc.bindVouchers(boss, d2.id, [manual.id])).rejects.toThrow(/无效的文件/);
    const ex = await docs.createDraft(boss, { type: 'expense', date: '2026-10-25' });
    await expect(svc.bindVouchers(boss, ex.id, [])).rejects.toThrow(/提现单不存在/);
    await expect(svc.bindVouchers(viewer, d.id, [])).rejects.toThrow(/权限/);
  });
});
