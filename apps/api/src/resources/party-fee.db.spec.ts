import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { FeeArchiveService } from './fee-archive.service';
import { FeeSnapshotService } from './fee-snapshot.service';
import { hasFeeDefaults } from '@kudesi/shared';
import { applyFeeBookingFix, planFeeBookingFix } from './fee-booking-fix';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('费用档案：仓库/公户挂账节点（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `f${crypto.randomBytes(5).toString('hex')}`, name: '山东优冠种业费用测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `ff${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false } as never));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('种子导入保留“仓库”，“公户”转成“公司公户”；修正脚本只找回被丢成不固定的', async () => {
    await new FeeArchiveService(ds, svc).seed(boss);
    const fy16 = (await svc.list(boss, 'finance-fee-items', { keyword: 'FY-016', page: 1, pageSize: 5 } as never)).items[0] as { id: number; data: Record<string, unknown> };
    expect(fy16.data.defaultObject).toBe('公司公户');
    expect(fy16.data.requiredObject).toBe('yes');
    const wh = (await svc.list(boss, 'finance-fee-items', { keyword: 'FY-042', page: 1, pageSize: 5 } as never)).items[0] as { id: number; data: Record<string, unknown> };
    expect(String(wh.data.defaultObject)).toContain('仓库');

    // 模拟旧数据：被丢成不固定
    await ds.query("UPDATE resource_records SET data = JSON_SET(data, '$.defaultObject', '不固定', '$.requiredObject', 'no') WHERE id IN (?, ?)", [fy16.id, wh.id]);
    const plan = await planFeeBookingFix(ds.manager, boss.companyId);
    expect(plan.map((p) => p.id).sort()).toEqual([fy16.id, wh.id].sort());
    expect(await planFeeBookingFix(ds.manager, boss.companyId)).toHaveLength(2); // 计划不改数据
    expect(await applyFeeBookingFix(ds, svc, boss, plan)).toEqual({ fixed: 2 });
    expect((await svc.get(boss, 'finance-fee-items', fy16.id)).data.defaultObject).toBe('公司公户');
    expect(await planFeeBookingFix(ds.manager, boss.companyId)).toHaveLength(0);
  }, 120000);

  it('供应商：长编码 GYS-主类码-类码-首字母；分类码不能重复；必须选末级分类；重复拒绝；批量移动分类', async () => {
    const main = await svc.create(boss, 'finance-supplier-categories', { name: '种子供应商' });
    const leaf = await svc.create(boss, 'finance-supplier-categories', { name: '玉米', parentId: main.id });
    const leaf2 = await svc.create(boss, 'finance-supplier-categories', { name: '小麦', parentId: main.id });
    expect(main.data.categoryCode).toBe('ZZGYS');
    await expect(svc.create(boss, 'finance-supplier-categories', { name: '别的', categoryCode: 'ym' })).rejects.toThrow(/已被/);
    await expect(svc.create(boss, 'finance-suppliers', { name: '无分类供应商' })).rejects.toThrow(/分类/);
    await expect(svc.create(boss, 'finance-suppliers', { name: '只选大类', categoryIds: [main.id] })).rejects.toThrow(/最末级/);
    const a = await svc.create(boss, 'finance-suppliers', { name: '润农种业', categoryIds: [leaf.id], phone: '13800001111' });
    expect(a.data.code).toBe('GYS-ZZGYS-YM-RNZY');
    const b = await svc.create(boss, 'finance-suppliers', { name: '润农装业', categoryIds: [leaf.id], phone: '13800002222', shortName: '润农装', code: undefined });
    expect(b.data.code).toBe('GYS-ZZGYS-YM-RNZY2');
    await expect(svc.create(boss, 'finance-suppliers', { name: '润农种业', categoryIds: [leaf.id], phone: '13800001111' })).rejects.toThrow(/重复/);
    const sim = await svc.similarCheck(boss, 'finance-suppliers', { name: '润农种业有限公司', phone: '13800001111' });
    expect(sim.warnings.map((w) => w.id)).toContain(a.id);
    // 只停用不触发查重
    await svc.changeStatus(boss, 'finance-suppliers', a.id, 'inactive', '测试');
    const r = await svc.batchUpdate(boss, 'finance-suppliers', [a.id, b.id], { categoryIds: [leaf2.id] });
    expect(r.done).toBe(2);
    expect((await svc.get(boss, 'finance-suppliers', b.id)).data.categoryIds).toEqual([leaf2.id]);
  }, 60000);

  it('费用档案存档表：存档、改动后恢复（原编号还原，多出来的停用），恢复前自动备份；没权限不行', async () => {
    const snaps = new FeeSnapshotService(ds, svc);
    const cats = (await svc.list(boss, 'finance-fee-categories', { pageSize: 1 } as never)).total;
    const fy16 = (await svc.list(boss, 'finance-fee-items', { keyword: 'FY-016', page: 1, pageSize: 5 } as never)).items[0] as { id: number; title: string };
    const s = await snaps.create(boss, '改前', '测试');
    expect(s.itemCount).toBeGreaterThan(300);
    await svc.update(boss, 'finance-fee-items', fy16.id, { name: '被改了' });
    const extra = await svc.create(boss, 'finance-fee-items', { name: '新加的费用', direction: 'expense' });
    const view = await snaps.view(boss, s.id);
    expect(view.items.find((i) => i.code === 'FY-016')?.name).toBe(fy16.title);
    const r = await snaps.restore(boss, s.id);
    expect(r.stopped).toBeGreaterThanOrEqual(1);
    expect((await svc.get(boss, 'finance-fee-items', fy16.id)).title).toBe(fy16.title);
    expect((await svc.get(boss, 'finance-fee-items', extra.id)).status).toBe('inactive');
    expect((await svc.list(boss, 'finance-fee-categories', { pageSize: 1 } as never)).total).toBe(cats);
    const list = await snaps.list(boss);
    expect(list.some((x) => x.auto && x.name.includes('自动备份'))).toBe(true);
    const clerk = { ...boss, permissions: { isCompanyAdmin: false, allow: [], deny: [] } } as AuthUser;
    await expect(snaps.create(clerk, 'x')).rejects.toThrow(/权限/);
    await snaps.remove(boss, s.id);
    await expect(snaps.view(boss, s.id)).rejects.toThrow(/不存在/);
  }, 120000);
});

d('默认费用档案只给山东优冠种业（真实数据库）', () => {
  it('名称里不含“山东优冠种业”的公司导入默认费用档案被拒绝，什么都不建；含的可以', async () => {
    const ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    try {
      const svc = buildServices(ds).resources;
      const mk = async (name: string) => {
        const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `g${crypto.randomBytes(5).toString('hex')}`, name, status: 'active' }));
        const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `fg${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false } as never));
        return { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser;
      };
      const other = await mk('别家公司');
      await expect(new FeeArchiveService(ds, svc).seed(other)).rejects.toThrow(/只提供给山东优冠种业/);
      expect((await svc.list(other, 'finance-fee-categories', { pageSize: 5 } as never)).total).toBe(0);
      expect(hasFeeDefaults('山东优冠种业有限公司')).toBe(true);
      expect(hasFeeDefaults('别家公司')).toBe(false);
      expect(hasFeeDefaults(undefined)).toBe(false);
    } finally { await ds.destroy(); }
  });
});

