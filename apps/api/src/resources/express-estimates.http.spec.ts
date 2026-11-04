import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { PermissionsGuard } from '../common/permissions.guard';
import { OcrService } from '../integrations/ocr.service';
import { ExpressController } from './express.controller';
import { ExpressService } from './express.service';

describe('预估快递费批量调整 HTTP 权限', () => {
  let app: INestApplication, url: string;
  const express = { saveOverrides: jest.fn().mockResolvedValue({ rows: [] }), recalculate: jest.fn().mockResolvedValue({ rows: [] }) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ExpressController], providers: [{ provide: ExpressService, useValue: express }, { provide: OcrService, useValue: {} }, { provide: APP_GUARD, useClass: PermissionsGuard }] }).compile();
    app = module.createNestApplication();
    app.use((req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => {
      const role = req.headers.authorization;
      if (role) req.user = { id: 4, companyId: 2, name: '合成员工', permissions: { isCompanyAdmin: false, allow: role === 'Bearer both' ? ['resource.finance-freight-overrides.edit', 'product.cost.edit'] : role === 'Bearer resource' ? ['resource.finance-freight-overrides.edit'] : ['product.cost.edit'], deny: [] } };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); url = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); }); beforeEach(() => jest.clearAllMocks());
  const send = (body: unknown, auth = 'both') => fetch(`${url}/finance/express/estimates/overrides`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
  const body = { revision: 1, rows: [{ weightFrom: 0, weightTo: 0.5, amount: 0 }] };
  it('必须同时有成本编辑与覆盖编辑，不能只凭其中一项或未登录保存', async () => {
    for (const role of ['', 'resource', 'cost']) expect((await send(body, role)).status).toBe(403);
    expect(express.saveOverrides).not.toHaveBeenCalled();
    expect((await send(body)).status).toBe(200);
    expect(express.saveOverrides).toHaveBeenCalledWith(expect.objectContaining({ id: 4, companyId: 2 }), 1, body.rows);
  });
  it('拒绝公司伪造、负数/小数分、额外行字段和无revision请求，允许null清空', async () => {
    for (const invalid of [{ ...body, companyId: 99 }, { rows: body.rows }, { ...body, rows: [{ ...body.rows[0], amount: -1 }] }, { ...body, rows: [{ ...body.rows[0], amount: 1.25 }] }, { ...body, rows: [{ ...body.rows[0], companyId: 99 }] }]) expect((await send(invalid)).status).toBe(400);
    expect(express.saveOverrides).not.toHaveBeenCalled();
    expect((await send({ revision: 2, rows: [{ weightFrom: 0, weightTo: 0.5, amount: null }] })).status).toBe(200);
    expect(express.saveOverrides).toHaveBeenCalledWith(expect.objectContaining({ companyId: 2 }), 2, [{ weightFrom: 0, weightTo: 0.5, amount: null }]);
  });
});
