import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthenticatedOnly, Public } from './common/auth.decorators';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { PermissionsGuard } from './common/permissions.guard';
import {
  AuditLog,
  Company,
  Department,
  Position,
  PositionPermission,
  User,
  UserPermissionOverride,
} from './entities';
import { HealthController } from './health/health.controller';
import { OrgController } from './org/org.controller';
import { OrgService } from './org/org.service';
import { Controller, Get } from '@nestjs/common';

/** 内存假仓库：没有 MySQL 时验证守卫、令牌、多公司隔离的整条链路。 */
class FakeRepo<T extends { id?: number | string }> {
  constructor(public rows: T[] = []) {}
  private match(row: T, where?: Partial<T>) {
    return !where || Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
  }
  async findOne(opts: { where?: Partial<T> }) {
    return this.rows.find((r) => this.match(r, opts.where)) ?? null;
  }
  async findOneOrFail(opts: { where?: Partial<T> }) {
    const row = await this.findOne(opts);
    if (!row) throw new Error('not found');
    return row;
  }
  async find(opts: { where?: Partial<T> } = {}) {
    return this.rows.filter((r) => this.match(r, opts.where));
  }
  async update(where: Partial<T>, patch: Partial<T>) {
    this.rows.filter((r) => this.match(r, where)).forEach((r) => Object.assign(r, patch));
  }
  create(data: Partial<T>) {
    return { ...data } as T;
  }
  async save(row: T) {
    if (row.id === undefined) (row as { id: number }).id = this.rows.length + 100;
    this.rows.push(row);
    return row;
  }
}

// 故意不声明权限策略的接口，用来验证默认拒绝
@Controller('probe')
class ProbeController {
  @Get('undeclared')
  undeclared() {
    return { ok: true };
  }

  @AuthenticatedOnly()
  @Get('declared')
  declared() {
    return { ok: true };
  }

  @Public()
  @Get('public')
  publicRoute() {
    return { ok: true };
  }
}

