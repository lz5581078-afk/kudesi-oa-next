/** 单位与规格：公司级名称+编码列表；商品档案下拉读它，没维护的种类退回内置选项；被商品用到的编码不能改、不能删 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('单位与规格（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let catId: number;
  const product = (extra: Record<string, unknown>) => ({ archiveType: 'raw', name: `单位苹果${crypto.randomBytes(3).toString('hex')}`, categoryId: catId, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 100, handlingFee: 50, ...extra });

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `u${crypto.randomBytes(5).toString('hex')}`, name: '单位测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    catId = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('公司没维护时退回内置选项；导入默认项后只能选列表里的', async () => {
    await svc.create(boss, 'finance-products', product({}));
    const r = await svc.seedUnitDefaults(boss);
    expect(r.added).toBeGreaterThan(20);
    expect((await svc.seedUnitDefaults(boss)).added).toBe(0); // 重复导入不增加
    await expect(svc.create(boss, 'finance-products', product({ specUnit: 'ZZZ' }))).rejects.toThrow('规格单位的取值不合法');
    const opts = await svc.unitOptions(boss);
    expect(opts.spec_unit.find((o) => o.value === 'KG')?.label).toBe('千克');
    expect(opts.system_spec.map((o) => o.label)).toContain('斤');
  });

  it('新增自定义单位：编码自动生成，商品能选；基础信息全称用名称', async () => {
    const u = await svc.create(boss, 'finance-product-units', { kind: 'spec_unit', name: '托盘' });
    expect(u.data.code).toBe('TP'); // 拼音首字母
    const p = await svc.create(boss, 'finance-products', product({ specUnit: u.data.code }));
    expect(String(p.data.basicInfoFullName)).toContain('-1-托盘');
    await expect(svc.create(boss, 'finance-product-units', { kind: 'spec_unit', name: '托盘' })).rejects.toThrow('同名');
    await expect(svc.create(boss, 'finance-product-units', { kind: 'spec_unit', name: '另一个', code: 'TP' })).rejects.toThrow('相同编码');
  });

  it('发货物料的规格单位读“发货物料规格单位”', async () => {
    await svc.create(boss, 'finance-product-units', { kind: 'shipping_unit', name: '卷', code: 'ROLL' });
    const base = { archiveType: 'shipping_material', name: '胶带', specQty: 1, categoryId: (await svc.create(boss, 'finance-categories', { archiveType: 'shipping_material', name: '胶带类', code: 'JD' })).id };
    await expect(svc.create(boss, 'finance-products', { ...base, specUnit: 'ZZZ' })).rejects.toThrow('规格单位的取值不合法');
    const ok = await svc.create(boss, 'finance-products', { ...base, specUnit: 'ROLL' }).catch((e) => e);
    // 其余必填项和本测试无关；只要不是“取值不合法”就说明单位通过了
    expect(String((ok as Error).message ?? '')).not.toContain('取值不合法');
  });

  it('被商品用到的编码不能改、不能删；没用到的可以', async () => {
    const used = (await svc.list(boss, 'finance-product-units', { fieldKey: 'kind', fieldValue: 'spec_unit' } as never)).items.find((i) => i.data.code === 'KG')!;
    await expect(svc.update(boss, 'finance-product-units', used.id, { code: 'KGS' })).rejects.toThrow('已被商品档案使用');
    await expect(svc.remove(boss, 'finance-product-units', used.id, '测试删除')).rejects.toThrow('已被');
    const free = await svc.create(boss, 'finance-product-units', { kind: 'dimension_unit', name: '英寸', code: 'IN' });
    await svc.update(boss, 'finance-product-units', free.id, { code: 'INCH' });
    await svc.remove(boss, 'finance-product-units', free.id, '测试删除');
  });

  it('导入商品时单位按名称或编码对应', async () => {
    const rows = [{ 档案类型: '原料档案', 名称: '导入苹果', 分类: '水果', 系统规格: '千克', 规格数量: '2', 规格单位: '千克', 采购价: '10', 运费: '1', 装卸费: '0.5' }];
    const res = await svc.importRows(boss, 'finance-products', rows, true);
    expect(JSON.stringify(res.results[0].errors)).not.toContain('规格单位');
  });
});
