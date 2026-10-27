/** 接口设置、文件上传、营业执照识别的真实数据库测试。默认跳过，开关同 resources.db.spec.ts。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { FakeStorage, buildServices } from '../test-support';
import { VisionClient } from './vision.client';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const PDF = Buffer.from('%PDF-1.4 test');

d('接口设置 / 文件 / 识别（真实数据库）', () => {
  let ds: DataSource;
  let s: ReturnType<typeof buildServices>;
  let storage: FakeStorage;
  let boss: AuthUser;
  let other: AuthUser;
  let nobody: AuthUser;

  const mk = async (tag: string, admin: boolean): Promise<AuthUser & { code: string }> => {
    const code = `i${tag}${crypto.randomBytes(4).toString('hex')}`;
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code, name: `测试${tag}`, status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'a', passwordHash: 'x', name: '管理员', isCompanyAdmin: admin, status: 'active', mustChangePassword: false }));
    return { id: u.id, companyId: company.id, name: u.name, code, permissions: { isCompanyAdmin: admin, allow: [], deny: [] } };
  };

  const qiniuInput = { accessKey: 'AK123', secretKey: 'SK-very-secret', bucket: 'oa', zone: 'z0', domain: 'https://cdn.example.com', isPrivate: true };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    s = buildServices(ds);
    storage = s.storage;
    boss = await mk('a', true);
    other = await mk('b', true);
    nobody = { ...(await mk('c', false)) };
  });
  afterAll(async () => ds?.destroy());

  it('七牛设置：密钥加密保存且不返回；留空不改；网址要合法；换公司互不可见', async () => {
    await expect(s.settings.saveQiniu(boss, { ...qiniuInput, secretKey: '' })).rejects.toThrow(/SecretKey/);
    await expect(s.settings.saveQiniu(boss, { ...qiniuInput, domain: 'ftp://x' })).rejects.toThrow(/http/);
    const saved = await s.settings.saveQiniu(boss, qiniuInput);
    expect(saved.qiniu.secretKeyConfigured).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('SK-very-secret');
    const raw = await ds.query('SELECT config_enc FROM integration_settings WHERE company_id = ?', [boss.companyId]);
    expect(raw[0].config_enc).not.toContain('SK-very-secret');
    await s.settings.saveQiniu(boss, { ...qiniuInput, secretKey: '', bucket: 'oa2' });
    expect((await s.settings.getQiniu(boss.companyId))?.secretKey).toBe('SK-very-secret');
    expect((await s.settings.overview(other.companyId)).qiniu.configured).toBe(false);
  });

  it('没配置七牛时上传给出明确提示；配置后上传成功并只接受合法文件', async () => {
    await expect(s.files.upload(other, 'fixed-assets', 'photos', { originalname: 'a.png', buffer: PNG, size: PNG.length })).rejects.toThrow(/还没有配置七牛/);
    const up = (type: string, field: string, buf: Buffer, name = 'a.png', who = boss) => s.files.upload(who, type, field, { originalname: name, buffer: buf, size: buf.length });
    const ok = await up('fixed-assets', 'photos', PNG, '营业执照.png');
    expect(ok.mime).toBe('image/png');
    expect([...storage.objects.keys()].some((k) => k.startsWith(`oa/${boss.companyId}/fixed-assets/`) && k.endsWith('.png'))).toBe(true);
    await expect(up('fixed-assets', 'photos', PDF, 'a.pdf')).rejects.toThrow(/只能上传图片/); // 照片字段只收图片
    await expect(up('fixed-assets', 'photos', Buffer.from('MZ not an image'), 'evil.png')).rejects.toThrow(/只能上传图片/);
    await expect(up('licenses', 'companyName', PNG)).rejects.toThrow(/不支持上传/);
    await expect(up('qualifications', 'attachments', PDF, '资质.pdf')).resolves.toMatchObject({ mime: 'application/pdf' });
    await expect(up('fixed-assets', 'photos', Buffer.alloc(11 * 1024 * 1024, 1), 'big.png')).rejects.toThrow(/10MB/);
    await expect(up('fixed-assets', 'photos', PNG, 'a.png', nobody)).rejects.toThrow(/没有权限/);
    storage.failUpload = true;
    await expect(up('fixed-assets', 'photos', PNG)).rejects.toThrow(/上传到七牛失败/);
    storage.failUpload = false;
  });

  it('文件跟记录绑定：显示文件信息、不能被别家或别的记录/字段借用、去掉后清理七牛对象、归档时保留', async () => {
    const f1 = await s.files.upload(boss, 'fixed-assets', 'photos', { originalname: '正面.png', buffer: PNG, size: PNG.length });
    const f2 = await s.files.upload(boss, 'fixed-assets', 'photos', { originalname: '背面.png', buffer: PNG, size: PNG.length });
    const lic = await s.resources.create(boss, 'fixed-assets', { assetNo: 'PH-001', name: '带照片资产', photos: [f1.id, f2.id] });
    expect(Object.values(lic.files).map((f) => f.name).sort()).toEqual(['正面.png', '背面.png']);
    // 别的记录不能再用同一个文件
    await expect(s.resources.create(boss, 'fixed-assets', { assetNo: 'PH-002', name: '偷用', photos: [f1.id] })).rejects.toThrow(/无效的文件/);
    // 不能用于别的字段
    await expect(s.resources.create(boss, 'partners', { name: '丙', idFront: [f2.id] })).rejects.toThrow(/无效的文件/);
    // 别家公司更不行
    await s.settings.saveQiniu(other, qiniuInput);
    await expect(s.resources.create(other, 'fixed-assets', { assetNo: 'PH-003', name: 'x', photos: [f2.id] })).rejects.toThrow(/无效的文件/);
    // 超过数量上限
    await expect(s.resources.create(boss, 'partners', { name: '丁', idFront: [1, 2] })).rejects.toThrow(/最多 1 个文件/);

    const keyOf = async (id: number) => (await ds.query('SELECT storage_key k FROM resource_files WHERE id = ?', [id]))[0].k as string;
    const k2 = await keyOf(f2.id);
    storage.removed = [];
    const edited = await s.resources.update(boss, 'fixed-assets', lic.id, { photos: [f1.id] });
    expect(Object.keys(edited.files)).toEqual([String(f1.id)]);
    expect(storage.removed).toEqual([k2]);
    storage.removed = [];
    // 删除=归档：文件原样保留，恢复后还在（不清理七牛对象）
    await s.resources.remove(boss, 'fixed-assets', lic.id, '测试归档');
    expect(storage.removed).toEqual([]);
    expect((await ds.query('SELECT COUNT(*) n FROM resource_files WHERE id = ?', [f1.id]))[0].n).toBe('1');
  });

  it('下载链接：要有该资料的查看权限，别家拿不到', async () => {
    const f = await s.files.upload(boss, 'fixed-assets', 'photos', { originalname: 'x.png', buffer: PNG, size: PNG.length });
    const res = await s.files.url(boss, f.id);
    expect(res.url).toContain('https://fake.example.com/');
    await expect(s.files.url(other, f.id)).rejects.toThrow(/不存在/);
    await expect(s.files.url(nobody, f.id)).rejects.toThrow(/不存在/); // 不同公司
    const sameCompanyNoPerm: AuthUser = { ...boss, id: boss.id + 999, permissions: { isCompanyAdmin: false, allow: ['resource.stores.view'], deny: [] } };
    await expect(s.files.url(sameCompanyNoPerm, f.id)).rejects.toThrow(/没有权限/);
    const allowed: AuthUser = { ...sameCompanyNoPerm, permissions: { isCompanyAdmin: false, allow: ['resource.fixed-assets.view'], deny: [] } };
    await expect(s.files.url(allowed, f.id)).resolves.toBeTruthy();
  });

  it('接口测试按钮：七牛能传能删算成功；失败给出原因', async () => {
    expect((await s.files.selfTest(boss)).ok).toBe(true);
    storage.failUpload = true;
    expect((await s.files.selfTest(boss)).ok).toBe(false);
    storage.failUpload = false;
    expect((await s.files.selfTest(await mk('d', true))).ok).toBe(false);
  });

  it('营业执照识别：没启用不能用；识别结果规范化后返回，不直接入库', async () => {
    await expect(s.ocr.recognizeLicense(boss, { originalname: 'a.png', buffer: PNG, size: PNG.length })).rejects.toThrow(/还没有启用识别接口/);
    await s.settings.saveVision(boss, { baseUrl: 'https://llm.example.com/v1/', apiKey: 'sk-test-key', model: 'gpt-4o', enabled: true });
    const ov = await s.settings.overview(boss.companyId);
    expect(ov.vision.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(ov)).not.toContain('sk-test-key');

    let sentBody: { model: string; messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> } | null = null;
    let sentAuth = '';
    s.ocr.visionFactory = (cfg) =>
      new VisionClient(cfg, (async (url: string, init: { body: string; headers: Record<string, string> }) => {
        sentBody = JSON.parse(init.body);
        sentAuth = init.headers.Authorization;
        expect(url).toBe('https://llm.example.com/v1/chat/completions');
        return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"companyName":"识别农业有限公司","creditCode":"91310000ma1abcde12","legalPerson":"王五","foundedAt":"2015年3月2日"}\n```' } }] }), { status: 200 });
      }) as unknown as typeof fetch);
    const res = await s.ocr.recognizeLicense(boss, { originalname: 'a.png', buffer: PNG, size: PNG.length });
    expect(res.fields).toEqual({ companyName: '识别农业有限公司', creditCode: '91310000MA1ABCDE12', legalPerson: '王五', foundedAt: '2015-03-02' });
    expect(sentAuth).toBe('Bearer sk-test-key');
    expect(sentBody!.model).toBe('gpt-4o');
    expect(sentBody!.messages[0].content[1].image_url!.url.startsWith('data:image/png;base64,')).toBe(true);
    expect((await s.resources.list(boss, 'licenses', { keyword: '识别农业' })).total).toBe(0);

    await expect(s.ocr.recognizeLicense(boss, { originalname: 'a.pdf', buffer: PDF, size: PDF.length })).rejects.toThrow(/只能识别图片/);
    await expect(s.ocr.recognizeLicense(nobody, { originalname: 'a.png', buffer: PNG, size: PNG.length })).rejects.toThrow(/没有权限/);
    s.ocr.visionFactory = (cfg) => new VisionClient(cfg, (async () => new Response('server error', { status: 500 })) as unknown as typeof fetch);
    await expect(s.ocr.recognizeLicense(boss, { originalname: 'a.png', buffer: PNG, size: PNG.length })).rejects.toThrow(/识别失败/);
    s.ocr.visionFactory = (cfg) => new VisionClient(cfg, (async () => new Response(JSON.stringify({ choices: [{ message: { content: '我看不清' } }] }), { status: 200 })) as unknown as typeof fetch);
    await expect(s.ocr.recognizeLicense(boss, { originalname: 'a.png', buffer: PNG, size: PNG.length })).rejects.toThrow(/无法解析/);
  });
});
