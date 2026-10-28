import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PermissionsGuard } from '../common/permissions.guard';
import { DataToolsService } from './data-tools.service';
import { GridSaveService } from './grid-save.service';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';

/** 真实 DTO 白名单 + 权限守卫；业务规则另见 grid-save.db.spec.ts */
describe('表格编辑批量保存 HTTP', () => {
  let app: INestApplication, url: string;
  const grid = { save: jest.fn().mockResolvedValue({ results: [], saved: 0, failed: 0 }) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ResourcesController], providers: [
      { provide: ResourcesService, useValue: {} }, { provide: DataToolsService, useValue: {} }, { provide: GridSaveService, useValue: grid }, { provide: APP_GUARD, useClass: PermissionsGuard },
    ] }).compile();
    app = module.createNestApplication();
    app.use((req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => {
      if (req.headers.authorization) req.user = { id: 4, companyId: 2, name: '员工', permissions: { isCompanyAdmin: false, allow: req.headers.authorization === 'Bearer edit' ? ['resource.software.edit'] : ['resource.software.view'], deny: [] } };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); url = await app.getUrl();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => { await app?.close(); });
  const post = (data: unknown, auth = 'edit', type = 'software') => fetch(`${url}/resources/${type}/grid-save`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(data) });

  it('未登录或只有查看权限被拒绝', async () => {
    expect((await post({ updates: [] }, '')).status).toBe(403);
    expect((await post({ updates: [] }, 'view')).status).toBe(403);
    expect(grid.save).not.toHaveBeenCalled();
  });
  it.each([
    { companyId: 9 },
    { updates: [{ id: 1, data: {}, companyId: 9 }] },
    { updates: [{ id: 'x', data: {} }] },
    { updates: [{ id: 1 }] },
    { creates: [{ data: {} }] },
    { archives: [{ id: 1 }] },
    { updates: Array.from({ length: 201 }, (_, i) => ({ id: i + 1, data: {} })) },
  ])('DTO 拒绝非法或多余字段 %#', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(grid.save).not.toHaveBeenCalled();
  });
  it('合法请求交给服务，身份只来自令牌', async () => {
    expect((await post({ updates: [{ id: 1, version: 'v', data: { a: 1 } }], creates: [{ clientId: 'c', data: {} }], archives: [{ id: 2, reason: '原因' }] })).status).toBe(201);
    expect(grid.save).toHaveBeenCalledWith(expect.objectContaining({ companyId: 2, id: 4 }), 'software', expect.anything());
  });
  it('不存在的资料类型 404', async () => {
    expect((await post({ updates: [] }, 'edit', 'nope')).status).toBe(404);
  });
});
