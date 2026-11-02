import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { ResourceChangeLog, Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('店铺关联聚水潭：保存/列表/审计与公司隔离（MySQL）', () => {
  let ds: DataSource, svc: ResourcesService, boss: AuthUser, other: AuthUser;
  let query: jest.SpyInstance;
  const user = async (): Promise<AuthUser> => {
    const key = randomBytes(6).toString('hex');
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: key, name: '店铺关联测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: key, passwordHash: 'x', name: '测试', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    return { id: u.id, companyId: c.id, name: u.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  };
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME }), migrationsRun: true } as never);
    await ds.initialize(); svc = buildServices(ds).resources;
    boss = await user(); other = await user();
    query = jest.spyOn(svc, 'jushuitanShops');
  });
  beforeEach(() => { query.mockReset().mockImplementation(async (u: AuthUser) => u.companyId === boss.companyId ? [{ id: '123', name: '聚水潭甲店', platform: '淘宝', expiresAt: '2027-03-17', expiryStatus: 'dated' }] : []); });
  afterAll(async () => { query?.mockRestore(); await ds?.destroy(); });
  it('新增并关联、列表回读、替换非法关联回滚、编辑其他字段和解除关联', async () => {
    const r = await svc.create(boss, 'stores', { name: 'OA甲店', platform: 'taobao', jushuitanShopId: '123', jushuitanShopName: '伪造店名' });
    expect(r.data).toMatchObject({ jushuitanShopId: '123', jushuitanShopName: '聚水潭甲店' });
    expect((await svc.list(boss, 'stores', {})).items.find(s => s.id === r.id)?.data.jushuitanShopName).toBe('聚水潭甲店');
    await expect(svc.update(other, 'stores', r.id, { jushuitanShopId: '' })).rejects.toThrow();
    await expect(svc.create(other, 'stores', { name: 'OA乙店', platform: 'taobao', jushuitanShopId: '123' })).rejects.toThrow('不在当前公司授权范围内');
    await expect(svc.update(boss, 'stores', r.id, { jushuitanShopId: 'foreign' })).rejects.toThrow('不在当前公司授权范围内');
    expect((await svc.get(boss, 'stores', r.id)).data.jushuitanShopId).toBe('123');
    query.mockRejectedValue(new Error('外部接口不可用'));
    expect((await svc.update(boss, 'stores', r.id, { note: '其他字段' })).data.jushuitanShopName).toBe('聚水潭甲店');
    const cleared = await svc.update(boss, 'stores', r.id, { jushuitanShopId: '' });
    expect(cleared.data.jushuitanShopId).toBeUndefined();
    expect(cleared.data.jushuitanShopName).toBeUndefined();
    expect(await ds.manager.count(ResourceChangeLog, { where: { companyId: boss.companyId } })).toBeGreaterThan(0);
  });
  it('关联自动保存到期日，拒绝手填覆盖；刷新续期/永久/未知，失败保持原值', async () => {
    const r = await svc.create(boss, 'stores', { name: '授权期限测试', platform: 'taobao', jushuitanShopId: '123', jushuitanExpireAt: '2000-01-01' });
    expect(r.data.jushuitanExpireAt).toBe('2027-03-17');
    expect((await svc.update(boss, 'stores', r.id, { jushuitanExpireAt: '2000-01-01', note: '其他资料' })).data.jushuitanExpireAt).toBe('2027-03-17');
    query.mockResolvedValue([{ id: '123', name: '聚水潭甲店新名称', platform: '淘宝', expiresAt: '2028-01-01', expiryStatus: 'dated' }]);
    expect((await svc.refreshJushuitanShop(boss, 'stores', r.id)).data).toMatchObject({ jushuitanExpireAt: '2028-01-01', jushuitanShopName: '聚水潭甲店新名称' });
    query.mockRejectedValue(new Error('授权接口失败'));
    await expect(svc.refreshJushuitanShop(boss, 'stores', r.id)).rejects.toThrow('授权接口失败');
    expect((await svc.get(boss, 'stores', r.id)).data.jushuitanExpireAt).toBe('2028-01-01');
    query.mockResolvedValue([]);
    await expect(svc.refreshJushuitanShop(boss, 'stores', r.id)).rejects.toThrow('未更新原有到期时间');
    expect((await svc.get(boss, 'stores', r.id)).data.jushuitanExpireAt).toBe('2028-01-01');
    for (const status of ['permanent', 'unknown']) {
      query.mockResolvedValue([{ id: '123', name: '聚水潭甲店', platform: '淘宝', expiresAt: null, expiryStatus: status }]);
      const got = await svc.refreshJushuitanShop(boss, 'stores', r.id);
      expect(got.data.jushuitanExpireAt).toBeUndefined();
      expect(got.data.jushuitanExpiryStatus).toBe(status);
    }
  });
  it('刷新检查公司、权限、关联和版本；外部查询期间发生修改则停止，不覆盖新资料', async () => {
    const r = await svc.create(boss, 'stores', { name: '并发刷新测试', platform: 'taobao', jushuitanShopId: '123' });
    await expect(svc.refreshJushuitanShop(other, 'stores', r.id)).rejects.toThrow();
    await expect(svc.refreshJushuitanShop({ ...boss, permissions: { isCompanyAdmin: false, allow: ['resource.stores.view'], deny: [] } }, 'stores', r.id)).rejects.toThrow('没有修改');
    query.mockImplementation(async () => {
      await svc.update(boss, 'stores', r.id, { note: '同时修改' });
      return [{ id: '123', name: '外部名称', expiresAt: '2029-01-01', expiryStatus: 'dated' }];
    });
    await expect(svc.refreshJushuitanShop(boss, 'stores', r.id)).rejects.toThrow('刚被修改');
    expect((await svc.get(boss, 'stores', r.id)).data).toMatchObject({ note: '同时修改', jushuitanExpireAt: '2027-03-17' });
    const none = await svc.create(boss, 'stores', { name: '无关联', platform: 'taobao' });
    await expect(svc.refreshJushuitanShop(boss, 'stores', none.id)).rejects.toThrow('请先关联');
  });

});
