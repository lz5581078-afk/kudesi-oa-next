import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { GridSaveService } from './grid-save.service';
import { ResourceCategoriesService } from './resource-categories.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const cf = (...f: Array<Record<string, unknown>>) => JSON.stringify(f);

d('页签分类管理（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let cats: ResourceCategoriesService;
  let grid: GridSaveService;
  let boss: AuthUser;
  let other: AuthUser;
  let manager: AuthUser;
  let viewerOnly: AuthUser;
  let noView: AuthUser;
  const asUser = (companyId: number, id: number, allow: string[]): AuthUser => ({ id, companyId, name: '员工', permissions: { isCompanyAdmin: false, allow, deny: [] } });
  const items = async (u: AuthUser, type: string) => (await cats.list(u, type)).items;
  const byLabel = async (u: AuthUser, type: string, label: string) => (await items(u, type)).find((i) => i.label === label)!;

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_tabmanage_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    cats = new ResourceCategoriesService(ds);
    grid = new GridSaveService(svc);
    const mk = async (name: string) => {
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `x${crypto.randomBytes(5).toString('hex')}`, name, status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `t${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
      return { c, u };
    };
    const a = await mk('分类A');
    const b = await mk('分类B');
    boss = { id: a.u.id, companyId: a.c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    other = { id: b.u.id, companyId: b.c.id, name: '外司', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    manager = asUser(a.c.id, a.u.id, ['resource.categories.manage', 'resource.qualifications.view']);
    viewerOnly = asUser(a.c.id, a.u.id, ['resource.qualifications.view']);
    noView = asUser(a.c.id, a.u.id, ['resource.categories.manage']);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('没有配置时就是代码里的选项；公司管理员和有权限的人能看到，只有查看权限的人不行', async () => {
    const list = await items(boss, 'qualifications');
    expect(list.map((i) => i.label)).toEqual(['种子生产经营备案', '品牌授权', '平台经营资质', '其他资质']);
    expect(list.every((i) => i.system && !i.hidden && i.count === 0)).toBe(true);
    expect((await items(manager, 'qualifications')).length).toBe(4);
    await expect(cats.list(viewerOnly, 'qualifications')).rejects.toThrow('没有权限');
    await expect(cats.list(noView, 'qualifications')).rejects.toThrow('没有权限');
    await expect(cats.list(boss, 'finance-products')).rejects.toThrow('没有可管理的分类页签');
    await expect(cats.list(boss, 'locations')).rejects.toThrow('没有可管理的分类页签');
    await expect(cats.list(boss, 'nope')).rejects.toThrow('没有这种资料');
  });

  it('新增自建分类：值自动生成且稳定，重名/保留名/空名/超长被拒；改名不改值', async () => {
    const r = await cats.create(boss, 'qualifications', '  行业协会证书 ');
    expect(r.value).toMatch(/^c_[0-9a-z]{8}$/);
    const item = await byLabel(boss, 'qualifications', '行业协会证书');
    expect(item).toMatchObject({ value: r.value, system: false, hidden: false, count: 0 });
    // 自建的排在系统分类后面
    expect((await items(boss, 'qualifications')).map((i) => i.label).at(-1)).toBe('行业协会证书');
    await expect(cats.create(boss, 'qualifications', '行业协会证书')).rejects.toThrow('同名');
    await expect(cats.create(boss, 'qualifications', '品牌授权')).rejects.toThrow('同名');
    await expect(cats.create(boss, 'qualifications', '全部')).rejects.toThrow('保留');
    await expect(cats.create(boss, 'qualifications', '   ')).rejects.toThrow('请填写');
    await expect(cats.create(boss, 'qualifications', 'x'.repeat(21))).rejects.toThrow('不能超过');
    await cats.update(boss, 'qualifications', r.value, { name: '协会证书' });
    expect((await byLabel(boss, 'qualifications', '协会证书')).value).toBe(r.value);
    // 另一家公司看不到
    expect((await items(other, 'qualifications')).length).toBe(4);
    const payload = await cats.options(boss);
    expect(payload.qualifications.rows.some((x) => x.value === r.value && x.custom)).toBe(true);
    expect((await cats.options(other)).qualifications).toBeUndefined();
  });

  it('系统分类：可以改名和排序，不能隐藏、不能删除；改名后记录里的值不变', async () => {
    const brand = await byLabel(boss, 'qualifications', '品牌授权');
    await svc.create(boss, 'qualifications', { name: '某品牌授权书', type: 'brand_authorization' });
    await cats.update(boss, 'qualifications', brand.value, { name: '品牌授权书' });
    const renamed = await byLabel(boss, 'qualifications', '品牌授权书');
    expect(renamed).toMatchObject({ value: 'brand_authorization', system: true, defaultLabel: '品牌授权', count: 1 });
    await expect(cats.update(boss, 'qualifications', 'brand_authorization', { hidden: true })).rejects.toThrow('系统自带');
    await expect(cats.remove(boss, 'qualifications', 'brand_authorization')).rejects.toThrow('系统自带');
    await expect(cats.update(boss, 'qualifications', 'brand_authorization', { name: '平台经营资质' })).rejects.toThrow('同名');
    // 记录没变
    const rec = await ds.manager.findOneOrFail(ResourceRecord, { where: { companyId: boss.companyId, type: 'qualifications', title: '某品牌授权书' } });
    expect(rec.data.type).toBe('brand_authorization');
    // 另一家公司仍是原名
    expect((await items(other, 'qualifications')).map((i) => i.label)).toContain('品牌授权');
  });

  it('排序：必须是当前全部分类的一个排列；顺序变化后再改回；陈旧列表返回冲突', async () => {
    const cur = (await items(boss, 'qualifications')).map((i) => i.value);
    const next = [...cur.slice(1), cur[0]];
    await cats.reorder(boss, 'qualifications', next);
    expect((await items(boss, 'qualifications')).map((i) => i.value)).toEqual(next);
    await expect(cats.reorder(boss, 'qualifications', next.slice(1))).rejects.toThrow('已经变化');
    await expect(cats.reorder(boss, 'qualifications', [...next.slice(1), 'zzz'])).rejects.toThrow('已经变化');
    await expect(cats.reorder(boss, 'qualifications', [...next.slice(1), next[1]])).rejects.toThrow('已经变化');
    await cats.reorder(boss, 'qualifications', cur);
    expect((await items(boss, 'qualifications')).map((i) => i.value)).toEqual(cur);
    // 并发调整顺序不会留下重复或缺失
    const a = [...cur].reverse();
    await Promise.all([cats.reorder(boss, 'qualifications', a), cats.reorder(boss, 'qualifications', cur)]);
    const fin = (await items(boss, 'qualifications')).map((i) => i.value);
    expect([...fin].sort()).toEqual([...cur].sort());
    await cats.reorder(boss, 'qualifications', cur);
  });

  it('自建分类的值能通过记录保存校验；别的公司不能用；隐藏后不能新选但原记录能继续改', async () => {
    const tag = (await byLabel(boss, 'qualifications', '协会证书')).value;
    const rec = await svc.create(boss, 'qualifications', { name: '协会证书一', type: tag });
    expect(rec.data.type).toBe(tag);
    await expect(svc.create(other, 'qualifications', { name: '外司证书', type: tag })).rejects.toThrow('取值不合法');
    await expect(svc.create(boss, 'qualifications', { name: '乱写', type: 'c_zzzzzzzz' })).rejects.toThrow('取值不合法');
    expect((await byLabel(boss, 'qualifications', '协会证书')).count).toBe(1);
    // 有记录在用：不能删，只能隐藏
    await expect(cats.remove(boss, 'qualifications', tag)).rejects.toThrow('1 条记录在用');
    await cats.update(boss, 'qualifications', tag, { hidden: true });
    expect((await byLabel(boss, 'qualifications', '协会证书')).hidden).toBe(true);
    await expect(svc.create(boss, 'qualifications', { name: '协会证书二', type: tag })).rejects.toThrow('取值不合法');
    const edited = await svc.update(boss, 'qualifications', rec.id, { remark: '改备注' });
    expect(edited.data.type).toBe(tag);
    await expect(svc.update(boss, 'qualifications', rec.id, { type: 'general' })).resolves.toBeTruthy();
    await expect(svc.update(boss, 'qualifications', rec.id, { type: tag })).rejects.toThrow('取值不合法'); // 已隐藏，不能再选回
    await cats.update(boss, 'qualifications', tag, { hidden: false });
    await expect(svc.update(boss, 'qualifications', rec.id, { type: tag })).resolves.toBeTruthy();
  });

  it('列表页签数量、筛选、列筛选统计都按值，名称由前端用本公司名称显示', async () => {
    const tag = (await byLabel(boss, 'qualifications', '协会证书')).value;
    const list = await svc.list(boss, 'qualifications', { tab: tag, pageSize: 50 } as never);
    expect(list.items.map((i) => i.title)).toEqual(['协会证书一']);
    expect(list.tabCounts?.[tag]).toBe(1);
    const facets = await svc.columnFacets(boss, 'qualifications', { key: 'type' });
    expect(facets.items.find((i) => i.value === tag)?.count).toBe(1);
    const filtered = await svc.list(boss, 'qualifications', { colFilters: cf({ key: 'type', op: 'in', values: [tag] }), pageSize: 50 } as never);
    expect(filtered.total).toBe(1);
    expect((await svc.list(other, 'qualifications', { tab: tag } as never)).total).toBe(0);
  });

  it('导出用本公司名称；导入认名称或值（含自建分类、改名后的名称、代码原名），隐藏的不认', async () => {
    const csv = (await svc.exportCsv(boss, 'qualifications', true)).csv;
    expect(csv).toContain('协会证书');
    expect(csv).toContain('品牌授权书');
    expect(csv).not.toContain('c_');
    const tag = (await byLabel(boss, 'qualifications', '协会证书')).value;
    const rows = [
      { 名称: '导入甲', 类型: '协会证书' },
      { 名称: '导入乙', 类型: tag },
      { 名称: '导入丙', 类型: '品牌授权书' },
      { 名称: '导入丁', 类型: '品牌授权' }, // 代码里的原名也认
    ];
    const dry = await svc.importRows(boss, 'qualifications', rows, true);
    expect(dry.failed).toBe(0);
    const res = await svc.importRows(boss, 'qualifications', rows, false);
    expect(res.failed).toBe(0);
    const got = await ds.manager.find(ResourceRecord, { where: { companyId: boss.companyId, type: 'qualifications' } });
    const ty = (t: string) => got.find((r) => r.title === t)?.data.type;
    expect([ty('导入甲'), ty('导入乙'), ty('导入丙'), ty('导入丁')]).toEqual([tag, tag, 'brand_authorization', 'brand_authorization']);
    // 别的公司不认这个名称
    const bad = await svc.importRows(other, 'qualifications', [{ 名称: '外司导入', 类型: '协会证书' }], true);
    expect(JSON.stringify(bad)).toContain('不在可选项里');
    // 隐藏后不认
    await cats.update(boss, 'qualifications', tag, { hidden: true });
    const hid = await svc.importRows(boss, 'qualifications', [{ 名称: '导入戊', 类型: '协会证书' }], true);
    expect(JSON.stringify(hid)).toContain('已隐藏');
    await cats.update(boss, 'qualifications', tag, { hidden: false });
  });

  it('表格保存：新建与修改都能用自建分类，别的公司不行', async () => {
    const tag = (await byLabel(boss, 'qualifications', '协会证书')).value;
    const made = await grid.save(boss, 'qualifications', { creates: [{ clientId: 'n1', data: { name: '表格新建', type: tag } }] });
    expect(JSON.stringify(made)).not.toContain('取值不合法');
    expect(made.saved).toBe(1);
    const bad = await grid.save(other, 'qualifications', { creates: [{ clientId: 'n2', data: { name: '外司表格', type: tag } }] });
    expect(JSON.stringify(bad)).toContain('取值不合法');
  });

  it('删除：自建且零记录才能删；删除后值不再有效；所有改动写审计', async () => {
    const r = await cats.create(boss, 'qualifications', '临时分类');
    await cats.remove(boss, 'qualifications', r.value);
    expect((await items(boss, 'qualifications')).some((i) => i.value === r.value)).toBe(false);
    await expect(svc.create(boss, 'qualifications', { name: '用已删', type: r.value })).rejects.toThrow('取值不合法');
    await expect(cats.remove(boss, 'qualifications', r.value)).rejects.toThrow('不存在');
    const logs = await ds.manager.find(AuditLog, { where: { companyId: boss.companyId, resourceType: 'qualifications' } });
    const actions = new Set(logs.map((l) => l.action));
    for (const a of ['create', 'rename', 'reorder', 'hide', 'show', 'delete']) expect(actions.has(`resource.category.${a}`)).toBe(true);
    expect(logs.every((l) => l.actorId === boss.id)).toBe(true);
  });

  it('其它资料同样可用（店铺平台：自建平台、列表页签、关联摘要用本公司名称）', async () => {
    const p = await cats.create(boss, 'stores', '视频小店');
    const store = await svc.create(boss, 'stores', { name: '自建平台店', platform: p.value, storeNo: 'S-1' });
    expect(store.data.platform).toBe(p.value);
    await expect(svc.create(other, 'stores', { name: '外司店', platform: p.value, storeNo: 'S-2' })).rejects.toThrow('取值不合法');
    const exp = (await svc.exportCsv(boss, 'stores', true)).csv;
    expect(exp).toContain('视频小店');
  });

  it('接口参数：多余字段、非法值被拒（DTO 白名单在 HTTP 层，这里校验服务层空修改）', async () => {
    await expect(cats.update(boss, 'qualifications', 'general', {})).rejects.toThrow('没有要修改');
    await expect(cats.update(boss, 'qualifications', 'c_nonexist', { name: '嗯' })).rejects.toThrow('不存在');
  });
});