d('往来分类移动：只能在本一级分类树里挪（旧 contactCategoryMoveParents）（真实数据库）', () => {
  it('不能跨一级分类、不能挪成一级、一级不能挪走、不能挪进自己的下级；同一棵树里可以换上级且名下的往来对象保留', async () => {
    const ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    try {
      const svc = buildServices(ds).resources;
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `m${crypto.randomBytes(5).toString('hex')}`, name: '分类移动测试', status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `fm${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false } as never));
      const boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } as AuthUser;
      for (const type of ['finance-supplier-categories', 'finance-customer-categories']) {
        const a = await svc.create(boss, type, { name: '甲类' });
        const b = await svc.create(boss, type, { name: '乙类' });
        const a1 = await svc.create(boss, type, { name: '甲一', parentId: a.id });
        const a2 = await svc.create(boss, type, { name: '甲二', parentId: a.id });
        const a11 = await svc.create(boss, type, { name: '甲一一', parentId: a1.id });
        const b1 = await svc.create(boss, type, { name: '乙一', parentId: b.id });
        await expect(svc.update(boss, type, a1.id, { parentId: b.id })).rejects.toThrow(/别的一级分类/);
        await expect(svc.update(boss, type, a1.id, { parentId: b1.id })).rejects.toThrow(/别的一级分类/);
        await expect(svc.update(boss, type, a1.id, { parentId: null })).rejects.toThrow(/不能挪成一级/);
        await expect(svc.update(boss, type, a.id, { parentId: b.id })).rejects.toThrow(/一级分类不能挪/);
        await expect(svc.update(boss, type, a1.id, { parentId: a11.id })).rejects.toThrow(/自己的下级/);
        await expect(svc.update(boss, type, a1.id, { parentId: a1.id })).rejects.toThrow(/自己的下级/);
        const moved = await svc.update(boss, type, a11.id, { parentId: a2.id });
        expect(moved.refLabels.parentId).toBe('甲类 / 甲二');
        expect((await svc.update(boss, type, a11.id, { name: '甲一一改名' })).title).toBe('甲一一改名'); // 不换上级的修改不受影响
      }
    } finally { await ds.destroy(); }
  });
});
