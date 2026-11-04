import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PermissionsGuard } from '../common/permissions.guard';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';
import { DataToolsService } from './data-tools.service';
import { GridSaveService } from './grid-save.service';

describe('分级资料完整排序 HTTP', () => {
  let app: INestApplication, url: string;
  const service = { reorderCategories: jest.fn().mockResolvedValue({ ok: true }) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ResourcesController], providers: [
      { provide: ResourcesService, useValue: service }, { provide: DataToolsService, useValue: {} }, { provide: GridSaveService, useValue: {} }, { provide: APP_GUARD, useClass: PermissionsGuard },
    ] }).compile();
    app = module.createNestApplication();
    app.use((req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => {
      if (req.headers.authorization) req.user = { id: 4, companyId: 2, name: '合成员工', permissions: { isCompanyAdmin: false, allow: [`resource.finance-labor-costs.${req.headers.authorization === 'Bearer edit' ? 'edit' : 'view'}`], deny: [] } };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); url = await app.getUrl();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => { await app?.close(); });
  const send = (body: unknown, auth = 'edit') => fetch(`${url}/resources/finance-labor-categories/reorder`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });

  it('继承人力修改权限且完整接收超过500个ID，不在DTO层截断', async () => {
    const orderedIds = Array.from({ length: 501 }, (_, index) => index + 1);
    expect((await send({ orderedIds })).status).toBe(201);
    expect(service.reorderCategories).toHaveBeenCalledWith(expect.objectContaining({ id: 4, companyId: 2 }), 'finance-labor-categories', orderedIds);
  });
  it('未登录/只有查看拒绝，非整数和外带公司参数仍由白名单拒绝', async () => {
    expect((await send({ orderedIds: [1, 2] }, '')).status).toBe(403);
    expect((await send({ orderedIds: [1, 2] }, 'view')).status).toBe(403);
    expect((await send({ orderedIds: [1, 2.5] })).status).toBe(400);
    expect((await send({ orderedIds: [1, 2], companyId: 99 })).status).toBe(400);
    expect(service.reorderCategories).not.toHaveBeenCalled();
  });
});