describe('后端整体链路（内存假仓库）', () => {
  let app: INestApplication;
  let base: string;
  let audits: FakeRepo<AuditLog>;
  let deps: FakeRepo<Department>;

  beforeAll(async () => {
    const hash = bcrypt.hashSync('correct-password-1', 4);
    const companies = new FakeRepo<Company>([
      { id: 1, code: 'demo', name: '示例公司', status: 'active', createdAt: new Date() },
      { id: 2, code: 'other', name: '另一家公司', status: 'active', createdAt: new Date() },
    ]);
    const users = new FakeRepo<User>([
      { id: 1, companyId: 1, account: 'admin', passwordHash: hash, name: '管理员', positionId: null, extraPositionIds: null, departmentId: null, isCompanyAdmin: true, status: 'active', mustChangePassword: false, lastLoginAt: null, managerId: null, title: null, baseSalary: null, createdAt: new Date() },
      { id: 2, companyId: 1, account: 'ops', passwordHash: hash, name: '运营', positionId: 10, extraPositionIds: null, departmentId: null, isCompanyAdmin: false, status: 'active', mustChangePassword: false, lastLoginAt: null, managerId: null, title: null, baseSalary: null, createdAt: new Date() },
      { id: 3, companyId: 1, account: 'gone', passwordHash: hash, name: '已停用', positionId: null, extraPositionIds: null, departmentId: null, isCompanyAdmin: true, status: 'disabled', mustChangePassword: false, lastLoginAt: null, managerId: null, title: null, baseSalary: null, createdAt: new Date() },
      { id: 4, companyId: 2, account: 'boss2', passwordHash: hash, name: '二号老板', positionId: null, extraPositionIds: null, departmentId: null, isCompanyAdmin: true, status: 'active', mustChangePassword: false, lastLoginAt: null, managerId: null, title: null, baseSalary: null, createdAt: new Date() },
    ]);
    const positions = new FakeRepo<Position>([
      { id: 10, companyId: 1, departmentId: null, name: '运营专员', workspaceType: 'operations', sortOrder: 0, level: 'staff', supervisorPositionId: null, description: null, status: 'active' },
    ]);
    const positionPermissions = new FakeRepo<PositionPermission>([
      { id: 1, positionId: 10, permission: 'workbench.todos.view' },
    ]);
    const overrides = new FakeRepo<UserPermissionOverride>([]);
    deps = new FakeRepo<Department>([
      { id: 1, companyId: 1, parentId: null, name: '公司1-运营', sortOrder: 0, status: 'active', createdAt: new Date() },
      { id: 2, companyId: 2, parentId: null, name: '公司2-财务', sortOrder: 0, status: 'active', createdAt: new Date() },
    ]);
    audits = new FakeRepo<AuditLog>([]);

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'x'.repeat(40), signOptions: { expiresIn: '1h' } })],
      controllers: [HealthController, AuthController, OrgController, ProbeController],
      providers: [
        AuthService,
        OrgService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: getRepositoryToken(Company), useValue: companies },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Position), useValue: positions },
        { provide: getRepositoryToken(PositionPermission), useValue: positionPermissions },
        { provide: getRepositoryToken(UserPermissionOverride), useValue: overrides },
        { provide: getRepositoryToken(Department), useValue: deps },
        { provide: getRepositoryToken(AuditLog), useValue: audits },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const get = (path: string, token?: string) =>
    fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const login = async (companyCode: string, account: string, password = 'correct-password-1') => {
    const res = await post('/auth/login', { companyCode, account, password });
    return res.status === 201 ? ((await res.json()) as { accessToken: string }).accessToken : null;
  };

  it('健康检查无需登录', async () => {
    expect((await get('/health')).status).toBe(200);
  });

  it('登录失败统一提示，不泄露哪一项错', async () => {
    for (const body of [
      { companyCode: 'demo', account: 'admin', password: 'wrong-password' },
      { companyCode: 'demo', account: 'nobody', password: 'correct-password-1' },
      { companyCode: 'nope', account: 'admin', password: 'correct-password-1' },
      { companyCode: 'demo', account: 'gone', password: 'correct-password-1' },
    ]) {
      const res = await post('/auth/login', body);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { message: string }).message).toBe('公司代码、账号或密码不正确');
    }
  });

  it('登录后 /auth/me 返回权限，用于前端过滤菜单', async () => {
    const token = (await login('demo', 'ops'))!;
    const me = (await (await get('/auth/me', token)).json()) as { name: string; permissions: { allow: string[] } };
    expect(me.name).toBe('运营');
    expect(me.permissions.allow).toEqual(['workbench.todos.view']);
  });

  it('没有令牌或令牌无效返回 401', async () => {
    expect((await get('/auth/me')).status).toBe(401);
    expect((await get('/auth/me', 'garbage')).status).toBe(401);
  });

  it('没有声明权限策略的接口默认拒绝，声明了的才放行', async () => {
    const token = (await login('demo', 'admin'))!;
    expect((await get('/probe/undeclared', token)).status).toBe(403);
    expect((await get('/probe/declared', token)).status).toBe(200);
    expect((await get('/probe/public')).status).toBe(200);
  });

  it('权限不足返回 403，管理员可访问', async () => {
    const ops = (await login('demo', 'ops'))!;
    expect((await get('/org/departments', ops)).status).toBe(403);
    const admin = (await login('demo', 'admin'))!;
    expect((await get('/org/departments', admin)).status).toBe(200);
  });

  it('多公司隔离：只能看到自己公司的部门', async () => {
    const t1 = (await login('demo', 'admin'))!;
    const t2 = (await login('other', 'boss2'))!;
    const a = (await (await get('/org/departments', t1)).json()) as Array<{ name: string }>;
    const b = (await (await get('/org/departments', t2)).json()) as Array<{ name: string }>;
    expect(a.map((d) => d.name)).toEqual(['公司1-运营']);
    expect(b.map((d) => d.name)).toEqual(['公司2-财务']);
  });

  it('不能把部门挂到别家公司的部门下；操作人和公司只取自令牌，并写入审计', async () => {
    const t1 = (await login('demo', 'admin'))!;
    const bad = await post('/org/departments', { name: '越权', parentId: 2 }, t1);
    expect(bad.status).toBe(400);

    const ok = await post('/org/departments', { name: '新部门', parentId: 1 }, t1);
    expect(ok.status).toBe(201);
    const audit = audits.rows.at(-1)!;
    expect(audit).toMatchObject({ companyId: 1, actorId: 1, action: 'department.create' });
  });

  it('请求体里夹带 companyId / actorId 会被直接拒绝', async () => {
    const t1 = (await login('demo', 'admin'))!;
    const res = await post('/org/departments', { name: 'x', companyId: 2, actorId: 99 }, t1);
    expect(res.status).toBe(400);
  });

  it('修改密码：旧密码必须正确、新密码至少 10 位，改完旧密码失效', async () => {
    const token = (await login('other', 'boss2'))!;
    expect((await post('/auth/change-password', { oldPassword: 'bad', newPassword: 'new-password-123' }, token)).status).toBe(400);
    expect((await post('/auth/change-password', { oldPassword: 'correct-password-1', newPassword: 'short' }, token)).status).toBe(400);
    expect((await post('/auth/change-password', { oldPassword: 'correct-password-1', newPassword: 'correct-password-1' }, token)).status).toBe(400);
    expect((await post('/auth/change-password', { oldPassword: 'correct-password-1', newPassword: 'new-password-123' }, token)).status).toBe(201);
    expect(await login('other', 'boss2', 'correct-password-1')).toBeNull();
    expect(await login('other', 'boss2', 'new-password-123')).not.toBeNull();
    expect(audits.rows.at(-1)).toMatchObject({ action: 'user.change_password', actorId: 4 });
  });

  it('停用账号后，已签发的令牌立即失效', async () => {
    const token = (await login('demo', 'ops'))!;
    expect((await get('/auth/me', token)).status).toBe(200);
    const usersRepo = app.get(getRepositoryToken(User)) as FakeRepo<User>;
    await usersRepo.update({ id: 2 }, { status: 'disabled' });
    expect((await get('/auth/me', token)).status).toBe(401);
  });
});
