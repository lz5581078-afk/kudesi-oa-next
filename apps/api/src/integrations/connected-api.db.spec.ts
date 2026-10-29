import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ExternalConfigService, FeishuConfig } from './external-config.service';
import { FeishuAuthService, hashState } from '../auth/feishu-auth.service';
import { ConnectedFeishuSender } from '../outbox/feishu-sender';
import { FeishuNoticeService } from '../outbox/feishu-notice.service';
import type { AuthUser } from '../common/auth.decorators';
import { ExternalOutcomeUnknown } from './jushuitan.client';
const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('真实接入的公司隔离、飞书授权与队列（隔离数据库）', () => {
  let ds: DataSource, config: ExternalConfigService, service: FeishuAuthService;
  let user: AuthUser, other: AuthUser, cfg: FeishuConfig;
  const identity = { openId: 'ou_' + randomBytes(6).toString('hex'), unionId: 'on_test', tenantKey: 'tenant-test' };
  const client = { identity: jest.fn(async () => ({ ...identity })), send: jest.fn(async () => {}) };
  const auth = { loginBoundUser: jest.fn(async (id: number, companyId: number) => ({ id, companyId })) };
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never); await ds.initialize();
    const crypto = buildServices(ds).crypto; config = new ExternalConfigService(ds, crypto); service = new FeishuAuthService(config, client as any, auth as any);
    const mk = async () => { const tag = randomBytes(8).toString('hex'); const c = await ds.manager.save(Company, { code: tag, name: tag, status: 'active' }); const u = await ds.manager.save(User, { companyId: c.id, account: tag, passwordHash: 'test', name: tag, status: 'active', isCompanyAdmin: true }); return { id: u.id, companyId: c.id, name: tag, permissions: { isCompanyAdmin: true, allow: [], deny: [] } }; };
    user = await mk(); other = await mk();
    cfg = { appId: 'cli_' + randomBytes(6).toString('hex'), appSecret: 'test-secret', tenantKey: identity.tenantKey, origin: 'https://test.example', enabled: true, channels: [{ key: 'flow', appId: '', appSecret: '', inheritsMainApp: true, enabled: true, recipientUserIds: [] }] };
    await ds.query('INSERT INTO integration_settings(company_id,setting_key,config_enc) VALUES(?,?,?)', [user.companyId, 'feishu', crypto.encrypt(JSON.stringify(cfg))]);
  });
  afterAll(async () => { await ds?.destroy(); });
  it('公司配置只按公司读取，授权入口不返回密钥', async () => {
    expect(await config.read(other.companyId, 'feishu')).toBeNull();
    expect(JSON.stringify(await service.companies())).not.toContain('test-secret');
    await expect(service.start(other.companyId)).rejects.toThrow(/尚未启用/);
  });
  it('跨浏览器、跨员工、过期状态不能交换授权码', async () => {
    const r = await service.start(user.companyId, user);
    await expect(service.complete('code', r.state, randomBytes(32).toString('base64url'), user)).rejects.toThrow(/过期/);
    await expect(service.complete('code', r.state, r.browser, other)).rejects.toThrow(/当前账号/);
    expect(client.identity).not.toHaveBeenCalled();
    await ds.query('UPDATE feishu_oauth_states SET expires_at=DATE_SUB(NOW(),INTERVAL 1 MINUTE) WHERE state_hash=?', [hashState(r.state)]);
    await expect(service.complete('code', r.state, r.browser, user)).rejects.toThrow(/过期/);
  });
  it('绑定必须匹配企业；失败状态不能重放', async () => {
    const r = await service.start(user.companyId, user); client.identity.mockResolvedValueOnce({ ...identity, tenantKey: 'other-tenant' });
    await expect(service.complete('code', r.state, r.browser, user)).rejects.toThrow(/本企业/);
    await expect(service.complete('code', r.state, r.browser, user)).rejects.toThrow(/过期/);
  });
  it('明确绑定后才能登录；并发消费只成功一次', async () => {
    const unbound = await service.start(user.companyId);
    await expect(service.complete('code', unbound.state, unbound.browser)).rejects.toThrow(/尚未绑定/);
    const bind = await service.start(user.companyId, user);
    expect(await service.complete('code', bind.state, bind.browser, user)).toEqual({ bound: true });
    expect((await service.status(user)).bound).toBe(true);
    const login = await service.start(user.companyId);
    const results = await Promise.allSettled([service.complete('code', login.state, login.browser), service.complete('code', login.state, login.browser)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(auth.loginBoundUser).toHaveBeenCalledWith(user.id, user.companyId);
  });
  it('绑定冲突不能抢占已有飞书身份', async () => {
    const sameCompanyUser = { ...user, id: other.id }; // 先按身份参数校验，再由 FK/绑定约束防御；实际控制器只接受 JWT 用户。
    const r = await service.start(user.companyId, sameCompanyUser);
    await expect(service.complete('code', r.state, r.browser, sameCompanyUser)).rejects.toThrow(/其他员工/);
  });
  it('发送器仅查当前公司绑定；外站链接不能进入通知', async () => {
    const sender = new ConnectedFeishuSender(config, client as any);
    await expect(sender.send({ companyId: other.companyId, idempotencyKey: 'a', notice: { userId: user.id, title: 'a' } })).rejects.toThrow(/授权/);
    await expect(sender.send({ companyId: user.companyId, idempotencyKey: 'a', notice: { userId: other.id, title: 'a' } })).rejects.toThrow(/尚未绑定/);
    await expect(sender.send({ companyId: user.companyId, idempotencyKey: 'a', notice: { userId: user.id, title: 'a', link: 'https://attacker.example' } })).rejects.toThrow(/本站/);
    expect(client.send).not.toHaveBeenCalled();
    await sender.send({ companyId: user.companyId, idempotencyKey: 'a', notice: { userId: user.id, title: 'a', link: '/flow/runs/1' } });
    expect(client.send).toHaveBeenCalledWith(cfg, identity.openId, 'open_id', 'a\nhttps://test.example/flow/runs/1', `${user.companyId}:flow:a`);
  });
  it('关闭开关不入队；结果未知失败后不自动重发', async () => {
    const fake = { configured: true, send: jest.fn(async () => { throw new ExternalOutcomeUnknown('结果未知'); }) };
    const notice = new FeishuNoticeService(ds, fake);
    expect(await notice.enqueue(ds.manager, user.companyId, 'sku-batch-apply', 'test', { userId: user.id, title: 'test' })).toBe(false);
    await notice.setSwitch(user, true);
    await notice.enqueue(ds.manager, user.companyId, 'sku-batch-apply', 'test', { userId: user.id, title: 'test' });
    expect((await notice.processCompany(user.companyId)).failed).toBe(1);
    await notice.processCompany(user.companyId); expect(fake.send).toHaveBeenCalledTimes(1);
    expect((await ds.query("SELECT status FROM outbox_jobs WHERE company_id=? AND channel='feishu'", [user.companyId]))[0].status).toBe('failed');
  });
});
