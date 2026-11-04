import { PROVINCES } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { AiProviderService } from './ai-providers.service';
import { IntegrationSettingsService } from './integration-settings.service';
import { OcrService } from './ocr.service';

const user: AuthUser = { id: 4, companyId: 2, name: '合成员工', permissions: { isCompanyAdmin: false, allow: ['resource.finance-express-prices.edit'], deny: [] } };
describe('快递识别本次显式模型', () => {
  it('可用目录不返回服务商端点/密钥，且只读取本公司', async () => {
    const ai = { defaults: jest.fn().mockResolvedValue({ providers: [{ id: 1, name: '合成', status: 'active', models: ['gpt-synthetic', 'text-embedding-3-small', 'gpt-image-1'], baseUrl: 'private-endpoint', apiKey: 'private-key' }, { id: 2, name: '停用', status: 'inactive', models: ['m2'] }], scopes: [{ key: 'express_price_recognition', current: { key: 'express_price_recognition', providerId: 1, modelId: 'gpt-synthetic' } }] }) };
    const ocr = new OcrService({} as IntegrationSettingsService, ai as unknown as AiProviderService);
    expect(await ocr.expressRecognitionOptions(user)).toEqual({ providers: [{ id: 1, name: '合成', status: 'active', models: ['gpt-synthetic'] }], current: { providerId: 1, modelId: 'gpt-synthetic' } });
    expect(ai.defaults).toHaveBeenCalledWith(2);
    await expect(ocr.expressRecognitionOptions({ ...user, permissions: { isCompanyAdmin: false, allow: [], deny: [] } })).rejects.toThrow(/没有权限/);
  });
  it('调用冻结本次配置，即使场景默认随后改变；只能写快递场景', async () => {
    const ai = { resolveSelectedVision: jest.fn().mockResolvedValue({ baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-only', model: 'selected', enabled: true }), setDefault: jest.fn().mockResolvedValue({ ok: true }), resolveVision: jest.fn().mockResolvedValue({ model: 'other' }) };
    const ocr = new OcrService({} as IntegrationSettingsService, ai as unknown as AiProviderService);
    const factory = jest.fn().mockReturnValue({ recognizeText: async () => JSON.stringify({ priceRows: [{ province: '广东', price1kg: 3 }] }) });
    ocr.visionFactory = factory;
    const file = { originalname: 'p.csv', buffer: Buffer.from('synthetic'), size: 9 };
    const result = await ocr.recognizeExpressDocument(user, file, 'price_table', PROVINCES, { providerId: 1, modelId: 'selected' });
    expect(result.modelName).toBe('selected');
    expect(ai.resolveSelectedVision).toHaveBeenCalledWith(2, 1, 'selected');
    expect(ai.setDefault).toHaveBeenCalledWith(user, 'express_price_recognition', 1, 'selected');
    expect(ai.resolveVision).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ model: 'selected' }));
    await expect(ocr.recognizeExpressDocument(user, file, 'price_table', PROVINCES, { providerId: 1 })).rejects.toThrow(/请选择/);
  });
});
