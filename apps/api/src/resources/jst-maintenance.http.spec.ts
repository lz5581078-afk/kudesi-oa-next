import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { PermissionsGuard } from '../common/permissions.guard';
import { JstMaintenanceController } from './jst-maintenance.controller';
import { JstMaintenanceService } from './jst-maintenance.service';

describe('普通商品资料维护 HTTP 身份、权限与白名单', () => {
  let app: INestApplication, url: string;
  const service = { upload: jest.fn().mockResolvedValue({ id: 1, queued: true }), options: jest.fn().mockResolvedValue({ categories: [] }), checkDuplicate: jest.fn().mockResolvedValue({ matches: [] }), logs: jest.fn().mockResolvedValue({ rows: [] }) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [JstMaintenanceController], providers: [{ provide: JstMaintenanceService, useValue: service }, { provide: APP_GUARD, useClass: PermissionsGuard }] }).compile();
    app = module.createNestApplication();
    app.use((req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => {
      const role = req.headers.authorization;
      if (role) req.user = { id: 41, companyId: 72, name: '合成人员', permissions: { isCompanyAdmin: role === 'Bearer admin', allow: role === 'Bearer both' ? ['finance.jst-maintenance.view', 'product.cost.edit'] : role === 'Bearer view' ? ['finance.jst-maintenance.view'] : ['product.cost.edit'], deny: [] } }; next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.listen(0, '127.0.0.1'); url = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); }); beforeEach(() => jest.clearAllMocks());
  const send = (path: string, body: unknown, role = 'admin') => fetch(`${url}/finance/jst-maintenance/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(role ? { authorization: `Bearer ${role}` } : {}) }, body: JSON.stringify(body) });
  const body = { form: { skuId: 'SYNTHETIC-SKU' }, signature: 'signed-result', confirmed: true };
  it('上传必须同时具备资料维护与成本编辑，查重与记录不泄漏成本字段', async () => {
    for (const role of ['', 'view', 'cost']) expect((await send('upload', body, role)).status).toBe(403);
    expect(service.upload).not.toHaveBeenCalled();
    expect((await send('upload', body)).status).toBe(200);
    expect(service.upload).toHaveBeenCalledWith(expect.objectContaining({ id: 41, companyId: 72 }), body.form, { signature: body.signature, confirmed: true });
  });
  it('公司人员只取令牌，拒绝额外身份/目标账号、缺签名和伪造确认值', async () => {
    for (const invalid of [{ ...body, companyId: 999 }, { ...body, actorId: 999 }, { ...body, targetKey: 'another-target' }, { form: body.form, confirmed: true }, { ...body, confirmed: 'yes' }]) expect((await send('upload', invalid)).status).toBe(400);
    expect(service.upload).not.toHaveBeenCalled();
    expect((await send('check-duplicate', { skuId: 'A', styleId: 'B', name: 'C', companyId: 999 })).status).toBe(400);
    expect(service.checkDuplicate).not.toHaveBeenCalled();
  });
  it('记录默认30条，拒绝查询里伪造公司或人员', async () => {
    const headers = { authorization: 'Bearer view' };
    expect((await fetch(`${url}/finance/jst-maintenance/logs`, { headers })).status).toBe(200);
    expect(service.logs).toHaveBeenCalledWith(expect.objectContaining({ companyId: 72 }), { keyword: undefined, page: 1, pageSize: 30 });
    expect((await fetch(`${url}/finance/jst-maintenance/logs?companyId=999`, { headers })).status).toBe(400);
  });
});
