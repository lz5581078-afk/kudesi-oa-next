/** 人力成本表（版本、归档分类树、字典、工作项目）的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_b npx jest labor.db */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { LaborCopyService } from './labor-copy.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('人力成本表（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `l${crypto.randomBytes(5).toString('hex')}`, name: '人力测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
  });
  afterAll(async () => { await ds?.destroy(); });

  it('版本：编号唯一、日期顺序、默认版本只能是已启用的且全公司只有一个', async () => {
    const v1 = await svc.create(boss, 'finance-labor-versions', { versionCode: 'V2026A', versionName: '2026春', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' });
    ids.v1 = v1.id;
    await expect(svc.create(boss, 'finance-labor-versions', { versionCode: 'V2026A', versionName: '重复' })).rejects.toThrow(/已存在/);
    await expect(svc.create(boss, 'finance-labor-versions', { versionCode: 'X', versionName: 'x', effectiveFrom: '2026-02-01', effectiveTo: '2026-01-01' })).rejects.toThrow(/不能早于/);
    await expect(svc.update(boss, 'finance-labor-versions', v1.id, { isDefault: true })).rejects.toThrow(/已启用/);
    await expect(svc.changeStatus(boss, 'finance-labor-versions', v1.id, 'active')).rejects.toThrow(/至少维护一条/);
    const v2 = await svc.create(boss, 'finance-labor-versions', { versionCode: 'V2026B', versionName: '2026秋' });
    ids.v2 = v2.id;
    const category = await svc.create(boss, 'finance-labor-categories', { versionId: v2.id, name: '默认版本初始分类' });
    const workType = await svc.create(boss, 'finance-labor-work-types', { name: '默认版本测试分类' });
    const unit = await svc.create(boss, 'finance-labor-units', { name: '默认版本测试单位' });
    await svc.create(boss, 'finance-labor-costs', { versionId: v2.id, archiveCategoryId: category.id, workTypeId: workType.id, unitId: unit.id, workName: '启用前初始项目', unitPrice: 100 });
    await svc.changeStatus(boss, 'finance-labor-versions', v2.id, 'active');
    await svc.update(boss, 'finance-labor-versions', v2.id, { isDefault: true });
    expect((await svc.get(boss, 'finance-labor-versions', v2.id)).data.isDefault).toBe(true);
  });

  it('归档分类：最多三级、同级不重名、不能成环、不能换版本', async () => {
    const a = await svc.create(boss, 'finance-labor-categories', { versionId: ids.v1, name: '包装车间' });
    expect(a.data.code).toBe('BZCJ');
    const b = await svc.create(boss, 'finance-labor-categories', { versionId: ids.v1, name: '礼盒', parentId: a.id });
    const c = await svc.create(boss, 'finance-labor-categories', { versionId: ids.v1, name: '大礼盒', parentId: b.id });
    ids.catA = a.id; ids.catB = b.id; ids.catC = c.id;
    await expect(svc.create(boss, 'finance-labor-categories', { versionId: ids.v1, name: '第四级', parentId: c.id })).rejects.toThrow(/最多3级/);
    await expect(svc.create(boss, 'finance-labor-categories', { versionId: ids.v1, name: '礼盒', parentId: a.id })).rejects.toThrow(/已经有/);
    await expect(svc.update(boss, 'finance-labor-categories', a.id, { parentId: c.id })).rejects.toThrow(/自己的下级/);
    await expect(svc.update(boss, 'finance-labor-categories', b.id, { versionId: ids.v2 })).rejects.toThrow(/别的版本/);
    const other = await svc.create(boss, 'finance-labor-categories', { versionId: ids.v2, name: '别处' });
    ids.catOther = other.id;
    await expect(svc.create(boss, 'finance-labor-categories', { versionId: ids.v1, name: '跨版本', parentId: other.id })).rejects.toThrow(/同一个版本/);
  });

  it('字典：工作分类和计价单位可维护、重名拒绝、编码自动取拼音首字母', async () => {
    const wt = await svc.create(boss, 'finance-labor-work-types', { name: '包装' });
    expect(wt.data.code).toBe('BZ');
    ids.wt = wt.id;
    await expect(svc.create(boss, 'finance-labor-work-types', { name: '包装' })).rejects.toThrow(/已存在/);
    ids.unit = (await svc.create(boss, 'finance-labor-units', { name: '元/个' })).id;
    ids.unit2 = (await svc.create(boss, 'finance-labor-units', { name: '元/小时' })).id;
  });

  it('工作项目：必须放最末级分类、零值要写原因、自动工作编号、查重', async () => {
    const base = { versionId: ids.v1, workTypeId: ids.wt, unitId: ids.unit, workName: '装礼盒', unitPrice: 150 };
    await expect(svc.create(boss, 'finance-labor-costs', { ...base, archiveCategoryId: ids.catA })).rejects.toThrow(/最末级/);
    await expect(svc.create(boss, 'finance-labor-costs', { ...base, archiveCategoryId: ids.catOther })).rejects.toThrow(/不属于/);
    await expect(svc.create(boss, 'finance-labor-costs', { ...base, archiveCategoryId: ids.catC, unitPrice: 0 })).rejects.toThrow(/零值原因/);
    const item = await svc.create(boss, 'finance-labor-costs', { ...base, archiveCategoryId: ids.catC });
    expect(item.data.workCode).toBe('RL-V2026A-BZCJ-LH-DLH-BZ-ZLH');
    ids.item = item.id;
    // 启用版本：自动成为默认版本，原默认版本取消
    await svc.changeStatus(boss, 'finance-labor-versions', ids.v1, 'active');
    expect((await svc.get(boss, 'finance-labor-versions', ids.v1)).data.activatedAt).toBeTruthy();
    expect((await svc.get(boss, 'finance-labor-versions', ids.v1)).data.isDefault).toBe(true);
    expect((await svc.get(boss, 'finance-labor-versions', ids.v2)).data.isDefault).toBeFalsy();
    await expect(svc.create(boss, 'finance-labor-costs', { ...base, archiveCategoryId: ids.catC, workName: ' 装礼盒 ' })).rejects.toThrow(/已存在/);
    const zero = await svc.create(boss, 'finance-labor-costs', { ...base, archiveCategoryId: ids.catC, workName: '贴标', unitPrice: 0, zeroReason: '外包赠送，不另收费', zeroCostConfirmation: { reason: '外包赠送，不另收费', context: JSON.stringify(['贴标', '元/个', '包装']) } });
    expect(zero.data.zeroReason).toBe('外包赠送，不另收费');
    ids.zero = zero.id;
    await svc.update(boss, 'finance-labor-costs', zero.id, { unitPrice: 20 });
    expect((await svc.get(boss, 'finance-labor-costs', zero.id)).data.zeroReason).toBeUndefined();
  });

  it('上级改名后工作编号同步刷新；有工作项目的分类不能再分下级', async () => {
    await svc.update(boss, 'finance-labor-categories', ids.catC, { name: '特大礼盒', code: 'TD' });
    expect((await svc.get(boss, 'finance-labor-costs', ids.item)).data.workCode).toBe('RL-V2026A-BZCJ-LH-TD-BZ-ZLH');
    await svc.update(boss, 'finance-labor-work-types', ids.wt, { code: 'PK' });
    expect((await svc.get(boss, 'finance-labor-costs', ids.item)).data.workCode).toBe('RL-V2026A-BZCJ-LH-TD-PK-ZLH');
    const root = await svc.create(boss, 'finance-labor-categories', { versionId: ids.v1, name: '仓库' });
    await svc.create(boss, 'finance-labor-costs', { versionId: ids.v1, archiveCategoryId: root.id, workTypeId: ids.wt, unitId: ids.unit, workName: '搬运', unitPrice: 10 });
    await expect(svc.create(boss, 'finance-labor-categories', { versionId: ids.v1, name: '再分', parentId: root.id })).rejects.toThrow(/不能再分下级/);
  });

  it('被成品构成引用后：不能删除、不能换版本和单位、不能停用；改价会重算成品成本；停用的版本不能被新引用', async () => {
    const sm = await svc.create(boss, 'finance-categories', { archiveType: 'self_made', name: '礼盒自制', code: 'LH' });
    const brand = await svc.create(boss, 'finance-brands', { name: '果园' });
    const box = await svc.create(boss, 'finance-products', { archiveType: 'self_made', name: '人工礼盒', categoryId: sm.id, brandId: brand.id, specQty: 1, specUnit: 'BOX', freight: 100, handlingFee: 100 });
    await svc.create(boss, 'finance-product-boms', { productId: box.id, laborId: ids.item, qty: 2 });
    expect((await svc.get(boss, 'finance-products', box.id)).data.totalCost).toBe(500);
    await expect(svc.remove(boss, 'finance-labor-costs', ids.item, '不要了')).rejects.toThrow(/草稿版本|引用/);
    await expect(svc.update(boss, 'finance-labor-costs', ids.item, { unitId: ids.unit2 })).rejects.toThrow(/不能换计价单位/);
    await expect(svc.update(boss, 'finance-labor-costs', ids.item, { versionId: ids.v2, archiveCategoryId: ids.catOther })).rejects.toThrow(/不能换成本版本/);
    await expect(svc.changeStatus(boss, 'finance-labor-costs', ids.item, 'inactive', '测试停用原因')).rejects.toThrow(/不能停用/);
    await svc.update(boss, 'finance-labor-costs', ids.item, { unitPrice: 200 });
    expect((await svc.get(boss, 'finance-products', box.id)).data.totalCost).toBe(600);
    // 未启用的版本里的项目不能被引用
    const draft = await svc.create(boss, 'finance-labor-versions', { versionCode: 'DRAFT', versionName: '草稿版' });
    const dc = await svc.create(boss, 'finance-labor-categories', { versionId: draft.id, name: '草稿类' });
    const di = await svc.create(boss, 'finance-labor-costs', { versionId: draft.id, archiveCategoryId: dc.id, workTypeId: ids.wt, unitId: ids.unit, workName: '草稿活', unitPrice: 5 });
    await expect(svc.create(boss, 'finance-product-boms', { productId: box.id, laborId: di.id, qty: 1 })).rejects.toThrow(/还没启用/);
    // 只有草稿里的未引用项目可删，启用版即使未引用也不能删。
    await expect(svc.remove(boss, 'finance-labor-costs', ids.zero, '测试删除')).rejects.toThrow(/草稿版本/);
    await svc.remove(boss, 'finance-labor-costs', di.id, '测试删除未引用草稿项目');
  });

  it('复制版本：带走分类树和全部项目（含停用的），保留原编号；新版本是草稿且普通新建仍按中文版本取拼音；重复整体无残余', async () => {
    const copy = new LaborCopyService(ds, svc);
    const before = (await svc.list(boss, 'finance-labor-costs', { pageSize: 200, showHidden: true } as never)).total;
    const r = await copy.copyVersion(boss, ids.v1, { versionCode: 'RL-秋季版', versionName: '2026秋复制', periodName: '秋' });
    const nv = await svc.get(boss, 'finance-labor-versions', r.id);
    expect(nv.status).toBe('draft');
    const srcItems = (await svc.list(boss, 'finance-labor-costs', { fieldKey: 'versionId', fieldValue: ids.v1, pageSize: 200, showHidden: true } as never)).items;
    const newItems = (await svc.list(boss, 'finance-labor-costs', { fieldKey: 'versionId', fieldValue: r.id, pageSize: 200, showHidden: true } as never)).items;
    expect(newItems).toHaveLength(srcItems.length);
    expect(r.items).toBe(srcItems.length);
    const a = srcItems.find((i) => i.id === ids.item)!;
    const b = newItems.find((i) => i.data.workName === a.data.workName)!;
    expect(b.data.unitPrice).toBe(a.data.unitPrice);
    expect(b.data.workCode).toBe(a.data.workCode); // 24号版本复制保留原工作编号，普通新建/编辑才按当前版本生成。
    expect(b.data.archiveCategoryId).not.toBe(a.data.archiveCategoryId);
    expect(b.refLabels.archiveCategoryId).toBe(a.refLabels.archiveCategoryId);
    expect((await svc.codePreview(boss, 'finance-labor-costs', { versionId: r.id, archiveCategoryId: b.data.archiveCategoryId, workTypeId: b.data.workTypeId, workName: '新工作预览' })).code).toContain('QJB');
    const total = (await svc.list(boss, 'finance-labor-costs', { pageSize: 200, showHidden: true } as never)).total;
    await expect(copy.copyVersion(boss, ids.v1, { versionCode: 'RL-秋季版', versionName: '重复' })).rejects.toThrow(/已存在/);
    expect((await svc.list(boss, 'finance-labor-costs', { pageSize: 200, showHidden: true } as never)).total).toBe(total);
    expect(total).toBe(before + srcItems.length);
  });
});
