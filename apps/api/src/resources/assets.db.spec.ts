/** 固定资产流转/盘点、位置删除与存放内容、档案关联类型与自动编号的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_c npx jest assets.db */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { OrgAdminService } from '../org/org-admin.service';
import { AssetsService } from './assets.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('固定资产、位置、档案（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let assets: AssetsService;
  let boss: AuthUser;
  let alice: number;
  let bob: number;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    svc = s.resources;
    assets = s.assets;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `a${crypto.randomBytes(5).toString('hex')}`, name: '资产测试', status: 'active' }));
    const mk = (account: string, name: string, admin = false) => ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account, passwordHash: 'x', name, isCompanyAdmin: admin, status: 'active', mustChangePassword: false }));
    const u = await mk('admin', '老板', true);
    alice = (await mk('alice', '小李')).id;
    bob = (await mk('bob', '小王')).id;
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('新建：编号自动生成并递增；填了初始使用人就是使用中', async () => {
    const cat = await svc.create(boss, 'asset-categories', { name: '电脑' });
    ids.cat = cat.id;
    const cat2 = await svc.create(boss, 'asset-categories', { name: '家具' });
    expect(Number(cat.data.sort)).toBe(10);
    expect(Number(cat2.data.sort)).toBe(20);
    const a1 = await svc.create(boss, 'fixed-assets', { name: '笔记本', categoryId: cat.id });
    expect(a1.data.assetNo).toBe('ASSET-000001');
    expect(a1.status).toBe('idle');
    const a2 = await svc.create(boss, 'fixed-assets', { name: '台式机', categoryId: cat.id, userId: alice });
    expect(a2.data.assetNo).toBe('ASSET-000002');
    expect(a2.status).toBe('in_use');
    ids.a1 = a1.id; ids.a2 = a2.id;
    await expect(svc.create(boss, 'fixed-assets', { name: '手填', assetNo: 'ASSET-000001' })).rejects.toThrow(/已存在/);
    await expect(svc.create(boss, 'fixed-assets', { name: '直接报废' }, 'retired')).rejects.toThrow(/只能是闲置或使用中/);
  });

  it('状态和使用人只能通过流转动作改，编辑和通用改状态都不行', async () => {
    await expect(svc.changeStatus(boss, 'fixed-assets', ids.a1, 'in_use')).rejects.toThrow(/请用/);
    const edited = await svc.update(boss, 'fixed-assets', ids.a2, { userId: bob, brand: '联想' });
    expect(edited.data.userId).toBe(alice);
    expect(edited.data.brand).toBe('联想');
  });

  it('领用 → 转交 → 归还：必填使用人、状态机限制、流转记录', async () => {
    await expect(assets.transition(boss, ids.a1, { action: 'checkout' })).rejects.toThrow(/必须选择使用人/);
    await expect(assets.transition(boss, ids.a1, { action: 'return' })).rejects.toThrow(/当前状态不能归还/);
    const loc = await svc.create(boss, 'locations', { name: '302 房', scope: 'area', locationType: 'room' });
    ids.loc = loc.id;
    const out = await assets.transition(boss, ids.a1, { action: 'checkout', userId: alice, locationId: loc.id, note: '入职配发' });
    expect(out.status).toBe('in_use');
    expect(out.data.userId).toBe(alice);
    expect(out.data.locationId).toBe(loc.id);
    await expect(assets.transition(boss, ids.a1, { action: 'transfer', userId: alice })).rejects.toThrow(/另一位/);
    const t = await assets.transition(boss, ids.a1, { action: 'transfer', userId: bob });
    expect(t.data.userId).toBe(bob);
    const r = await assets.transition(boss, ids.a1, { action: 'return' });
    expect(r.status).toBe('idle');
    expect(r.data.userId).toBeUndefined();
    const details = await assets.details(boss, ids.a1);
    const actions = details.operationLogs.map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['create', 'checkout', 'transfer', 'return']));
    expect(details.operationLogs.find((l) => l.action === 'checkout')?.note).toContain('使用人：小李');
  });

  it('送修（必填原因）→ 修好（按有无使用人回到使用中/闲置）→ 丢失 → 找回 → 报废（终态）', async () => {
    await expect(assets.transition(boss, ids.a2, { action: 'repair' })).rejects.toThrow(/必须填写原因/);
    const rep = await assets.transition(boss, ids.a2, { action: 'repair', reason: '屏幕坏了' });
    expect(rep.status).toBe('repairing');
    expect(rep.statusReason).toBe('屏幕坏了');
    const fixed = await assets.transition(boss, ids.a2, { action: 'repaired' });
    expect(fixed.status).toBe('in_use'); // 有使用人
    await assets.transition(boss, ids.a1, { action: 'repair', reason: '风扇响' });
    expect((await assets.transition(boss, ids.a1, { action: 'repaired' })).status).toBe('idle'); // 没有使用人
    const lost = await assets.transition(boss, ids.a2, { action: 'lost', reason: '盘点未找到' });
    expect(lost.status).toBe('lost');
    const found = await assets.transition(boss, ids.a2, { action: 'found' });
    expect(found.status).toBe('idle');
    expect(found.data.userId).toBeUndefined();
    await expect(assets.transition(boss, ids.a2, { action: 'retire' })).rejects.toThrow(/必须填写原因/);
    const gone = await assets.transition(boss, ids.a2, { action: 'retire', reason: '主板损坏' });
    expect(gone.status).toBe('retired');
    await expect(assets.transition(boss, ids.a2, { action: 'checkout', userId: bob })).rejects.toThrow(/当前状态不能领用/);
    await expect(assets.transition(boss, ids.a2, { action: 'found' })).rejects.toThrow(/当前状态不能找回/);
  });

  it('盘点：在位记录、位置变动更正、未找到标记丢失；报废的跳过', async () => {
    const a3 = await svc.create(boss, 'fixed-assets', { name: '打印机' });
    const a4 = await svc.create(boss, 'fixed-assets', { name: '投影仪', locationId: ids.loc });
    const room2 = await svc.create(boss, 'locations', { name: '303 房', scope: 'area' });
    const res = await assets.inventory(boss, [
      { id: a3.id, result: 'present' },
      { id: a4.id, result: 'moved', locationId: room2.id },
      { id: ids.a1, result: 'missing' },
      { id: ids.a2, result: 'present' },
      { id: 999999, result: 'present' },
      { id: a3.id, result: 'present' },
    ], '十月盘点');
    expect(res).toMatchObject({ present: 1, moved: 1, missing: 1 });
    expect(res.skipped.sort()).toEqual([ids.a2, 999999, a3.id].sort());
    expect((await svc.get(boss, 'fixed-assets', a4.id)).data.locationId).toBe(room2.id);
    expect((await svc.get(boss, 'fixed-assets', ids.a1)).status).toBe('lost');
    const logs = (await assets.details(boss, a3.id)).operationLogs;
    expect(logs.find((l) => l.action === 'inventory_checked')?.note).toContain('十月盘点');
    ids.a4 = a4.id; ids.room2 = room2.id;
  });

  it('公司隔离：别家公司的资产不能流转', async () => {
    const c2 = await ds.manager.save(Company, ds.manager.create(Company, { code: `b${crypto.randomBytes(5).toString('hex')}`, name: '别家', status: 'active' }));
    const u2 = await ds.manager.save(User, ds.manager.create(User, { companyId: c2.id, account: 'x', passwordHash: 'x', name: '外人', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    const other: AuthUser = { id: u2.id, companyId: c2.id, name: '外人', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    await expect(assets.transition(other, ids.a1, { action: 'repair', reason: 'x' })).rejects.toThrow(/不存在/);
    await expect(assets.details(other, ids.a1)).rejects.toThrow(/不存在/);
  });

  it('位置“存放内容”按引用列出；删除位置把各处引用清空而不是拒绝', async () => {
    const arch = await svc.create(boss, 'archives', { name: '合同原件', locationId: ids.room2 });
    const contents = await assets.locationContents(boss, ids.room2, () => true);
    expect(contents.map((g) => g.type)).toEqual(expect.arrayContaining(['archives', 'fixed-assets']));
    expect(contents.find((g) => g.type === 'archives')!.items[0].slots).toContain('存放位置');
    const child = await svc.create(boss, 'locations', { name: '抽屉', scope: 'area', parentId: ids.room2 });
    await expect(svc.remove(boss, 'locations', ids.room2, '')).rejects.toThrow(/原因/);
    await svc.remove(boss, 'locations', ids.room2, '房间已退租');
    expect((await svc.get(boss, 'archives', arch.id)).data.locationId).toBeUndefined();
    expect((await svc.get(boss, 'fixed-assets', ids.a4)).data.locationId).toBeUndefined();
    expect((await svc.get(boss, 'locations', child.id)).data.parentId).toBeUndefined();
    const log = await svc.logs(boss, 'archives', arch.id);
    expect(log[0].note).toContain('已删除');
  });

  it('档案：自动编号 ARCH-，8 种关联资料类型各对应一个关联字段，换类型会清掉旧关联', async () => {
    const a = await svc.create(boss, 'archives', { name: '资产合同', relatedType: 'fixed_asset', fixedAssetId: ids.a1 });
    expect(a.data.archiveNo).toMatch(/^ARCH-\d{6}$/);
    expect(a.data.fixedAssetId).toBe(ids.a1);
    const changed = await svc.update(boss, 'archives', a.id, { relatedType: '' });
    expect(changed.data.fixedAssetId).toBeUndefined();
    const types = ['license', 'store', 'bank_account', 'fixed_asset', 'partner_profile', 'trademark', 'qualification', 'tax_profile'];
    const { getResourceDef } = await import('@kudesi/shared');
    const opts = getResourceDef('archives')!.fields.find((f) => f.key === 'relatedType')!.options!.map((o) => o.value);
    expect(opts).toEqual(types);
    const b = await svc.create(boss, 'archives', { name: '二', relatedType: 'trademark' });
    expect(b.data.archiveNo).not.toBe(a.data.archiveNo);
    await expect(svc.changeStatus(boss, 'archives', b.id, 'borrowed')).rejects.toThrow(/原因/);
    expect((await svc.changeStatus(boss, 'archives', b.id, 'borrowed', '借给财务')).status).toBe('borrowed');
  });

  it('删除部门时固定资产的所属部门一起转走并写流转记录；没有接收部门就不让删', async () => {
    const org = new OrgAdminService(ds);
    const mk = async (name: string) => Number((await ds.manager.query('INSERT INTO departments (company_id, parent_id, name, sort_order) VALUES (?, NULL, ?, 0)', [boss.companyId, name])).insertId);
    const from = await mk('行政部'), to = await mk('综合部');
    const a = await svc.create(boss, 'fixed-assets', { name: '行政打印机', departmentId: from });
    await expect(org.deleteDepartment(boss, from)).rejects.toThrow(/接收部门/);
    const r = await org.deleteDepartment(boss, from, to);
    expect(r.moved.assets).toBe(1);
    expect((await svc.get(boss, 'fixed-assets', a.id)).data.departmentId).toBe(to);
    const flow = (await assets.details(boss, a.id)).operationLogs.find((l) => l.action === 'department_transferred');
    expect(flow?.note).toContain('综合部');
  });
});
