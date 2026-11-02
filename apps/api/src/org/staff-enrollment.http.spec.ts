import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { PermissionsGuard } from '../common/permissions.guard';
import { Company, PlatformAdmin, PositionPermission, User, UserPermissionOverride } from '../entities';
import { StaffEnrollmentAdminController, StaffEnrollmentPublicController } from './staff-enrollment.controller';
import { StaffEnrollmentService } from './staff-enrollment.service';

describe('扫码入职 HTTP 访问与 DTO 边界', () => {
  let app: INestApplication, base: string, jwt: JwtService;
  const token = randomBytes(32).toString('base64url');
  const service = { preview: jest.fn(async () => ({ mode: 'general' })), join: jest.fn(async () => ({ account: '13900000001' })), list: jest.fn(async () => []), create: jest.fn(async () => ({ id: 1 })), revoke: jest.fn(async () => ({ ok: true })) };
  const repo = (rows: any[]) => ({ findOne: async ({ where }: any) => rows.find(r => Object.entries(where).every(([k, v]) => r[k] === v)), find: async () => [] });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: randomBytes(48).toString('hex') }), ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }])],
      controllers: [StaffEnrollmentAdminController, StaffEnrollmentPublicController],
      providers: [{ provide: StaffEnrollmentService, useValue: service },
        { provide: getRepositoryToken(User), useValue: repo([{ id: 1, companyId: 10, name: '人事', status: 'active', isCompanyAdmin: true }, { id: 2, companyId: 10, name: '普通员工', status: 'active', isCompanyAdmin: false }]) },
        { provide: getRepositoryToken(Company), useValue: repo([{ id: 10, status: 'active' }]) },
        ...[PlatformAdmin, PositionPermission, UserPermissionOverride].map(entity => ({ provide: getRepositoryToken(entity), useValue: repo([]) })),
        { provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }],
    }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl(); jwt = app.get(JwtService);
  });
  afterAll(async () => { await app?.close(); });
  const request = (path: string, body?: object, auth?: string) => fetch(base + '/api/' + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { authorization: 'Bearer ' + auth } : {}) }, body: body ? JSON.stringify(body) : undefined });
  it('匿名可读取有效码并提交入职，但不能管理二维码；普通员工也不能生成', async () => {
    expect((await request('enrollment/preview', { token })).status).toBe(201);
    expect((await request('enrollment/join', { token, name: '新人', phone: '13900000001', password: 'safe-password' })).status).toBe(201);
    expect((await request('org/enrollment-invites')).status).toBe(401);
    expect((await request('org/enrollment-invites', { mode: 'general' })).status).toBe(401);
    expect((await request('org/enrollment-invites', { mode: 'general' }, jwt.sign({ sub: 2, cid: 10 }))).status).toBe(403);
    expect((await request('org/enrollment-invites', { mode: 'general' }, jwt.sign({ sub: 1, cid: 10 }))).status).toBe(201);
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ id: 1, companyId: 10 }), { mode: 'general' });
  });
  it('拒绝公司/管理员/权限注入、无效手机号和弱密码，校验失败不触达服务', async () => {
    service.join.mockClear();
    const body = { token, name: '新人', phone: '13900000001', password: 'safe-password' };
    for (const extra of [{ companyId: 20 }, { isCompanyAdmin: true }, { permissions: ['*'] }, { phone: '123' }, { password: '123' }, { positionId: '7' }]) {
      expect((await request('enrollment/join', { ...body, ...extra })).status).toBe(400);
    }
    expect(service.join).not.toHaveBeenCalled();
  });
  it('匿名入职入口执行每分钟限流', async () => {
    const responses = [];
    for (let i = 0; i < 5; i++) responses.push((await request('enrollment/join', { token, name: '新人', phone: '13900000001', password: 'safe-password' })).status);
    expect(responses).toContain(429);
  });
});
