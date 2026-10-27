import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { ARCHIVE_POLICY, RESOURCE_DEFS } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceChangeLog, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

describe('归档配置', () => {
  it('每个可归档资料都存在，归档/恢复用的状态都是它自己的合法状态', () => {
    for (const [key, p] of Object.entries(ARCHIVE_POLICY)) {
      const def = RESOURCE_DEFS.find((x) => x.key === key);
      expect(def).toBeTruthy();
      expect(def!.statuses.map((s) => s.value)).toEqual(expect.arrayContaining([p.archivedStatus, p.defaultStatus]));
    }
  });
});

d('软归档/恢复（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `x${crypto.randomBytes(5).toString('hex')}`, name: '归档测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `ar${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('删除=归档（要原因）；默认列表看不到，已归档列表看得到；恢复回到原状态；被引用的资料也能归档', async () => {
    const sw = await svc.create(boss, 'software', { name: '归档软件', account: 'a1' }, 'renewing');
    await expect(svc.remove(boss, 'software', sw.id, '')).rejects.toThrow('归档必须填写归档原因');
    const done = await svc.remove(boss, 'software', sw.id, '不再使用') as { status: string; archived: { reason: string; fromStatus: string } | null };
    expect(done.status).toBe('inactive');
    expect(done.archived?.reason).toBe('不再使用');
    expect(done.archived?.fromStatus).toBe('renewing');

    expect((await svc.list(boss, 'software', { showHidden: true, keyword: '归档软件' })).total).toBe(0);
    const arch = await svc.list(boss, 'software', { archived: true });
    expect(arch.items.map((x) => x.id)).toEqual([sw.id]);
    expect((await svc.list(boss, 'software', {})).archivedCount).toBe(1);

    await expect(svc.update(boss, 'software', sw.id, { name: '改名' })).rejects.toThrow('已归档');
    await expect(svc.archive(boss, 'software', sw.id, '再来')).rejects.toThrow('已归档');
    await expect(svc.restore(boss, 'software', sw.id, '')).rejects.toThrow('恢复必须填写恢复原因');

    const back = await svc.restore(boss, 'software', sw.id, '又要用了');
    expect(back.status).toBe('renewing');
    expect(back.archived).toBeNull();
    expect((await svc.list(boss, 'software', { keyword: '归档软件' })).total).toBe(1);
    await expect(svc.restore(boss, 'software', sw.id, '重复')).rejects.toThrow('无需恢复');

    const logs = await ds.manager.find(ResourceChangeLog, { where: { companyId: boss.companyId, resourceType: 'software', resourceId: sw.id } });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['archived', 'restored']));
  });

  it('不能把已归档的资料选作新的引用对象；已有引用不受影响', async () => {
    const st = await svc.create(boss, 'stores', { platform: 'taobao', name: '归档引用店' });
    const sw = await svc.create(boss, 'software', { name: '引用店的软件', account: 'ref1', storeId: st.id });
    await svc.archive(boss, 'stores', st.id, '关店');
    await expect(svc.create(boss, 'software', { name: '新软件', account: 'ref2', storeId: st.id })).rejects.toThrow('已归档');
    // 已存在的引用保持原样，别的字段可改
    await svc.update(boss, 'software', sw.id, { account: 'ok' });
    expect((await svc.get(boss, 'software', sw.id)).data.storeId).toBe(st.id);
  });

  it('手动关联带用途和有效期；到期的关联出现在“即将到期”里', async () => {
    const st = await svc.create(boss, 'stores', { platform: 'taobao', name: '授权店' });
    const tm = await svc.create(boss, 'trademarks', { name: '授权商标', source: 'owned' } as never).catch(() => null);
    const target = tm ?? (await svc.create(boss, 'wechat', { name: '关联微信', wechatNo: 'wx_link_t' }));
    const can = () => true;
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await expect(svc.addManualLink(boss, 'stores', st.id, target.type, target.id, can, { validTo: '2026-13-40' })).rejects.toThrow('格式');
    await svc.addManualLink(boss, 'stores', st.id, target.type, target.id, can, { purpose: '授权使用', validTo: soon });
    const rel = (await svc.relations(boss, 'stores', st.id, can)).find((r) => r.relation === 'manual')!;
    expect(rel.purpose).toBe('授权使用');
    expect(rel.validTo).toBe(soon);
    expect((await svc.expiring(boss, 30)).rows.some((r) => r.type === 'stores' && r.id === st.id && r.fieldLabel.includes('关联到期'))).toBe(true);
    await svc.updateManualLink(boss, 'stores', st.id, rel.linkId!, { validTo: '' });
    expect((await svc.relations(boss, 'stores', st.id, can)).find((r) => r.relation === 'manual')!.validTo).toBeNull();
    await expect(svc.addManualLink(boss, 'stores', st.id, target.type, target.id, can)).rejects.toThrow('已经关联过');
  });
});
