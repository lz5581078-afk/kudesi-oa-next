import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, Notification, OutboxJob, PlatformAdmin, Position, PositionPermission, User, UserPermissionOverride } from '../entities';
import { AuthService } from '../auth/auth.service';
import { FeishuAuthService } from '../auth/feishu-auth.service';
import { ExternalConfigService, FeishuConfig } from '../integrations/external-config.service';
import { ConnectedFeishuSender } from '../outbox/feishu-sender';
import { FeishuNoticeService } from '../outbox/feishu-notice.service';
import { writeNotification } from '../outbox/write-notification';
import { TaskService } from '../flow/task.service';
import { buildServices } from '../test-support';
import { AuthUser } from '../common/auth.decorators';
import { OrgAdminService } from './org-admin.service';
import { StaffEnrollmentService } from './staff-enrollment.service';
const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('岗位入职→本人飞书绑定→OA通知推送（隔离MySQL，飞书网络替身）', () => {
  let ds: DataSource, auth: AuthService, binding: FeishuAuthService, notices: FeishuNoticeService, config: ExternalConfigService;
  let boss: AuthUser, employee: AuthUser, general: AuthUser, other: AuthUser, cfg: FeishuConfig;
  const identity = { openId: 'ou_' + randomBytes(8).toString('hex'), unionId: 'on_test', tenantKey: 'enrollment-tenant' };
  const client = { identity: jest.fn(async () => ({ ...identity })), send: jest.fn(async () => {}) };
  const password = 'only-for-isolated-tests';
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true } as never).initialize();
    const tag = randomBytes(8).toString('hex');
    const c = await ds.manager.save(Company, { code: tag, name: '新员工飞书测试', status: 'active' });
    const u = await ds.manager.save(User, { companyId: c.id, account: tag, name: '人事', passwordHash: 'x', status: 'active', isCompanyAdmin: true });
    boss = { id: u.id, companyId: c.id, name: u.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    const org = new OrgAdminService(ds), enroll = new StaffEnrollmentService(ds);
    const job = await org.createPosition(boss, { name: '运营', workspaceType: 'operations' });
    await org.setPositionPermissions(boss, job.id, ['resource.stores.view']);
    auth = new AuthService(new JwtService({ secret: randomBytes(48).toString('hex') }), ds.getRepository(Company), ds.getRepository(PlatformAdmin), ds.getRepository(User), ds.getRepository(Position), ds.getRepository(PositionPermission), ds.getRepository(UserPermissionOverride), ds.getRepository(AuditLog));
    const signup = async (mode: 'general' | 'position') => {
      const invite = await enroll.create(boss, { mode, ...(mode === 'position' ? { positionId: job.id } : {}) });
      const phone = '139' + String(BigInt('0x' + randomBytes(6).toString('hex')) % 100000000n).padStart(8, '0');
      await enroll.join({ token: invite.token, name: mode, phone, password, ...(mode === 'general' ? { positionId: job.id } : {}) });
      const me = await auth.login(phone, password); if (me.type !== 'company') throw Error('wrong login');
      return { ...me.user } as AuthUser;
    };
    employee = await signup('position'); general = await signup('general'); other = await signup('position');
    const crypto = buildServices(ds).crypto; config = new ExternalConfigService(ds, crypto);
    cfg = { appId: 'cli_' + tag, appSecret: 'isolated-only', tenantKey: identity.tenantKey, enabled: true, origin: 'https://test.example', channels: [] };
    await ds.query('INSERT INTO integration_settings(company_id,setting_key,config_enc) VALUES(?,?,?)', [c.id, 'feishu', crypto.encrypt(JSON.stringify(cfg))]);
    binding = new FeishuAuthService(config, client as never, auth);
    notices = new FeishuNoticeService(ds, new ConnectedFeishuSender(config, client as never));
  });
  afterAll(async () => { await ds?.destroy(); });
  const note = (userId = employee.id, title = '测试通知') => ({ companyId: boss.companyId, userId, kind: 'task', title, body: '任务内容', link: '/workbench/todos' });
  const jobs = () => ds.manager.find(OutboxJob, { where: { companyId: boss.companyId, channel: 'feishu' }, order: { id: 'ASC' } });
  it('岗位入职身份由审计记录恢复，未绑定前每次登录都能继续绑定；通用码不强制绑定', async () => {
    expect(await auth.me(employee.id, employee.companyId)).toMatchObject({ feishuBindingPending: true, permissions: { isCompanyAdmin: false } });
    expect((await auth.me(general.id, general.companyId)).feishuBindingPending).toBeUndefined();
    expect((await binding.status(employee)).bound).toBe(false);
    expect((await binding.status(employee)).notificationsEnabled).toBe(false);
  });
  it('未完成或跨企业授权不写绑定，不开通知，也不影响已经建好的OA账号', async () => {
    const s = await binding.start(employee.companyId, employee);
    client.identity.mockResolvedValueOnce({ ...identity, tenantKey: 'wrong' });
    await expect(binding.complete('code', s.state, s.browser, employee)).rejects.toThrow('本企业');
    expect((await binding.status(employee)).bound).toBe(false);
    expect(await ds.manager.findOneBy(User, { id: employee.id })).toBeTruthy();
    expect(await jobs()).toHaveLength(0);
  });
  it('飞书授权与刚创建的OA身份一对一绑定，手机号/姓名不参与猜测', async () => {
    const s = await binding.start(employee.companyId, employee);
    expect(await binding.complete('code', s.state, s.browser, employee)).toEqual({ bound: true, allNotificationsEnabled: true });
    expect(await binding.status(employee)).toMatchObject({ bound: true, allNotificationsEnabled: true, notificationsEnabled: false });
    expect((await auth.me(employee.id, employee.companyId)).feishuBindingPending).toBeUndefined();
    const [row] = await ds.query('SELECT * FROM feishu_identities WHERE company_id=? AND user_id=?', [employee.companyId, employee.id]);
    expect(row).toMatchObject({ open_id: identity.openId, oa_notifications: 1 });
    const conflict = await binding.start(other.companyId, other);
    await expect(binding.complete('code', conflict.state, conflict.browser, other)).rejects.toThrow('其他员工');
    expect((await auth.me(other.id, other.companyId)).feishuBindingPending).toBe(true);
  });
  it('公司开关关闭时不排队，不补发旧通知；开启后真实任务指派只给绑定员工排队一次', async () => {
    await writeNotification(ds.manager, note(employee.id, '关闭期间通知'));
    expect(await jobs()).toHaveLength(0);
    await notices.setSwitch(boss, true);
    const task = new TaskService(ds);
    await task.create(boss, { title: '新人盘点', assigneeId: employee.id });
    expect(await jobs()).toHaveLength(1);
    expect((await jobs())[0].payloadJson).toMatchObject({ userId: employee.id, channel: 'notice', title: '人事 给你指派了任务：新人盘点' });
    await task.create(boss, { title: '未绑定员工的任务', assigneeId: other.id });
    expect(await jobs()).toHaveLength(1);
    expect(await notices.processCompany(employee.companyId)).toMatchObject({ sent: 1, failed: 0 });
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0]).toEqual(expect.arrayContaining([identity.openId, 'open_id']));
    await notices.processCompany(employee.companyId);
    expect(client.send).toHaveBeenCalledTimes(1);
  });
  it('业务回滚同时撤销站内通知和飞书任务；旧模板通道不会重复给该员工发消息', async () => {
    const before = (await jobs()).length;
    await expect(ds.transaction(async em => { await writeNotification(em, note(employee.id, '应回滚')); throw Error('rollback'); })).rejects.toThrow('rollback');
    expect(await ds.manager.countBy(Notification, { companyId: employee.companyId, title: '应回滚' })).toBe(0);
    expect(await jobs()).toHaveLength(before);
    expect(await notices.enqueue(ds.manager, employee.companyId, 'sku-batch-apply', 'legacy', { userId: employee.id, title: '旧模板' })).toBe(false);
    await ds.transaction(async em => {
      const delivery = { key: 'schedule:99:1', channel: 'live', resourceType: 'live-schedule', resourceId: 99, kind: 'schedule' };
      await writeNotification(em, note(), delivery); await writeNotification(em, note(), delivery);
    });
    expect(await jobs()).toHaveLength(before + 1);
    await notices.cancelPending(ds.manager, employee.companyId, 'live-schedule', 99);
    expect((await jobs()).at(-1)?.status).toBe('cancelled');
  });
  it('普通绑定保持旧通知范围；停用员工不加入统一推送，未绑定的人不会被手机号误发', async () => {
    const s = await binding.start(general.companyId, general);
    client.identity.mockResolvedValueOnce({ ...identity, openId: identity.openId + '_general' });
    expect(await binding.complete('general', s.state, s.browser, general)).toEqual({ bound: true });
    const before = (await jobs()).length;
    await writeNotification(ds.manager, note(general.id));
    expect(await jobs()).toHaveLength(before);
    await ds.manager.update(User, employee.id, { status: 'disabled' });
    try { await writeNotification(ds.manager, note()); expect(await jobs()).toHaveLength(before); }
    finally { await ds.manager.update(User, employee.id, { status: 'active' }); }
  });
});
