import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { PermissionsGuard } from '../common/permissions.guard';
import { OcrService } from '../integrations/ocr.service';
import { ExpressController } from './express.controller';
import { ExpressService } from './express.service';

describe('快递识别选择 HTTP 边界', () => {
  let app: INestApplication, url: string;
  const ocr = { expressRecognitionOptions: jest.fn().mockResolvedValue({ providers: [] }), recognizeExpressDocument: jest.fn().mockResolvedValue({ rows: [] }) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ExpressController], providers: [{ provide: ExpressService, useValue: { versionDetail: jest.fn().mockResolvedValue({}) } }, { provide: OcrService, useValue: ocr }, { provide: APP_GUARD, useClass: PermissionsGuard }] }).compile();
    app = module.createNestApplication();
    app.use((req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => { if (req.headers.authorization) req.user = { id: 4, companyId: 2, name: '合成员工', permissions: { isCompanyAdmin: false, allow: [req.headers.authorization === 'Bearer edit' ? 'resource.finance-express-prices.edit' : 'resource.finance-express-prices.view'], deny: [] } }; next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); url = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => jest.clearAllMocks());
  const send = (body: unknown) => fetch(`${url}/finance/express/versions/3/recognize-price`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer edit' }, body: JSON.stringify(body) });
  it('模型目录只允许价格编辑人读取，身份从认证取值', async () => {
    expect((await fetch(`${url}/finance/express/ai-models`)).status).toBe(403);
    expect((await fetch(`${url}/finance/express/ai-models`, { headers: { authorization: 'Bearer view' } })).status).toBe(403);
    expect(ocr.expressRecognitionOptions).not.toHaveBeenCalled();
    expect((await fetch(`${url}/finance/express/ai-models`, { headers: { authorization: 'Bearer edit' } })).status).toBe(200);
    expect(ocr.expressRecognitionOptions).toHaveBeenCalledWith(expect.objectContaining({ id: 4, companyId: 2 }));
  });
  it('拒绝客户端地址、密钥、公司及任意场景，允许指定服务商ID和模型ID', async () => {
    for (const field of ['baseUrl', 'apiKey', 'companyId', 'scope']) expect((await send({ providerId: 1, modelId: 'm1', [field]: 'untrusted' })).status).toBe(400);
    expect(ocr.recognizeExpressDocument).not.toHaveBeenCalled();
    expect((await send({ providerId: '1', modelId: 'm1' })).status).toBe(200);
    expect(ocr.recognizeExpressDocument).toHaveBeenCalledWith(expect.objectContaining({ companyId: 2 }), undefined, 'price_table', expect.any(Array), expect.objectContaining({ providerId: 1, modelId: 'm1' }));
  });
});
