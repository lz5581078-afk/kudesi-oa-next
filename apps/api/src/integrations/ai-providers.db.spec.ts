/** AI 服务商、模型同步、识别场景默认模型的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=... npx jest ai-providers */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { AiProviderService, inferModel } from './ai-providers.service';
import { OcrService } from './ocr.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

describe('inferModel', () => {
  it('按名字推断调用方式和能力', () => {
    expect(inferModel('gpt-4o')).toEqual({ endpointType: 'chat-completions', capabilities: ['text', 'vision'] });
    expect(inferModel('gpt-5-mini').endpointType).toBe('responses');
    expect(inferModel('text-embedding-3-small').endpointType).toBe('embeddings');
    expect(inferModel('dall-e-3').endpointType).toBe('images');
    expect(inferModel('sora-2').endpointType).toBe('videos');
  });
});

d('AI 服务商（真实数据库）', () => {
  let ds: DataSource, ai: AiProviderService, admin: AuthUser, other: AuthUser;
  let calls: string[];
  const mk = async (tag: string): Promise<AuthUser> => {
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `ai${tag}${crypto.randomBytes(4).toString('hex')}`, name: `AI${tag}`, status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'a', passwordHash: 'x', name: '管理员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    return { id: u.id, companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  };
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    ai = new AiProviderService(ds, s.crypto);
    calls = [];
    ai.fetchModels = async (url, key) => { calls.push(`${url}|${key}`); return [{ id: 'gpt-4o', ownedBy: 'openai' }, { id: 'text-embedding-3-small' }]; };
    admin = await mk('a'); other = await mk('b');
  });
  afterAll(async () => { await ds?.destroy(); });

  it('服务商：密钥加密保存且不返回；留空不改；同名拒绝；别家看不到', async () => {
    await expect(ai.save(admin, null, { name: 'GeekNow', baseUrl: 'ftp://x', apiKey: 'k' })).rejects.toThrow(/http/);
    await expect(ai.save(admin, null, { name: 'GeekNow', baseUrl: 'https://api.example.com/v1' })).rejects.toThrow(/API Key/);
    const { id } = await ai.save(admin, null, { name: 'GeekNow', baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-secret-123', modelName: 'gpt-4o' });
    await expect(ai.save(admin, null, { name: 'GeekNow', baseUrl: 'https://api.example.com/v1', apiKey: 'x' })).rejects.toThrow(/同名/);
    const ov = await ai.overview(admin.companyId);
    expect(JSON.stringify(ov)).not.toContain('sk-secret-123');
    expect(ov.providers[0]).toMatchObject({ name: 'GeekNow', baseUrl: 'https://api.example.com/v1', apiKeyConfigured: true, modelCount: 0 });
    const [raw] = await ds.query('SELECT api_key_enc FROM ai_providers WHERE id = ?', [id]);
    expect(raw.api_key_enc).not.toContain('sk-secret-123');
    await ai.save(admin, id, { name: 'GeekNow', baseUrl: 'https://api.example.com/v1', modelName: 'gpt-4o-mini' }); // 密钥留空
    expect((await ai.overview(other.companyId)).providers).toHaveLength(0);
    await expect(ai.models(other.companyId, id)).rejects.toThrow(/不存在/);
    await expect(ai.remove(other, id)).rejects.toThrow(/不存在/);
  });

  it('模型同步：开关默认关，不会连外部；打开后才读取清单并带上解密后的密钥；只有管理员能开', async () => {
    const [p] = (await ai.overview(admin.companyId)).providers as Array<{ id: number }>;
    expect(await ai.syncEnabled(admin.companyId)).toBe(false);
    await expect(ai.syncModels(admin, p.id)).rejects.toThrow(/开关是关着/);
    expect(calls).toHaveLength(0);
    await expect(ai.setSyncEnabled({ ...admin, permissions: { isCompanyAdmin: false, allow: [], deny: [] } }, true)).rejects.toThrow(/管理员/);
    await ai.setSyncEnabled(admin, true);
    expect(await ai.syncModels(admin, p.id)).toEqual({ synced: 2 });
    expect(calls).toEqual(['https://api.example.com/v1|sk-secret-123']);
    await ai.syncModels(admin, p.id); // 重复同步不重复
    const models = await ai.models(admin.companyId, p.id);
    expect(models.map((m) => m.modelId)).toEqual(['gpt-4o', 'text-embedding-3-small']);
    expect(models[0]).toMatchObject({ endpointType: 'chat-completions', capabilities: ['text', 'vision'] });
    ai.fetchModels = async () => { throw new Error('服务商返回 401 sk-secret-123'); };
    await expect(ai.syncModels(admin, p.id)).rejects.toThrow(/同步失败：服务商返回 401 \*\*\*/);
    expect(((await ai.overview(admin.companyId)).providers[0] as { lastSyncError: string }).lastSyncError).not.toContain('sk-secret-123');
  });

  it('识别场景默认模型：只能选已同步或服务商默认的模型；识别时优先用它', async () => {
    const [p] = (await ai.overview(admin.companyId)).providers as Array<{ id: number }>;
    await expect(ai.setDefault(admin, 'nope', p.id, 'gpt-4o')).rejects.toThrow(/场景/);
    await expect(ai.setDefault(admin, 'business_license_recognition', p.id, 'gpt-x')).rejects.toThrow(/不在该服务商/);
    await ai.setDefault(admin, 'business_license_recognition', p.id, 'gpt-4o');
    const df = await ai.defaults(admin.companyId);
    expect(df.scopes.find((x) => x.key === 'business_license_recognition')?.current).toMatchObject({ providerId: p.id, modelId: 'gpt-4o' });
    expect(df.providers[0].models).toEqual(expect.arrayContaining(['gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small']));
    expect(await ai.resolveVision(admin.companyId, 'business_license_recognition')).toMatchObject({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret-123', model: 'gpt-4o', enabled: true });
    expect(await ai.resolveVision(admin.companyId, 'express_price_recognition')).toBeNull();
    expect(await ai.resolveVision(other.companyId, 'business_license_recognition')).toBeNull();
    // OcrService 用到默认模型：没有营业执照权限先被拦，说明走了新的解析入口且不报“没启用识别接口”
    const s = buildServices(ds);
    const ocr = new OcrService(s.settings, ai);
    let seenModel = '';
    ocr.visionFactory = (cfg) => { seenModel = cfg.model; return { recognize: async () => '{"companyName":"某某公司"}' } as never; };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    const r = await ocr.recognizeLicense(admin, { originalname: 'a.png', buffer: png, size: png.length } as never);
    expect(r.fields.companyName).toBe('某某公司');
    expect(seenModel).toBe('gpt-4o');
    await ai.setDefault(admin, 'business_license_recognition', null);
    await expect(ocr.recognizeLicense(admin, { originalname: 'a.png', buffer: png, size: png.length } as never)).rejects.toThrow(/还没有启用识别接口/);
    // 删除服务商：默认设置跟着清掉
    await ai.setDefault(admin, 'express_price_recognition', p.id, 'gpt-4o');
    await ai.remove(admin, p.id);
    expect((await ai.defaults(admin.companyId)).scopes.every((x) => x.current === null)).toBe(true);
  });
});
