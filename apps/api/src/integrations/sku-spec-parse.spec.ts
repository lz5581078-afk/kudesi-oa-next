import { AuthUser } from '../common/auth.decorators';
import { AiProviderService } from './ai-providers.service';
import { IntegrationSettingsService } from './integration-settings.service';
import { OcrService } from './ocr.service';

const user: AuthUser = { id: 4, companyId: 2, name: '合成员工', permissions: { isCompanyAdmin: false, allow: ['flow.apply.view'], deny: [] } };
const make = (reply: string, enabled = true, selected = true, deepseek = false) => {
  const settings = { getVision: jest.fn().mockResolvedValue(null) };
  const ai = { resolveVision: jest.fn().mockResolvedValue(selected ? { baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-only', model: 'm', enabled } : null), resolveDeepseek: jest.fn().mockResolvedValue(deepseek ? { baseUrl: 'https://api.deepseek.com', apiKey: 'synthetic-only', model: 'deepseek-flash', enabled: true } : null) };
  const ocr = new OcrService(settings as unknown as IntegrationSettingsService, ai as unknown as AiProviderService);
  const recognizeText = jest.fn().mockResolvedValue(reply);
  ocr.visionFactory = () => ({ recognizeText }) as never;
  return { ocr, ai, recognizeText };
};

describe('SKU 申请 AI 一键填写：读规格名称重量', () => {
  it('只取合法的重量，其余留空；按序号对应，用的是该场景的模型', async () => {
    const { ocr, ai, recognizeText } = make('```json\n{"items":[{"index":1,"mainGrams":2500,"giftGrams":"200"},{"index":0,"mainGrams":500,"giftGrams":null},{"index":2,"mainGrams":-5,"giftGrams":"abc"}]}\n```');
    const out = await ocr.parseSkuSpecNames(user, ['500g', '5斤送200g', '乱写']);
    expect(out).toEqual([{ name: '500g', mainGrams: 500, giftGrams: null }, { name: '5斤送200g', mainGrams: 2500, giftGrams: 200 }, { name: '乱写', mainGrams: null, giftGrams: null }]);
    expect(ai.resolveVision).toHaveBeenCalledWith(2, 'sku_spec_parse');
    expect(recognizeText.mock.calls[0][0]).toContain('0: 500g');
  });
  it('没有权限、没启用模型、AI 返回乱码都给明确提示，不写任何数据', async () => {
    await expect(make('{}').ocr.parseSkuSpecNames({ ...user, permissions: { isCompanyAdmin: false, allow: [], deny: [] } }, ['a'])).rejects.toThrow(/没有权限/);
    await expect(make('{}', false).ocr.parseSkuSpecNames(user, ['a'])).rejects.toThrow(/AI 设置/);
    expect(await make('我不知道').ocr.parseSkuSpecNames(user, ['a'])).toEqual([{ name: 'a', mainGrams: null, giftGrams: null }]);
  });
  it('场景没单独选模型时，直接用公司已配置的 DeepSeek 官方接口', async () => {
    const seen: string[] = [];
    const ai = { resolveVision: jest.fn().mockResolvedValue(null), resolveDeepseek: jest.fn().mockResolvedValue({ baseUrl: 'https://api.deepseek.com', apiKey: 'synthetic-only', model: 'deepseek-flash', enabled: true }) };
    const ocr = new OcrService({ getVision: jest.fn().mockResolvedValue(null) } as unknown as IntegrationSettingsService, ai as unknown as AiProviderService);
    ocr.visionFactory = (cfg) => { seen.push(`${cfg.baseUrl}|${cfg.model}`); return { recognizeText: async () => '{"items":[{"index":0,"mainGrams":300,"giftGrams":null}]}' } as never; };
    expect(await ocr.parseSkuSpecNames(user, ['300g'])).toEqual([{ name: '300g', mainGrams: 300, giftGrams: null }]);
    expect(seen).toEqual(['https://api.deepseek.com|deepseek-flash']);
  });
});
