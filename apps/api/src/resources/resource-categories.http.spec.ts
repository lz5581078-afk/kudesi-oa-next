import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PermissionsGuard } from '../common/permissions.guard';
import { ResourceCategoriesController } from './resource-categories.controller';
import { ResourceCategoriesService } from './resource-categories.service';

/** 真实 DTO 白名单 + 权限守卫（默认拒绝）；业务规则另见 resource-categories.db.spec.ts */
describe('页签分类管理 HTTP', () => {
  let app: INestApplication, url: string;
  const svc = { options: jest.fn().mockResolvedValue({}), list: jest.fn().mockResolvedValue({}), create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}), reorder: jest.fn().mockResolvedValue({}), remove: jest.fn().mockResolvedValue({}) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ResourceCategoriesController], providers: [{ provide: ResourceCategoriesService, useValue: svc }, { provide: APP_GUARD, useClass: PermissionsGuard }] }).compile();
    app = module.createNestApplication();
    app.use((req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => {
      if (req.headers.authorization) req.user = { id: 4, companyId: 2, name: '员工', permissions: { isCompanyAdmin: false, allow: req.headers.authorization === 'Bearer manage' ? ['resource.categories.manage', 'resource.qualifications.view'] : ['resource.qualifications.view'], deny: [] } };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); url = await app.getUrl();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => { await app?.close(); });
  const call = (method: string, path: string, body?: unknown, auth = 'manage') => fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('未登录、只有查看权限的人不能管理（默认拒绝）；选项接口登录即可', async () => {
    for (const [m, p, b] of [['GET', '/resources/qualifications/categories'], ['POST', '/resources/qualifications/categories', { name: 'x' }], ['PATCH', '/resources/qualifications/categories/general', { name: 'x' }], ['DELETE', '/resources/qualifications/categories/c_abcd1234'], ['POST', '/resources/qualifications/categories/reorder', { values: ['a'] }]] as const) {
      expect((await call(m, p, b, '')).status).toBe(403);
      expect((await call(m, p, b, 'view')).status).toBe(403);
    }
    expect(svc.list).not.toHaveBeenCalled();
    expect((await call('GET', '/resources/category-options', undefined, 'view')).status).toBe(200);
    expect((await call('GET', '/resources/category-options', undefined, '')).status).toBe(403);
  });
  it.each([
    ['POST', '/resources/qualifications/categories', { name: 'x', companyId: 9 }],
    ['POST', '/resources/qualifications/categories', { name: 'x', value: 'c_hack1234' }],
    ['POST', '/resources/qualifications/categories', {}],
    ['POST', '/resources/qualifications/categories', { name: 'x'.repeat(61) }],
    ['PATCH', '/resources/qualifications/categories/general', { name: 'x', value: 'other' }],
    ['PATCH', '/resources/qualifications/categories/general', { hidden: 'yes' }],
    ['PATCH', '/resources/qualifications/categories/bad%20value', { name: 'x' }],
    ['DELETE', '/resources/qualifications/categories/a%27b', undefined],
    ['POST', '/resources/qualifications/categories/reorder', { values: [] }],
    ['POST', '/resources/qualifications/categories/reorder', { values: ['a'], companyId: 1 }],
  ] as const)('DTO 拒绝非法或多余字段 %#', async (m, p, b) => {
    expect((await call(m, p, b)).status).toBe(400);
    expect(svc.create).not.toHaveBeenCalled();
    expect(svc.update).not.toHaveBeenCalled();
    expect(svc.remove).not.toHaveBeenCalled();
    expect(svc.reorder).not.toHaveBeenCalled();
  });
  it('合法请求交给服务，公司和操作人只来自令牌', async () => {
    expect((await call('POST', '/resources/qualifications/categories', { name: '新分类' })).status).toBe(201);
    expect(svc.create).toHaveBeenCalledWith(expect.objectContaining({ companyId: 2, id: 4 }), 'qualifications', '新分类');
    expect((await call('PATCH', '/resources/qualifications/categories/c_abcd1234', { hidden: true })).status).toBe(200);
    expect(svc.update).toHaveBeenCalledWith(expect.objectContaining({ companyId: 2 }), 'qualifications', 'c_abcd1234', { name: undefined, hidden: true });
    expect((await call('POST', '/resources/qualifications/categories/reorder', { values: ['a', 'b'] })).status).toBe(200);
    expect((await call('DELETE', '/resources/qualifications/categories/c_abcd1234')).status).toBe(200);
  });
});
