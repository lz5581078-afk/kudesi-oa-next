/** 固定资产多维度浏览、位置层级规则、档案快捷页签的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_asset_test npx jest --runInBand asset-browse.db */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { AssetsService } from './assets.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('固定资产浏览与位置层级（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let assets: AssetsService;
  let boss: AuthUser;
  let alice: number;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    svc = s.resources; assets = s.assets;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `b${crypto.randomBytes(5).toString('hex')}`, name: '浏览测试', status: 'active' }));
    const mk = (account: string, name: string, admin = false) => ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account, passwordHash: 'x', name, isCompanyAdmin: admin, status: 'active', mustChangePassword: false }));
    const u = await mk('admin', '老板', true);
    alice = (await mk('alice', '小李')).id;
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('位置层级：楼 → 房间 → 柜子里的层 → 抽屉；层位跟着柜子，抽屉继承层的固定资产', async () => {
    const building = await svc.create(boss, 'locations', { name: '总部楼', scope: 'area', locationType: 'building' });
    const room = await svc.create(boss, 'locations', { name: '财务室', scope: 'area', locationType: 'room', parentId: building.id });
    const cat = await svc.create(boss, 'asset-categories', { name: '柜类' });
    const cab = await svc.create(boss, 'fixed-assets', { name: '档案柜', categoryId: cat.id, locationId: room.id });
    const shelf = await svc.create(boss, 'locations', { name: '第一层', scope: 'asset_space', locationType: 'shelf', fixedAssetId: cab.id });
    const drawer = await svc.create(boss, 'locations', { name: '抽屉甲', scope: 'asset_space', locationType: 'drawer', parentId: shelf.id });
    expect(drawer.data.fixedAssetId).toBe(cab.id);
    Object.assign(ids, { building: building.id, room: room.id, cat: cat.id, cab: cab.id, shelf: shelf.id, drawer: drawer.id });
    // 柜子这个类型可选
    const cabinetType = await svc.create(boss, 'locations', { name: '落地柜', scope: 'area', locationType: 'cabinet', parentId: room.id });
    expect(cabinetType.data.locationType).toBe('cabinet');
  });

  it('储物空间下不能放区域位置；抽屉的固定资产要和上级一致', async () => {
    await expect(svc.create(boss, 'locations', { name: '房间放进层里', scope: 'area', locationType: 'room', parentId: ids.shelf })).rejects.toThrow(/不能放在储物空间里/);
    const other = await svc.create(boss, 'fixed-assets', { name: '另一个柜' });
    await expect(svc.create(boss, 'locations', { name: '串柜抽屉', scope: 'asset_space', locationType: 'drawer', parentId: ids.shelf, fixedAssetId: other.id })).rejects.toThrow(/不是同一项固定资产/);
  });

  it('位置目录：固定资产页的位置维度不列储物空间，房间的数量含下级；档案目录列全部', async () => {
    await assets.transition(boss, ids.cab, { action: 'checkout', userId: alice });
    const tree = await svc.categoryTree(boss, 'fixed-assets', 'locationId', {});
    const titles = tree.nodes.map((n) => n.title);
    expect(titles).toEqual(expect.arrayContaining(['总部楼', '财务室']));
    expect(titles).not.toContain('第一层');
    expect(titles).not.toContain('抽屉甲');
    const roomNode = tree.nodes.find((n) => n.id === ids.room)!;
    expect(roomNode.count).toBe(1);
    const all = await svc.categoryTree(boss, 'archives', 'locationId', {});
    expect(all.nodes.map((n) => n.title)).toEqual(expect.arrayContaining(['第一层', '抽屉甲']));
  });

  it('使用人、部门维度是平铺目录，数量按人统计，未设置另算', async () => {
    const byUser = await svc.categoryTree(boss, 'fixed-assets', 'userId', {});
    expect(byUser.nodes.find((n) => n.id === alice)).toMatchObject({ title: '小李', count: 1, parentId: 0 });
    expect(byUser.uncategorized).toBeGreaterThanOrEqual(1);
    await expect(svc.categoryTree(boss, 'fixed-assets', 'brand', {})).rejects.toThrow(/没有分类目录/);
  });

  it('按位置筛选包含下级位置里的资产；按使用人筛选只看这个人', async () => {
    const inBuilding = await svc.list(boss, 'fixed-assets', { fieldKey: 'locationId', fieldValue: String(ids.building) });
    expect(inBuilding.items.map((x) => x.id)).toContain(ids.cab);
    const mine = await svc.list(boss, 'fixed-assets', { fieldKey: 'userId', fieldValue: String(alice) });
    expect(mine.items.map((x) => x.id)).toEqual([ids.cab]);
  });

  it('快捷页签：在用、没填位置', async () => {
    const lonely = await svc.create(boss, 'fixed-assets', { name: '没位置的椅子' });
    const noLoc = await svc.list(boss, 'fixed-assets', { tab: 'q:no-location' });
    expect(noLoc.items.map((x) => x.id)).toContain(lonely.id);
    expect(noLoc.items.map((x) => x.id)).not.toContain(ids.cab);
    const inUse = await svc.list(boss, 'fixed-assets', { tab: 'q:in-use' });
    expect(inUse.items.map((x) => x.id)).toEqual([ids.cab]);
  });

  it('档案：借出/遗失要原因；按存放位置筛选含下级；没填位置页签', async () => {
    const a1 = await svc.create(boss, 'archives', { name: '合同A', archiveType: '合同', locationId: ids.drawer });
    const a2 = await svc.create(boss, 'archives', { name: '无处存放', archiveType: '合同' });
    await expect(svc.changeStatus(boss, 'archives', a1.id, 'borrowed')).rejects.toThrow();
    await svc.changeStatus(boss, 'archives', a1.id, 'borrowed', '借给财务');
    const inShelf = await svc.list(boss, 'archives', { fieldKey: 'locationId', fieldValue: String(ids.shelf) });
    expect(inShelf.items.map((x) => x.id)).toContain(a1.id);
    const borrowed = await svc.list(boss, 'archives', { tab: 'q:borrowed' });
    expect(borrowed.items.map((x) => x.id)).toEqual([a1.id]);
    const noLoc = await svc.list(boss, 'archives', { tab: 'q:no-location' });
    expect(noLoc.items.map((x) => x.id)).toContain(a2.id);
  });

  it('公司隔离：别家公司看不到这些位置', async () => {
    const other = { ...boss, id: 1, companyId: boss.companyId + 99999 };
    expect((await svc.categoryTree(other, 'fixed-assets', 'locationId', {})).nodes).toEqual([]);
  });
});
