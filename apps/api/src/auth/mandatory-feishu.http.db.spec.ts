import 'reflect-metadata';
import { Controller, Get, INestApplication, Post, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AuthenticatedOnly, PlatformOnly } from '../common/auth.decorators';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { PermissionsGuard } from '../common/permissions.guard';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, PlatformAdmin, Position, PositionPermission, User, UserPermissionOverride } from '../entities';
import { ExternalConfigService, FeishuConfig } from '../integrations/external-config.service';
import { buildServices } from '../test-support';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FeishuAuthController } from './feishu-auth.controller';
import { FeishuAuthService } from './feishu-auth.service';
import { FeishuBindingPolicy } from './feishu-binding-policy';
import { StaffFeishuService } from '../org/staff-feishu.service';

@Controller('binding-policy-test')
class BusinessProbe {
  @AuthenticatedOnly() @Get() read() { return { business: true }; }
  @AuthenticatedOnly() @Post() write() { return { business: true }; }
  @PlatformOnly() @Get('platform') platform() { return { platform: true }; }
}
const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('全员强制飞书绑定：真实HTTP/JWT/权限守卫及隔离MySQL', () => {
  let app: INestApplication, base: string, ds: DataSource, jwt: JwtService, policy: FeishuBindingPolicy;
  let manual: User, admin: User, bound: User, passwordUser: User, company: Company, otherCompany: Company;
  let config: ExternalConfigService, cfg: FeishuConfig;
  const password = 'must-bind-test-password';
  const subject = 'ou_' + randomBytes(8).toString('hex');
  const client = { identity: jest.fn(async () => ({ openId: subject, unionId: null, tenantKey: cfg.tenantKey })) };
  const token = (u: User) => jwt.sign({ sub: u.id, cid: u.companyId });
  const request = (path: string, auth?: string, body?: object) => fetch(base + '/api/' + path, { method: body ? 'POST' : 'GET', headers: { ...(auth ? { authorization: 'Bearer ' + auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const bindRow = (u: User, extra: Record<string, unknown> = {}) => ds.query('INSERT INTO feishu_identities(company_id,user_id,app_id,tenant_key,open_id,oa_notifications) VALUES(?,?,?,?,?,?)', [extra.companyId ?? u.companyId, u.id, extra.appId ?? cfg.appId, extra.tenantKey ?? cfg.tenantKey, extra.openId ?? 'ou_' + randomBytes(8).toString('hex'), extra.oaNotifications ?? 0]);
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true } as never).initialize();
    const tag = randomBytes(8).toString('hex');
    company = await ds.manager.save(Company, { code: tag, name: '强制绑定测试', status: 'active' });
    otherCompany = await ds.manager.save(Company, { code: tag + 'b', name: '其他公司', status: 'active' });
    const mk = (name: string, isCompanyAdmin = false) => ds.manager.save(User, { companyId: company.id, account: tag + name, name, passwordHash: bcrypt.hashSync(password, 4), status: 'active', mustChangePassword: true, isCompanyAdmin });
    manual = await mk('手工建档老员工'); admin = await mk('公司管理员', true); bound = await mk('已绑定老员工'); passwordUser = await mk('改密员工');
    const crypto = buildServices(ds).crypto; config = new ExternalConfigService(ds, crypto);
    cfg = { appId: 'cli_' + tag, appSecret: 'test-only', tenantKey: 'tenant_' + tag, origin: 'https://test.example', enabled: true, channels: [] };
    await ds.query('INSERT INTO integration_settings(company_id,setting_key,config_enc) VALUES(?,?,?)', [company.id, 'feishu', crypto.encrypt(JSON.stringify(cfg))]);
    await bindRow(bound); // Existing valid bindings count even before the all-notifications marker existed.
    policy = new FeishuBindingPolicy(config);
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: randomBytes(48).toString('hex') })],
      controllers: [BusinessProbe, AuthController, FeishuAuthController],
      providers: [AuthService, { provide: FeishuBindingPolicy, useValue: policy },
        { provide: FeishuAuthService, useFactory: (auth: AuthService) => new FeishuAuthService(config, client as never, auth), inject: [AuthService] },
        ...[User, Company, PlatformAdmin, Position, PositionPermission, UserPermissionOverride, AuditLog].map(entity => ({ provide: getRepositoryToken(entity), useValue: ds.getRepository(entity) })),
        { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }],
    }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl(); jwt = app.get(JwtService);
  });
  afterAll(async () => { await app?.close(); await ds?.destroy(); });
  it('手工老员工及公司管理员密码登录后都必须绑定；旧JWT直接读写业务也被拒绝', async () => {
    for (const u of [manual, admin]) {
      const login = await request('auth/login', undefined, { account: u.account!, password }); expect(login.status).toBe(201);
      expect((await login.json()).user.feishuBindingPending).toBe(true);
      expect((await request('auth/me', token(u))).status).toBe(200);
      for (const body of [undefined, {}]) {
        const blocked = await request('binding-policy-test', token(u), body); expect(blocked.status).toBe(403);
        expect(await blocked.json()).toMatchObject({ code: 'FEISHU_BINDING_REQUIRED' });
      }
    }
  });
  it('真实已绑定员工不重复授权，通知标记为0也不妨碍正常使用', async () => {
    const login = await request('auth/login', undefined, { account: bound.account!, password });
    expect((await login.json()).user.feishuBindingPending).toBeUndefined();
    expect((await request('binding-policy-test', token(bound))).status).toBe(200);
  });
  it('未绑定仍可读取本人状态、修改本人密码、发起并完成授权；绑定后原JWT即可正常访问', async () => {
    expect((await request('auth/feishu/binding', token(manual))).status).toBe(200);
    expect((await request('auth/change-password', token(passwordUser), { oldPassword: password, newPassword: 'new-password-for-binding' })).status).toBe(201);
    const begin = await request('auth/feishu/bind/start', token(manual), {}); expect(begin.status).toBe(201);
    const state = new URL((await begin.json()).authorizationUrl).searchParams.get('state');
    const cookie = begin.headers.get('set-cookie')!.split(';')[0];
    const result = await fetch(base + '/api/auth/feishu/bind/complete', { method: 'POST', headers: { authorization: 'Bearer ' + token(manual), cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'synthetic-authorized-code', state }) });
    expect(result.status).toBe(201); expect(await result.json()).toMatchObject({ bound: true, allNotificationsEnabled: true });
    expect((await request('auth/me', token(manual))).status).toBe(200);
    expect((await (await request('auth/me', token(manual))).json()).feishuBindingPending).toBeUndefined();
    expect((await request('binding-policy-test', token(manual), {})).status).toBe(201);
  });
  it('解绑后原JWT立即失效于业务访问，登录状态恢复仍只允许绑定', async () => {
    const reset=new StaffFeishuService(ds,config),actor={id:admin.id,companyId:company.id,name:admin.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    await reset.resetBindings(actor,(await reset.resetPreview(actor)).fingerprint);
    const response = await request('binding-policy-test', token(manual)); expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('FEISHU_BINDING_REQUIRED');
    expect((await (await request('auth/me', token(manual))).json()).feishuBindingPending).toBe(true);
  });
  it('别公司、别应用或别租户的绑定不能冒充本公司当前绑定；客户端公司身份不能绕过', async () => {
    for (const extra of [{ companyId: otherCompany.id }, { appId: 'wrong-app' }, { tenantKey: 'wrong-tenant' }]) {
      await bindRow(admin, extra);
      try { expect(await policy.isBound(admin.companyId, admin.id)).toBe(false); expect((await request('binding-policy-test', token(admin))).status).toBe(403); }
      finally { await ds.query('DELETE FROM feishu_identities WHERE user_id=?', [admin.id]); }
    }
    expect((await request('binding-policy-test', jwt.sign({ sub: admin.id, cid: otherCompany.id }))).status).toBe(401);
  });
  it('飞书配置缺失时仍拒绝业务，平台管理员继续使用独立平台后台', async () => {
    const newcomer = await ds.manager.save(User, { companyId: otherCompany.id, account: randomBytes(8).toString('hex'), name: '未配置公司员工', passwordHash: 'x', status: 'active' });
    expect((await request('binding-policy-test', token(newcomer))).status).toBe(403);
    const platform = await ds.manager.save(PlatformAdmin, { account: randomBytes(8).toString('hex'), name: '平台管理', passwordHash: 'x', status: 'active' });
    const auth = jwt.sign({ sub: platform.id, typ: 'platform' });
    expect((await request('binding-policy-test/platform', auth)).status).toBe(200);
    expect((await request('binding-policy-test', auth)).status).toBe(403);
  });
});
