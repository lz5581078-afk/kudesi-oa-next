import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { CONFIRM_TRANSFER_PERMISSION } from '@kudesi/shared';
import { PermissionsGuard } from '../common/permissions.guard';
import { FilesService } from '../integrations/files.service';
import { FinanceDocumentsController } from './finance-documents.controller';
import { FinanceDocumentsService } from './finance-documents.service';
import { FinanceVoucherHintsService } from './finance-voucher-hints.service';

/** 转款确认入账与新字段的 HTTP/DTO/权限守卫（业务事务另用 MySQL 测试）。登录人由测试中间件模拟。 */
describe('转款确认入账 HTTP', () => {
  let app: INestApplication, url: string;
  const docs = { confirmTransfer: jest.fn().mockResolvedValue({ transitStatus: 'confirmed' }), createDraft: jest.fn().mockResolvedValue({ id: 1 }) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [FinanceDocumentsController], providers: [
      { provide: FinanceDocumentsService, useValue: docs }, { provide: FilesService, useValue: {} }, { provide: FinanceVoucherHintsService, useValue: {} }, { provide: APP_GUARD, useClass: PermissionsGuard },
    ] }).compile();
    app = module.createNestApplication();
    app.use((req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => {
      if (req.headers.authorization) req.user = { id: 4, companyId: 2, name: '登录员工', permissions: { isCompanyAdmin: false, allow: [req.headers.authorization === 'Bearer confirm' ? CONFIRM_TRANSFER_PERMISSION : 'finance.docs.post', 'finance.docs.create'], deny: [] } };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); url = await app.getUrl();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => { await app?.close(); });
  const send = (path: string, data: unknown, auth = 'confirm') => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(data) });

  it('确认入账需要独立权限：未登录、只有过账权限都拒绝，服务不会被调用', async () => {
    expect((await send('/finance/docs/5/confirm-transfer', {}, '')).status).toBe(403);
    expect((await send('/finance/docs/5/confirm-transfer', {}, 'posting')).status).toBe(403);
    expect(docs.confirmTransfer).not.toHaveBeenCalled();
  });
  it.each([{ date: '2026/03/01' }, { note: '字'.repeat(201) }, { companyId: 99 }, { actorId: 4 }, { confirmedBy: 9 }])('DTO 拒绝非法或越权字段 %j', async (patch) => {
    expect((await send('/finance/docs/5/confirm-transfer', patch)).status).toBe(400);
    expect(docs.confirmTransfer).not.toHaveBeenCalled();
  });
  it('正常请求：身份只取登录令牌，日期和备注交给服务', async () => {
    expect((await send('/finance/docs/5/confirm-transfer', { date: '2026-03-01', note: '回单已核对' })).status).toBe(201);
    expect(docs.confirmTransfer).toHaveBeenCalledWith(expect.objectContaining({ companyId: 2, id: 4 }), 5, { date: '2026-03-01', note: '回单已核对' });
  });
  it('新建单据的新字段有白名单：手续费不能为负、承担方只能 out/in，状态字段不能直接传', async () => {
    const base = { type: 'transfer', date: '2026-03-01' };
    expect((await send('/finance/docs', { ...base, feeCents: -1, feeBearer: 'out' }, 'posting')).status).toBe(400);
    expect((await send('/finance/docs', { ...base, feeCents: 5, feeBearer: 'both' }, 'posting')).status).toBe(400);
    expect((await send('/finance/docs', { ...base, transitStatus: 'confirmed' }, 'posting')).status).toBe(400);
    expect((await send('/finance/docs', { ...base, confirmedBy: 3 }, 'posting')).status).toBe(400);
    expect((await send('/finance/docs', { ...base, handlerId: 0 }, 'posting')).status).toBe(400);
    expect(docs.createDraft).not.toHaveBeenCalled();
    expect((await send('/finance/docs', { ...base, feeCents: 5, feeBearer: 'in', inTransit: true, handlerId: 3, discountCents: 0, accounts: [{ role: 'in', bankAccountId: 1, amountCents: 5 }] }, 'posting')).status).toBe(201);
    expect(docs.createDraft).toHaveBeenCalledTimes(1);
  });
});
