import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { OPENING_PREPAYMENT_PERMISSION } from '@kudesi/shared';
import { PermissionsGuard } from '../common/permissions.guard';
import { FilesService } from '../integrations/files.service';
import { FinanceDocumentsController } from './finance-documents.controller';
import { FinanceDocumentsService } from './finance-documents.service';

/** 实际 HTTP/DTO/权限守卫；业务事务另用 MySQL 测试。登录人由测试中间件模拟。 */
describe('期初预付登记 HTTP', () => {
  let app: INestApplication, url: string;
  const docs = { registerOpeningPrepayment: jest.fn().mockResolvedValue({ status: 'posted' }), checkOpeningPrepayment: jest.fn().mockResolvedValue(undefined), openingVoucher: jest.fn().mockResolvedValue({ id: 3 }) };
  const files = { putBlob: jest.fn().mockResolvedValue({ id: 3 }), urlOf: jest.fn().mockResolvedValue({ url: 'https://example.invalid/receipt' }) };
  const body = { reason: '回单已核对', fileIds: [3], confirmed: true };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [FinanceDocumentsController], providers: [
      { provide: FinanceDocumentsService, useValue: docs }, { provide: FilesService, useValue: files }, { provide: APP_GUARD, useClass: PermissionsGuard },
    ] }).compile();
    app = module.createNestApplication();
    app.use((req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => {
      if (req.headers.authorization) req.user = { id: 4, companyId: 2, name: '登录员工', permissions: { isCompanyAdmin: false, allow: [req.headers.authorization === 'Bearer opening' ? OPENING_PREPAYMENT_PERMISSION : 'finance.docs.post'], deny: [] } };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); url = await app.getUrl();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => { await app?.close(); });
  const post = (data: unknown, auth = 'opening') => fetch(url + '/finance/docs/5/opening-prepayment', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(data) });

  it('独立登记权限由守卫校验，未登录及只有过账权限均拒绝', async () => {
    expect((await post(body, '')).status).toBe(403);
    expect((await post(body, 'posting')).status).toBe(403);
    expect(docs.registerOpeningPrepayment).not.toHaveBeenCalled();
  });
  it.each([{ confirmed: false }, { confirmed: 'true' }, { reason: '' }, { reason: '字'.repeat(501) }, { fileIds: [] }, { fileIds: [3, 3] }, { fileIds: [-1] }, { companyId: 99 }, { actorId: 99 }])('DTO 拒绝非法或越权字段 %j', async (patch) => {
    expect((await post({ ...body, ...patch })).status).toBe(400);
    expect(docs.registerOpeningPrepayment).not.toHaveBeenCalled();
  });
  it('身份只传递测试登录上下文，正常请求交给服务', async () => {
    expect((await post(body)).status).toBe(201);
    expect(docs.registerOpeningPrepayment).toHaveBeenCalledWith(expect.objectContaining({ companyId: 2, id: 4 }), 5, body);
  });
  it('上传沿用文件服务，先检查单据及独立权限', async () => {
    const form = () => { const f = new FormData(); f.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), '回单.pdf'); return f; };
    expect((await fetch(url + '/finance/docs/5/opening-vouchers', { method: 'POST', headers: { authorization: 'Bearer posting' }, body: form() })).status).toBe(403);
    expect(files.putBlob).not.toHaveBeenCalled();
    expect((await fetch(url + '/finance/docs/5/opening-vouchers', { method: 'POST', headers: { authorization: 'Bearer opening' }, body: form() })).status).toBe(201);
    expect(docs.checkOpeningPrepayment).toHaveBeenCalledWith(expect.objectContaining({ companyId: 2 }), 5);
    expect(files.putBlob).toHaveBeenCalledWith(2, 4, 'opening-prepayment-voucher', 'voucher', expect.objectContaining({ size: 8 }));
    expect(docs.checkOpeningPrepayment.mock.invocationCallOrder[0]).toBeLessThan(files.putBlob.mock.invocationCallOrder[0]);
  });
});
