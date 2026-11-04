import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('人工归档目录的唯一范围与完整排序（隔离数据库）', () => {
  let ds: DataSource, svc: ResourcesService, actor: AuthUser, workType: number, unit: number;
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize(); svc = buildServices(ds).resources;
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `lco${crypto.randomBytes(5).toString('hex')}`, name: '合成人工归档验收', status: 'active' }));
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '合成管理员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    actor = { id: user.id, companyId: company.id, name: user.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    workType = (await svc.create(actor, 'finance-labor-work-types', { name: '合成分类' })).id;
    unit = (await svc.create(actor, 'finance-labor-units', { name: '件' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });
  const version = (code: string) => svc.create(actor, 'finance-labor-versions', { versionCode: code, versionName: `合成${code}` });
  const category = (versionId: number, name: string, code: string, parentId?: number) => svc.create(actor, 'finance-labor-categories', { versionId, name, code, ...(parentId ? { parentId } : {}) });

  it('标识在整个版本内唯一，名称只在同上级查重且保留内部空格', async () => {
    const v = await version('RL-CAT-UNIQUE');
    const a = await category(v.id, '合成根甲', 'ROOTA'), b = await category(v.id, '合成根乙', 'ROOTB');
    const child = await category(v.id, '合成分类', 'SAME', a.id);
    await expect(category(v.id, '不同父级', 'SAME', b.id)).rejects.toThrow(/同一版本.*标识/);
    const spaced = await category(v.id, '分类 A', 'GAP1', b.id);
    await category(v.id, '分类A', 'GAP2', b.id);
    await expect(category(v.id, '分类 A', 'GAP3', b.id)).rejects.toThrow(/同一级/);
    await expect(svc.update(actor, 'finance-labor-categories', spaced.id, { code: 'SAME', name: '不得留下改名' })).rejects.toThrow(/同一版本/);
    expect((await svc.get(actor, 'finance-labor-categories', spaced.id)).data).toMatchObject({ name: '分类 A', code: 'GAP1' });
    const other = await version('RL-CAT-OTHER');
    await category(other.id, '其他版本允许同标识', 'SAME');
    await svc.remove(actor, 'finance-labor-categories', child.id, '合成删除释放标识');
    expect((await category(v.id, '删除后复用标识', 'SAME', b.id)).data.code).toBe('SAME');
  });

  it('同级完整排序按版本/公司/权限隔离，停用版本拒绝；引用数为实际直属项目', async () => {
    const v = await version('RL-TREE-SORT');
    const a = await category(v.id, '合成排序甲', 'ORDERA'), b = await category(v.id, '合成排序乙', 'ORDERB'), c = await category(v.id, '合成排序丙', 'ORDERC');
    const leaf = await category(v.id, '合成排序末级', 'ORDERLEAF', a.id);
    const project = await svc.create(actor, 'finance-labor-costs', { versionId: v.id, archiveCategoryId: leaf.id, workTypeId: workType, unitId: unit, workName: '排序价格保留', unitPrice: 0.1234 });
    const reader = { ...actor, permissions: { isCompanyAdmin: false, allow: ['resource.finance-labor-costs.view'], deny: [] } };
    expect((await svc.get(reader, 'finance-labor-categories', a.id)).data.referenceCount).toBe(0);
    expect((await svc.get(reader, 'finance-labor-categories', leaf.id)).data.referenceCount).toBe(1);
    const editor = { ...reader, permissions: { ...reader.permissions, allow: ['resource.finance-labor-costs.edit'] } };
    expect(await svc.reorderCategories(editor, 'finance-labor-categories', [b.id, c.id, a.id])).toMatchObject({ ok: true });
    const read = async () => Promise.all([a.id, b.id, c.id].map(async id => [id, (await svc.get(actor, 'finance-labor-categories', id)).data.sortOrder]));
    const before = await read(); expect(before).toEqual([[a.id, 30], [b.id, 10], [c.id, 20]]);
    const other = await version('RL-ORDER-OTHER'), foreignScope = await category(other.id, '其他版本分类', 'OTHER');
    for (const ids of [[a.id, b.id], [a.id, b.id, a.id], [a.id, b.id, foreignScope.id], [a.id, b.id, leaf.id], [a.id, b.id, 999999999]]) await expect(svc.reorderCategories(editor, 'finance-labor-categories', ids)).rejects.toThrow();
    expect(await read()).toEqual(before);
    await expect(svc.reorderCategories(reader, 'finance-labor-categories', [a.id, b.id, c.id])).rejects.toThrow(/修改权限/);
    await expect(svc.reorderCategories({ ...actor, companyId: actor.companyId + 1000000 }, 'finance-labor-categories', [a.id, b.id, c.id])).rejects.toThrow();
    expect((await svc.get(actor, 'finance-labor-costs', project.id)).data).toMatchObject({ workCode: project.data.workCode, unitPrice: 0.1234 });
    await svc.changeStatus(actor, 'finance-labor-versions', v.id, 'active');
    await svc.changeStatus(actor, 'finance-labor-versions', v.id, 'inactive');
    await expect(svc.reorderCategories(editor, 'finance-labor-categories', [a.id, b.id, c.id])).rejects.toThrow(/停用/);
    expect(await read()).toEqual(before);
  });

  it('501个同级分类完整排序不截断，缺末项时整批拒绝', async () => {
    const v = await version('RL-501-ORDER');
    const rows = await ds.manager.save(ResourceRecord, Array.from({ length: 501 }, (_, index) => ds.manager.create(ResourceRecord, { companyId: actor.companyId, type: 'finance-labor-categories', title: `合成排序${index}`, data: { versionId: v.id, name: `合成排序${index}`, code: `MANY${index}`, sortOrder: (index + 1) * 10 }, status: 'active', createdBy: actor.id, updatedBy: actor.id })));
    const ids = rows.map(row => row.id).reverse();
    expect(await svc.reorderCategories(actor, 'finance-labor-categories', ids)).toMatchObject({ ok: true });
    expect((await svc.get(actor, 'finance-labor-categories', rows[500].id)).data.sortOrder).toBe(10);
    expect((await svc.get(actor, 'finance-labor-categories', rows[0].id)).data.sortOrder).toBe(5010);
    await expect(svc.reorderCategories(actor, 'finance-labor-categories', ids.slice(0, 500))).rejects.toThrow(/完整/);
    expect((await svc.get(actor, 'finance-labor-categories', rows[0].id)).data.sortOrder).toBe(5010);
  });
});
