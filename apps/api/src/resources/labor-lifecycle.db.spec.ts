import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceChangeLog, ResourceLink, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { LaborCopyService } from './labor-copy.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('人力版本生命周期与完整复制（隔离数据库）', () => {
  let ds: DataSource, svc: ResourcesService, copy: LaborCopyService, actor: AuthUser, workType: number, unit: number;
  let index = 0;
  const version = () => svc.create(actor, 'finance-labor-versions', { versionCode: `LIFE-${++index}`, versionName: `合成生命周期${index}` });
  const item = (versionId: number, categoryId: number, workName: string, extra = {}) => svc.create(actor, 'finance-labor-costs', { versionId, archiveCategoryId: categoryId, workTypeId: workType, unitId: unit, workName, unitPrice: 100, ...extra });
  async function fixture() {
    const v = await version();
    const root = await svc.create(actor, 'finance-labor-categories', { versionId: v.id, name: '合成根目录' });
    const leaf = await svc.create(actor, 'finance-labor-categories', { versionId: v.id, name: '合成末级', parentId: root.id });
    const project = await item(v.id, leaf.id, '合成工作甲');
    return { v, root, leaf, project };
  }
  const counts = async () => Promise.all([ds.manager.count(ResourceRecord, { where: { companyId: actor.companyId } }), ds.manager.count(ResourceLink, { where: { companyId: actor.companyId } }), ds.manager.count(ResourceChangeLog, { where: { companyId: actor.companyId } })]);
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize(); svc = buildServices(ds).resources; copy = new LaborCopyService(ds, svc);
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `ll${crypto.randomBytes(5).toString('hex')}`, name: '合成人力生命周期验收', status: 'active' }));
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '合成管理员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    actor = { id: user.id, companyId: company.id, name: user.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    workType = (await svc.create(actor, 'finance-labor-work-types', { name: '合成分类' })).id;
    unit = (await svc.create(actor, 'finance-labor-units', { name: '件' })).id;
  });
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => { await ds?.destroy(); });

  it('并发启用仍只有一个默认版本，已启用时间和其他版本资料不被旧快照覆盖', async () => {
    const a = await fixture(), b = await fixture();
    await Promise.all([svc.changeStatus(actor, 'finance-labor-versions', a.v.id, 'active'), svc.changeStatus(actor, 'finance-labor-versions', b.v.id, 'active')]);
    const rows = (await svc.list(actor, 'finance-labor-versions', { pageSize: 200, showHidden: true } as never)).items;
    expect(rows.filter(row => row.data.isDefault === true)).toHaveLength(1);
    for (const id of [a.v.id, b.v.id]) {
      const row = await svc.get(actor, 'finance-labor-versions', id);
      expect(row.status).toBe('active'); expect(row.data.activatedAt).toBeTruthy(); expect(row.data.versionName).toMatch(/合成生命周期/);
    }
  });

  it('并发跨目录同名仍查重；分类改码与项目改价/新增同时发生后保留最新价格及编号', async () => {
    const own = await fixture();
    const otherLeaf = await svc.create(actor, 'finance-labor-categories', { versionId: own.v.id, parentId: own.root.id, name: '合成另末级' });
    const results = await Promise.allSettled([item(own.v.id, own.leaf.id, '并发同名'), item(own.v.id, otherLeaf.id, '并发同名')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/完全相同/);
    await Promise.all([svc.update(actor, 'finance-labor-categories', own.root.id, { code: 'CURRENT' }), svc.update(actor, 'finance-labor-costs', own.project.id, { unitPrice: 254.1234 }), item(own.v.id, own.leaf.id, '并发新增后编号')]);
    const rows = await svc.findWhere(ds.manager, actor.companyId, 'finance-labor-costs', 'versionId', own.v.id);
    expect(rows.every(row => String(row.data.workCode).includes('-CURRENT-'))).toBe(true);
    expect(rows.find(row => row.id === own.project.id)!.data.unitPrice).toBe(254.1234);
  });

  it('新版本只能草稿；启用后可维护项目与归档，但不可编辑版本资料或删除；停用完全只读并可恢复', async () => {
    await expect(svc.create(actor, 'finance-labor-versions', { versionCode: 'BAD-ACTIVE', versionName: '不能直接启用' }, 'active')).rejects.toThrow(/草稿/);
    const empty = await version();
    await expect(svc.changeStatus(actor, 'finance-labor-versions', empty.id, 'active')).rejects.toThrow(/至少维护/);
    const { v, root, leaf, project } = await fixture();
    const active = await svc.changeStatus(actor, 'finance-labor-versions', v.id, 'active');
    const activatedAt = active.data.activatedAt;
    expect(active.data.isDefault).toBe(true);
    await expect(svc.update(actor, 'finance-labor-versions', v.id, { versionName: '启用后不能改名' })).rejects.toThrow(/草稿版本/);
    await expect(svc.update(actor, 'finance-labor-versions', v.id, { isDefault: false })).rejects.toThrow(/默认版本/);
    await svc.update(actor, 'finance-labor-costs', project.id, { unitPrice: 123.4567, note: '启用后仍可维护' });
    await svc.update(actor, 'finance-labor-categories', leaf.id, { name: '启用后改分类名' });
    for (const [type, id] of [['finance-labor-versions', v.id], ['finance-labor-categories', leaf.id], ['finance-labor-costs', project.id]] as const) await expect(svc.remove(actor, type, id, '合成删除')).rejects.toThrow(/草稿版本/);
    await svc.changeStatus(actor, 'finance-labor-versions', v.id, 'inactive');
    for (const patch of [{ note: '停用后改备注' }, { workName: '停用后改名称' }, { unitPrice: 123.4567 }]) await expect(svc.update(actor, 'finance-labor-costs', project.id, patch)).rejects.toThrow(/停用/);
    await expect(svc.create(actor, 'finance-labor-categories', { versionId: v.id, parentId: root.id, name: '停止后新增' })).rejects.toThrow(/停用/);
    await expect(svc.update(actor, 'finance-labor-categories', leaf.id, { name: '停止后修改' })).rejects.toThrow(/停用/);
    await expect(svc.changeStatus(actor, 'finance-labor-versions', v.id, 'draft')).rejects.toThrow(/不能退回草稿/);
    const restored = await svc.changeStatus(actor, 'finance-labor-versions', v.id, 'active');
    expect(restored.data.activatedAt).toBe(activatedAt); expect(restored.data.isDefault).toBe(true);
    expect((await svc.get(actor, 'finance-labor-costs', project.id)).data.unitPrice).toBe(123.4567);
    const other = await fixture();
    await expect(svc.update(actor, 'finance-labor-costs', project.id, { versionId: other.v.id, archiveCategoryId: other.leaf.id })).rejects.toThrow(/不能换成本版本/);
  });

  it('删除草稿版本同事务删除完整目录和项目，保留其他版本；并发新增不会留下孤立项目', async () => {
    const own = await fixture(), other = await fixture();
    const deep = await svc.create(actor, 'finance-labor-categories', { versionId: own.v.id, parentId: own.root.id, name: '另一支' });
    await item(own.v.id, deep.id, '合成工作乙');
    await svc.remove(actor, 'finance-labor-versions', own.v.id, '合成整版删除');
    for (const type of ['finance-labor-categories', 'finance-labor-costs']) expect(await svc.findWhere(ds.manager, actor.companyId, type, 'versionId', own.v.id)).toHaveLength(0);
    expect(await ds.manager.countBy(ResourceLink, { companyId: actor.companyId, targetType: 'finance-labor-versions', targetId: own.v.id })).toBe(0);
    expect((await svc.get(actor, 'finance-labor-costs', other.project.id)).data.versionId).toBe(other.v.id);
    const racing = await fixture();
    const result = await Promise.allSettled([svc.remove(actor, 'finance-labor-versions', racing.v.id, '并发删除合成版'), item(racing.v.id, racing.leaf.id, '并发新增合成项目')]);
    expect(result[0].status).toBe('fulfilled');
    expect(await ds.manager.countBy(ResourceRecord, { companyId: actor.companyId, id: racing.v.id })).toBe(0);
    expect(await svc.findWhere(ds.manager, actor.companyId, 'finance-labor-costs', 'versionId', racing.v.id)).toHaveLength(0);
    expect(await ds.manager.countBy(ResourceLink, { companyId: actor.companyId, targetType: 'finance-labor-versions', targetId: racing.v.id })).toBe(0);
    // 固定复现旧事务先建立快照、另一事务随后新增完成的顺序，不能只靠竞争碰巧覆盖。
    const stale = await fixture(); let lateId = 0;
    await ds.transaction(async em => {
      await em.findOneByOrFail(ResourceRecord, { companyId: actor.companyId, id: stale.v.id });
      lateId = (await item(stale.v.id, stale.leaf.id, '旧快照后新增项目')).id;
      await svc.removeRecord(em, actor, 'finance-labor-versions', stale.v.id, '合成旧快照完整删除');
    });
    expect(await ds.manager.countBy(ResourceRecord, { companyId: actor.companyId, id: lateId })).toBe(0);
    expect(await svc.findWhere(ds.manager, actor.companyId, 'finance-labor-costs', 'versionId', stale.v.id)).toHaveLength(0);
  });

  it('任一子删除失败整版回滚；外部引用即使属于草稿项目也受保护', async () => {
    const own = await fixture();
    const second = await item(own.v.id, own.leaf.id, '合成工作乙');
    const before = await counts();
    const remove = svc.removeRecord.bind(svc);
    const spy = jest.spyOn(svc, 'removeRecord').mockImplementation(async (em, user, type, id, reason, cleanup, currentRead) => {
      if (type === 'finance-labor-categories') throw new Error('合成目录删除失败');
      return remove(em, user, type, id, reason, cleanup, currentRead);
    });
    await expect(svc.remove(actor, 'finance-labor-versions', own.v.id, '合成回滚验收')).rejects.toThrow(/目录删除失败/);
    spy.mockRestore(); expect(await counts()).toEqual(before);
    expect((await svc.get(actor, 'finance-labor-costs', own.project.id)).id).toBe(own.project.id);
    const incoming = await ds.manager.save(ResourceLink, ds.manager.create(ResourceLink, { companyId: actor.companyId, sourceType: 'finance-labor-costs', sourceId: second.id, relation: 'synthetic-protected-reference', targetType: 'finance-labor-costs', targetId: own.project.id }));
    await expect(svc.remove(actor, 'finance-labor-versions', own.v.id, '合成引用保护')).rejects.toThrow(/引用/);
    expect((await svc.get(actor, 'finance-labor-costs', own.project.id)).id).toBe(own.project.id);
    expect(await ds.manager.countBy(ResourceLink, { id: incoming.id, companyId: actor.companyId })).toBe(1);
  });

  it('版本复制保留原编号、状态、六位元单价、零价事实和备注；不伪造零值确认，失败无残留资料/引用/日志', async () => {
    const own = await fixture();
    await svc.update(actor, 'finance-labor-costs', own.project.id, { unitPrice: 0.1234, note: '合成项目备注' });
    const zero = await item(own.v.id, own.leaf.id, '合成零价', { unitPrice: 0, zeroCostConfirmation: { reason: '合成优惠', context: JSON.stringify(['合成零价', '件', '合成分类']) }, note: '合成零价备注' });
    await svc.changeStatus(actor, 'finance-labor-costs', zero.id, 'inactive', '合成停用项目');
    await svc.changeStatus(actor, 'finance-labor-versions', own.v.id, 'active');
    await svc.changeStatus(actor, 'finance-labor-versions', own.v.id, 'inactive');
    const scoped = { ...actor, permissions: { isCompanyAdmin: false, allow: ['resource.finance-labor-costs.view', 'resource.finance-labor-costs.create', 'product.cost.view', 'product.cost.edit'], deny: [] } };
    const cloned = await copy.copyVersion(scoped, own.v.id, { versionCode: 'LIFE-COPY', versionName: '合成复制版', remark: '合成版本备注' });
    expect(cloned.items).toBe(2); expect(cloned.categories).toBe(2);
    const copiedVersion = await svc.get(actor, 'finance-labor-versions', cloned.id);
    expect(copiedVersion.status).toBe('draft'); expect(copiedVersion.data.note).toBe('合成版本备注'); expect(copiedVersion.data.activatedAt).toBeUndefined();
    const copied = await svc.findWhere(ds.manager, actor.companyId, 'finance-labor-costs', 'versionId', cloned.id);
    const copiedZero = copied.find(row => row.data.workName === '合成零价')!;
    const copiedPaid = copied.find(row => row.data.workName === '合成工作甲')!;
    expect(copiedZero.data.workCode).toBe(zero.data.workCode); expect(copiedZero.status).toBe('inactive'); expect(copiedZero.data.unitPrice).toBe(0);
    expect(copiedZero.data.zeroReason).toBe('合成优惠'); expect(copiedZero.data.zeroCostConfirmation).toBeUndefined(); expect(copiedZero.data.note).toBe('合成零价备注');
    expect(copiedPaid.data.unitPrice).toBe(0.1234); expect(copiedPaid.data.note).toBe('合成项目备注');
    await expect(svc.update(actor, 'finance-labor-costs', copiedZero.id, { note: '复制零价编辑需重确认' })).rejects.toThrow(/明确确认/);
    const before = await counts(), create = svc.createRecord.bind(svc); let createdItems = 0;
    const spy = jest.spyOn(svc, 'createRecord').mockImplementation(async (em, user, type, values, note, status) => {
      if (type === 'finance-labor-costs' && ++createdItems === 2) throw new Error('合成第二项目失败');
      return create(em, user, type, values, note, status);
    });
    await expect(copy.copyVersion(scoped, own.v.id, { versionCode: 'LIFE-ROLLBACK', versionName: '必须回滚' })).rejects.toThrow(/第二项目失败/);
    spy.mockRestore(); expect(await counts()).toEqual(before);
    expect((await copy.copyVersion(scoped, own.v.id, { versionCode: 'LIFE-ROLLBACK', versionName: '失败后重试' })).items).toBe(2);
    await expect(copy.copyVersion({ ...scoped, companyId: actor.companyId + 1000000 }, own.v.id, { versionCode: 'FOREIGN', versionName: '不得跨公司复制' })).rejects.toThrow(/不存在/);
    await expect(copy.copyVersion({ ...scoped, permissions: { ...scoped.permissions, allow: ['resource.finance-labor-costs.create'] } }, own.v.id, { versionCode: 'NO-VIEW', versionName: '不得越权' })).rejects.toThrow(/查看/);
  });
});
