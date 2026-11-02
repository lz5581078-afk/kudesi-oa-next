import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, IntegrationSetting, OutboxJob, User } from '../entities';
import { buildServices } from '../test-support';
import { AuthUser } from '../common/auth.decorators';
import { AssistantInput, AssistantService } from './assistant.service';
import { ASSISTANT_CHANNEL, MORNING_TEXT, WELCOME_TEXT } from './greetings';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('OA助手真实队列隔离与防重（隔离MySQL）', () => {
  let ds: DataSource, service: AssistantService, user: AuthUser, other: AuthUser;
  let input: AssistantInput;
  const client = { batchSend: jest.fn(async () => 'bm-test'), send: jest.fn(async () => {}), tenantToken: jest.fn(async () => 'test-token') };
  const now = new Date('2030-01-02T00:00:00Z');
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    service = new AssistantService(ds, buildServices(ds).crypto, client as never);
    const mk = async () => {
      const tag = randomBytes(8).toString('hex');
      const c = await ds.manager.save(Company, { code: tag, name: tag, status: 'active' });
      const u = await ds.manager.save(User, { companyId: c.id, account: tag, passwordHash: 'test', name: tag, status: 'active', isCompanyAdmin: true });
      return { id: u.id, companyId: c.id, name: tag, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    };
    user = await mk(); other = await mk();
    input = { appId: 'cli_' + randomBytes(6).toString('hex'), appSecret: 'test-private-secret', tenantKey: 'test-tenant', enabled: true, morningEnabled: true, welcomeEnabled: false, morningText: MORNING_TEXT, welcomeText: WELCOME_TEXT, departmentIds: ['0'] };
  });
  afterAll(async () => { service?.onModuleDestroy(); await ds?.destroy(); });
  const jobs = () => ds.manager.find(OutboxJob, { where: { companyId: user.companyId, channel: ASSISTANT_CHANNEL } });
  it('公司管理员才能配置，密钥加密且不从概况或日志返回', async () => {
    await expect(service.save({ ...user, permissions: { ...user.permissions, isCompanyAdmin: false } }, input)).rejects.toThrow(/公司管理员/);
    const view = await service.save(user, input);
    expect(view.secretConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain(input.appSecret);
    const row = await ds.manager.findOneByOrFail(IntegrationSetting, { companyId: user.companyId, settingKey: 'feishu-assistant' });
    expect(row.configEnc).not.toContain(input.appSecret);
    expect((await service.overview(other.companyId)).enabled).toBe(false);
    await expect(service.save(other, input)).rejects.toThrow(/其他公司/);
    await expect(service.save(user, { ...input, appId: 'cli_other', appSecret: '' })).rejects.toThrow(/App Secret/);
  });
  it('并发定时扫描、重启同一天只群发一次，每天新建一条', async () => {
    await Promise.all([service.tick(now), service.tick(now)]);
    await service.tick(now);
    expect(client.batchSend).toHaveBeenCalledTimes(1);
    const second = new AssistantService(ds, (service as any).crypto, client as never);
    await second.tick(now);
    expect(client.batchSend).toHaveBeenCalledTimes(1);
    await service.tick(new Date('2030-01-03T00:00:00Z'));
    expect(client.batchSend).toHaveBeenCalledTimes(2);
    expect((await jobs()).filter(j => j.kind === 'morning' && j.status === 'done')).toHaveLength(2);
    second.onModuleDestroy();
  });
  it('发送结果未知不重发，不重复问候全员', async () => {
    client.batchSend.mockRejectedValueOnce(new Error('private credentials in upstream error'));
    await service.tick(new Date('2030-01-04T00:00:00Z'));
    await service.tick(new Date('2030-01-04T00:01:00Z'));
    expect(client.batchSend).toHaveBeenCalledTimes(3);
    const failed = (await jobs()).find(j => j.status === 'failed')!;
    expect(failed.lastError).not.toContain('credentials');
  });
  it('暂停期间不积压，取消排队任务；过期早安不会在下午发送', async () => {
    await service.save(user, { ...input, enabled: false });
    await service.tick(new Date('2030-01-05T00:00:00Z'));
    expect(client.batchSend).toHaveBeenCalledTimes(3);
    await service.save(user, input);
    await ds.manager.insert(OutboxJob, { companyId: user.companyId, channel: ASSISTANT_CHANNEL, kind: 'morning', resourceType: 'feishu-assistant', resourceId: 0, idempotencyKey: 'expired-test', payloadJson: { appId: input.appId, tenantKey: input.tenantKey, expiresAt: '2020-01-01T00:00:00Z', text: 'old', departmentIds: ['0'] }, nextAttemptAt: new Date() });
    await service.process(user.companyId, new Date());
    expect((await jobs()).find(j => j.idempotencyKey === 'expired-test')?.status).toBe('cancelled');
    expect(client.batchSend).toHaveBeenCalledTimes(3);
  });
  it('入职事件匹配企业和应用，重复事件只发一次；历史和离职事件拒绝', async () => {
    await service.save(user, { ...input, welcomeEnabled: true });
    const ev = { app_id: input.appId, tenant_key: input.tenantKey, create_time: String((Date.now() + 1000) * 1000), object: { open_id: 'ou_testnewemployee' } };
    await service.enqueueWelcome(user.companyId, { ...ev, tenant_key: 'other' });
    await service.enqueueWelcome(user.companyId, { ...ev, app_id: 'cli_other' });
    await service.enqueueWelcome(user.companyId, { ...ev, create_time: '1000000' });
    await service.enqueueWelcome(user.companyId, { ...ev, object: { ...ev.object, status: { is_resigned: true } } });
    expect((await jobs()).filter(j => j.kind === 'welcome')).toHaveLength(0);
    await service.enqueueWelcome(user.companyId, ev);
    await service.enqueueWelcome(user.companyId, ev);
    await service.process(user.companyId, new Date());
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0]).toEqual([expect.objectContaining({ appId: input.appId }), 'ou_testnewemployee', 'open_id', WELCOME_TEXT, expect.stringContaining('welcome:ou_testnewemployee')]);
    await service.process(user.companyId, new Date()); expect(client.send).toHaveBeenCalledTimes(1);
  });
  it('检查连接仅鉴权，不给全员发送测试问候', async () => {
    const before = client.send.mock.calls.length + client.batchSend.mock.calls.length;
    await service.test(user);
    expect(client.send.mock.calls.length + client.batchSend.mock.calls.length).toBe(before);
  });
  it('单独关闭再开启欢迎功能，不回放暂停期间的旧入职事件', async () => {
    await service.save(user, { ...input, welcomeEnabled: false });
    const pausedEvent = { app_id: input.appId, tenant_key: input.tenantKey, create_time: String((Date.now() - 1000) * 1000), object: { open_id: 'ou_joinedwhilepaused' } };
    await service.save(user, { ...input, welcomeEnabled: true });
    await service.enqueueWelcome(user.companyId, pausedEvent);
    expect((await jobs()).filter(j => j.idempotencyKey.includes('joinedwhilepaused'))).toHaveLength(0);
  });
});
