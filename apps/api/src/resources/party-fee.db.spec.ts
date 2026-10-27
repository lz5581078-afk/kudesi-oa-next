import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { FeeArchiveService } from './fee-archive.service';
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
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `f${crypto.randomBytes(5).toString('hex')}`, name: '费用测试', status: 'active' }));
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
});
