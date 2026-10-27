/** 手机扫码上传（收款码、商品图片）：令牌、过期、次数、类型、跨公司。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_d npx jest phone-upload */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, PhoneUploadSession, ResourceFile, User } from '../entities';
import { buildServices } from '../test-support';
import { PhoneUploadService } from './phone-upload.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const PDF = Buffer.from('%PDF-1.4 test');
const file = (buf: Buffer, name = 'a.png') => ({ originalname: name, buffer: buf, size: buf.length });

d('手机扫码上传（真实数据库）', () => {
  let ds: DataSource;
  let s: ReturnType<typeof buildServices>;
  let phone: PhoneUploadService;
  let boss: AuthUser, clerk: AuthUser, viewer: AuthUser, other: AuthUser;
  let bossUserId: number;

  const mkCompany = async (tag: string) => ds.manager.save(Company, ds.manager.create(Company, { code: `p${tag}${crypto.randomBytes(4).toString('hex')}`, name: `手机上传${tag}`, status: 'active' }));
  const mkUser = async (companyId: number, account: string, perms: string[], admin = false): Promise<AuthUser> => {
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name: account, isCompanyAdmin: admin, status: 'active', mustChangePassword: false }));
    return { id: u.id, companyId, name: account, permissions: { isCompanyAdmin: admin, allow: perms, deny: [] } };
  };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    s = buildServices(ds);
    phone = new PhoneUploadService(ds, s.files);
    const c = await mkCompany('a');
    const c2 = await mkCompany('b');
    boss = await mkUser(c.id, 'boss', [], true);
    bossUserId = boss.id;
    clerk = await mkUser(c.id, 'clerk', ['resource.finance-products.create']);
    viewer = await mkUser(c.id, 'viewer', ['resource.finance-products.view']);
    other = await mkUser(c2.id, 'other', [], true);
    await s.settings.saveQiniu(boss, { accessKey: 'AK1', secretKey: 'SK-secret', bucket: 'oa', zone: 'z0', domain: 'https://cdn.example.com', isPrivate: true });
    await s.settings.saveQiniu(other, { accessKey: 'AK2', secretKey: 'SK-secret2', bucket: 'oa', zone: 'z0', domain: 'https://cdn2.example.com', isPrivate: true });
  });
  afterAll(async () => { await ds?.destroy(); });

  it('发起：要有该资料的新增或编辑权限，字段必须声明可手机上传；令牌不进库，只存哈希', async () => {
    await expect(phone.create(viewer, 'finance-products', 'photos')).rejects.toThrow(/没有权限/);
    await expect(phone.create(clerk, 'finance-products', 'name')).rejects.toThrow(/不支持手机上传/);
    await expect(phone.create(clerk, 'finance-products', 'nosuch')).rejects.toThrow(/不支持手机上传/);
    await expect(phone.create(clerk, 'nosuch', 'photos')).rejects.toThrow(/不支持手机上传/);
    await expect(phone.create(clerk, 'licenses', 'attachments')).rejects.toThrow(/不支持手机上传/);
    const t = await phone.create(clerk, 'finance-products', 'photos');
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.minutes).toBe(10);
    expect(t.maxUploads).toBe(10);
    const row = await ds.manager.findOneOrFail(PhoneUploadSession, { where: { id: t.id } });
    expect(row.tokenHash).toBe(crypto.createHash('sha256').update(t.token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(t.token);
    expect(row).toMatchObject({ companyId: clerk.companyId, userId: clerk.id, resourceType: 'finance-products', fieldKey: 'photos' });
    // 两次发起的令牌不同；收款码字段最多 2 张
    const qr = await phone.create(boss, 'finance-suppliers', 'paymentQr');
    expect(qr.token).not.toBe(t.token);
    expect(qr.maxUploads).toBe(2);
  });

  it('手机端：扫码只看到字段名和剩余张数；上传图片后电脑端轮询能拿到文件，文件是“未绑定”的、属于发起人和他的公司', async () => {
    const t = await phone.create(clerk, 'finance-products', 'photos');
    expect((await phone.status(clerk, t.id)).scanned).toBe(false);
    const info = await phone.inspect(t.token);
    expect(info).toEqual({ label: '商品照片', resource: '商品档案', remaining: 10, expiresAt: expect.any(String) });
    expect((await phone.status(clerk, t.id)).scanned).toBe(true);
    const r1 = await phone.upload(t.token, file(PNG, '正面.png'));
    expect(r1).toEqual({ ok: true, remaining: 9 });
    await phone.upload(t.token, file(PNG, '背面.png'));
    const st = await phone.status(clerk, t.id);
    expect(st.uploaded).toBe(2);
    expect(st.files.map((f) => f.name)).toEqual(['正面.png', '背面.png']);
    const row = await ds.manager.findOneOrFail(ResourceFile, { where: { id: st.files[0].id } });
    expect(row).toMatchObject({ companyId: clerk.companyId, uploadedBy: clerk.id, resourceType: 'finance-products', fieldKey: 'photos', resourceId: null });
    // 留痕
    const logs = await ds.manager.find(AuditLog, { where: { companyId: clerk.companyId, actorId: clerk.id, action: 'phone-upload.file' } });
    expect(logs.length).toBeGreaterThanOrEqual(2);
  });

  it('类型不对：只收图片（按文件头判断），PDF、伪造扩展名的都拒绝，也不占次数', async () => {
    const t = await phone.create(clerk, 'finance-products', 'photos');
    await expect(phone.upload(t.token, file(PDF, 'a.pdf'))).rejects.toThrow(/只能上传图片/);
    await expect(phone.upload(t.token, file(Buffer.from('MZ not an image'), 'evil.png'))).rejects.toThrow(/只能上传图片/);
    await expect(phone.upload(t.token, undefined)).rejects.toThrow(/没有收到/);
    expect((await phone.status(clerk, t.id)).uploaded).toBe(0);
  });

  it('次数用完（重复使用）：收款码最多 2 张，第 3 张被拒；用完后手机页也打不开', async () => {
    const t = await phone.create(boss, 'finance-suppliers', 'paymentQr');
    await phone.upload(t.token, file(PNG));
    await phone.upload(t.token, file(PNG));
    await expect(phone.upload(t.token, file(PNG))).rejects.toThrow(/次数已用完/);
    await expect(phone.inspect(t.token)).rejects.toThrow(/次数已用完/);
    const st = await phone.status(boss, t.id);
    expect(st).toMatchObject({ uploaded: 2, expired: true });
    expect(st.files).toHaveLength(2);
  });

  it('过期失效：过了有效期不能打开也不能上传', async () => {
    const t = await phone.create(clerk, 'finance-products', 'photos');
    await ds.manager.update(PhoneUploadSession, { id: t.id }, { expiresAt: new Date(Date.now() - 1000) });
    await expect(phone.inspect(t.token)).rejects.toThrow(/已失效/);
    await expect(phone.upload(t.token, file(PNG))).rejects.toThrow(/已失效/);
    expect((await phone.status(clerk, t.id)).expired).toBe(true);
  });

  it('令牌不合法或猜不到：格式不对、没发过的令牌都拒绝', async () => {
    await expect(phone.inspect('')).rejects.toThrow(/无效/);
    await expect(phone.inspect('short')).rejects.toThrow(/无效/);
    await expect(phone.inspect(crypto.randomBytes(32).toString('base64url'))).rejects.toThrow(/已失效/);
    await expect(phone.upload(crypto.randomBytes(32).toString('base64url'), file(PNG))).rejects.toThrow(/已失效/);
    await expect(phone.upload("x' OR '1'='1", file(PNG))).rejects.toThrow(/已失效/);
  });

  it('不能跨公司：别家公司的人看不到我的会话；令牌上传的文件永远落在发起人的公司；发起人被停用后令牌作废', async () => {
    const t = await phone.create(clerk, 'finance-products', 'photos');
    await expect(phone.status(other, t.id)).rejects.toThrow(/不存在/);
    await expect(phone.status(boss, t.id)).rejects.toThrow(/不存在/); // 同公司的别人也看不到
    await phone.upload(t.token, file(PNG));
    const mine = await ds.manager.find(ResourceFile, { where: { companyId: other.companyId } });
    expect(mine.filter((f) => f.uploadedBy === clerk.id)).toHaveLength(0);
    await ds.manager.update(User, { id: clerk.id }, { status: 'disabled' });
    await expect(phone.upload(t.token, file(PNG))).rejects.toThrow(/已停用/);
    await ds.manager.update(User, { id: clerk.id }, { status: 'active' });
    expect(bossUserId).toBeGreaterThan(0);
  });
});
