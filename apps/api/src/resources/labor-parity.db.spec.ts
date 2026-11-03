import 'reflect-metadata';
import * as crypto from 'crypto';
import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { laborWorkCode } from './labor-rules';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('人力项目原版查重与工作编号（隔离数据库）', () => {
  let ds: DataSource, svc: ResourcesService, actor: AuthUser;
  let version: number, category: number, otherCategory: number, workType: number, unit: number, otherUnit: number;
  const create = (workName: string, extra: Record<string, unknown> = {}) => svc.create(actor, 'finance-labor-costs', { versionId: version, archiveCategoryId: category, workTypeId: workType, unitId: unit, workName, unitPrice: 100, ...extra });
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize(); svc = buildServices(ds).resources;
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `lp${crypto.randomBytes(5).toString('hex')}`, name: '合成人工规则验收', status: 'active' }));
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '合成管理员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    actor = { id: user.id, companyId: company.id, name: user.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    version = (await svc.create(actor, 'finance-labor-versions', { versionCode: 'RL-A', versionName: '合成版本' })).id;
    category = (await svc.create(actor, 'finance-labor-categories', { versionId: version, name: '合成目录甲', code: 'C1' })).id;
    otherCategory = (await svc.create(actor, 'finance-labor-categories', { versionId: version, name: '合成目录乙', code: 'C2' })).id;
    workType = (await svc.create(actor, 'finance-labor-work-types', { name: '合成包装' })).id;
    unit = (await svc.create(actor, 'finance-labor-units', { name: '件' })).id;
    otherUnit = (await svc.create(actor, 'finance-labor-units', { name: '小时' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('版本项目数包含停用项目、排除已删除项目，并按版本及公司隔离', async () => {
    const v = await svc.create(actor, 'finance-labor-versions', { versionCode: 'RL-COUNT', versionName: '合成计数版本' });
    const c = await svc.create(actor, 'finance-labor-categories', { versionId: v.id, name: '合成计数归档' });
    const first = await create('计数启用项目', { versionId: v.id, archiveCategoryId: c.id });
    const second = await create('计数停用项目', { versionId: v.id, archiveCategoryId: c.id });
    await svc.changeStatus(actor, 'finance-labor-costs', second.id, 'inactive', '合成计数验收');
    expect((await svc.get(actor, 'finance-labor-versions', v.id)).data.itemCount).toBe(2);
    await svc.remove(actor, 'finance-labor-costs', first.id, '合成计数删除');
    const reader = { ...actor, permissions: { isCompanyAdmin: false, allow: ['resource.finance-labor-costs.view'], deny: [] } };
    expect((await svc.list(reader, 'finance-labor-versions', { pageSize: 200 } as never)).items.find(row => row.id === v.id)?.data.itemCount).toBe(1);
    expect((await svc.list({ ...reader, companyId: actor.companyId + 1000000 }, 'finance-labor-versions', { pageSize: 200 } as never)).items).toEqual([]);
  });

  it('零成本必须明确确认当前名称/单位/分类，原因不能替代确认；确认人和时间由服务端写入', async () => {
    const name = '合成零价确认';
    const context = JSON.stringify([name, '件', '合成包装']);
    await expect(create(name, { unitPrice: 0, zeroReason: '原因本身不能代替确认' })).rejects.toThrow(/明确确认/);
    await expect(create(name, { unitPrice: 0, zeroCostConfirmation: { reason: '赠', context: '[]' } })).rejects.toThrow(/重新确认/);
    const saved = await create(name, { unitPrice: 0, zeroCostConfirmation: { reason: ' 赠 ', context, employeeId: 9999999, confirmedAt: '2000-01-01' } });
    expect(saved.data.zeroReason).toBe('赠');
    expect(saved.data.zeroCostConfirmation).toMatchObject({ reason: '赠', context, employeeId: actor.id });
    expect((saved.data.zeroCostConfirmation as { confirmedAt: string }).confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expect(svc.update(actor, 'finance-labor-costs', saved.id, { workName: `${name}改` })).rejects.toThrow(/重新确认/);
    expect((await svc.get(actor, 'finance-labor-costs', saved.id)).data.workName).toBe(name);
    const renamedContext = JSON.stringify([`${name}改`, '件', '合成包装']);
    const renamed = await svc.update(actor, 'finance-labor-costs', saved.id, { workName: `${name}改`, zeroCostConfirmation: { reason: '赠', context: renamedContext } });
    expect(renamed.data.unitPrice).toBe(0);
    await expect(svc.update(actor, 'finance-labor-costs', saved.id, { unitId: otherUnit })).rejects.toThrow(/重新确认/);
    const paid = await svc.update(actor, 'finance-labor-costs', saved.id, { unitPrice: 0.1234 });
    expect(paid.data.unitPrice).toBe(0.1234); expect(paid.data.zeroReason).toBeUndefined(); expect(paid.data.zeroCostConfirmation).toBeUndefined();
  });

  it('零值确认同成本读写权限隔离；上游单位改名后旧确认失效，未确认复制不能沿用零价', async () => {
    const localUnit = await svc.create(actor, 'finance-labor-units', { name: '合成零值单位' });
    const name = '零价权限检查', context = JSON.stringify([name, localUnit.title, '合成包装']);
    const saved = await create(name, { unitId: localUnit.id, unitPrice: 0, zeroCostConfirmation: { reason: '合成优惠', context } });
    const reader = { ...actor, permissions: { isCompanyAdmin: false, allow: ['resource.finance-labor-costs.view', 'resource.finance-labor-costs.edit'], deny: [] } };
    const hidden = await svc.get(reader, 'finance-labor-costs', saved.id);
    expect(hidden.data).not.toHaveProperty('unitPrice'); expect(hidden.data).not.toHaveProperty('zeroReason'); expect(hidden.data).not.toHaveProperty('zeroCostConfirmation');
    expect(JSON.stringify(await svc.logs(reader, 'finance-labor-costs', saved.id))).not.toContain('合成优惠');
    await svc.update(reader, 'finance-labor-costs', saved.id, { zeroReason: '越权原因', zeroCostConfirmation: { reason: '越权原因', context } });
    expect((await svc.get(actor, 'finance-labor-costs', saved.id)).data.zeroReason).toBe('合成优惠');
    await expect(create('复制零价项目', { unitId: localUnit.id, unitPrice: 0, zeroReason: '合成优惠' })).rejects.toThrow(/明确确认/);
    await svc.update(actor, 'finance-labor-units', localUnit.id, { name: '合成改名单位' });
    await expect(svc.update(actor, 'finance-labor-costs', saved.id, { note: '保留旧确认不能越过验证' })).rejects.toThrow(/重新确认/);
    const renewed = await svc.update(actor, 'finance-labor-costs', saved.id, { zeroCostConfirmation: { reason: '合成优惠', context: JSON.stringify([name, '合成改名单位', '合成包装']) } });
    expect(renewed.data.unitPrice).toBe(0);
  });

  it('字典整表排序同事务保留全部条目，拒绝缺项/无效ID和无修改权限；引用数按公司跨版本统计', async () => {
    const a = await svc.create(actor, 'finance-labor-work-types', { name: '排序合成甲', code: 'SORTA' });
    const b = await svc.create(actor, 'finance-labor-work-types', { name: '排序合成乙', code: 'SORTB' });
    const order = [b.id, workType, a.id];
    expect(await svc.reorderCategories(actor, 'finance-labor-work-types', order)).toMatchObject({ ok: true });
    const read = async () => (await svc.list(actor, 'finance-labor-work-types', { pageSize: 200 } as never)).items.map(row => [row.id, row.data.sortOrder]);
    const saved = await read();
    for (const [index, id] of order.entries()) expect(saved).toContainEqual([id, (index + 1) * 10]);
    for (const invalid of [[b.id, a.id], [b.id, a.id, 999999999], [b.id, b.id, a.id]]) await expect(svc.reorderCategories(actor, 'finance-labor-work-types', invalid)).rejects.toThrow();
    expect(await read()).toEqual(saved);
    const noEdit = { ...actor, permissions: { isCompanyAdmin: false, allow: ['resource.finance-labor-costs.create'], deny: [] } };
    await expect(svc.reorderCategories(noEdit, 'finance-labor-work-types', order)).rejects.toThrow(/没有修改权限/);
    await expect(svc.reorderCategories({ ...actor, companyId: actor.companyId + 1000000 }, 'finance-labor-work-types', order)).rejects.toThrow();
    const before = (await svc.get(actor, 'finance-labor-work-types', a.id)).data.referenceCount as number;
    await create('字典引用当前版本', { workTypeId: a.id });
    const otherVersion = await svc.create(actor, 'finance-labor-versions', { versionCode: 'RL-DICT-OTHER', versionName: '字典引用其他版本' });
    const otherCat = await svc.create(actor, 'finance-labor-categories', { versionId: otherVersion.id, name: '其他版本归档' });
    await create('字典引用其他版本', { workTypeId: a.id, versionId: otherVersion.id, archiveCategoryId: otherCat.id });
    const reader = { ...actor, permissions: { isCompanyAdmin: false, allow: ['resource.finance-labor-costs.view'], deny: [] } };
    expect((await svc.get(reader, 'finance-labor-work-types', a.id)).data.referenceCount).toBe(before + 2);
    expect((await svc.get(reader, 'finance-labor-units', unit)).data.referenceCount).toBeGreaterThanOrEqual(2);
    await expect(svc.remove(actor, 'finance-labor-work-types', a.id, '合成引用保护')).rejects.toThrow();
  });

  it('新建预览与保存编号一致且不写库，编辑排除自身并保留成本隐私', async () => {
    const values = { versionId: version, archiveCategoryId: category, workTypeId: workType, workName: '预览合成装袋' };
    const before = await ds.manager.count(ResourceRecord, { where: { companyId: actor.companyId } });
    const preview = await svc.codePreview(actor, 'finance-labor-costs', values);
    expect(Object.keys(preview)).toEqual(['code']);
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: actor.companyId } })).toBe(before);
    const saved = await create(values.workName);
    expect(saved.data.workCode).toBe(preview.code);
    expect((await svc.codePreview(actor, 'finance-labor-costs', values, saved.id)).code).toBe(preview.code);
    expect((await svc.codePreview(actor, 'finance-labor-costs', values)).code).toBe(`${preview.code}-2`);
    const editOnly = { ...actor, permissions: { isCompanyAdmin: false, allow: ['resource.finance-labor-costs.edit'], deny: [] } };
    await expect(svc.codePreview(editOnly, 'finance-labor-costs', values)).rejects.toThrow(/没有新增权限/);
    expect((await svc.codePreview(editOnly, 'finance-labor-costs', values, saved.id)).code).toBe(preview.code);
    const createOnly = { ...actor, permissions: { isCompanyAdmin: false, allow: ['resource.finance-labor-costs.create'], deny: [] } };
    await expect(svc.codePreview(createOnly, 'finance-labor-costs', values, saved.id)).rejects.toThrow(/没有修改权限/);
  });

  it('预览拒绝额外字段、坏引用、跨版本目录及其他公司记录，不泄露或写入', async () => {
    const values = { versionId: version, archiveCategoryId: category, workTypeId: workType, workName: '安全预览' };
    for (const extra of [{ unitPrice: 100 }, { companyId: actor.companyId }, { workCode: 'MANUAL' }, { workName: null }, { workTypeId: -1 }, { workTypeId: '1' }, { workTypeId: 999999999 }]) {
      await expect(svc.codePreview(actor, 'finance-labor-costs', { ...values, ...extra })).rejects.toThrow();
    }
    const v2 = await svc.create(actor, 'finance-labor-versions', { versionCode: 'RL-PREVIEW-OTHER', versionName: '其他版本' });
    await expect(svc.codePreview(actor, 'finance-labor-costs', { ...values, versionId: v2.id })).rejects.toThrow(/不属于/);
    const otherActor = { ...actor, companyId: actor.companyId + 1000000 };
    await expect(svc.codePreview(otherActor, 'finance-labor-costs', values)).rejects.toThrow(/不存在/);
    const saved = await create('合成所有权检查');
    await expect(svc.codePreview(otherActor, 'finance-labor-costs', {}, saved.id)).rejects.toThrow();
    expect((await svc.get(actor, 'finance-labor-costs', saved.id)).data.workName).toBe('合成所有权检查');
    expect((await svc.codePreview(actor, 'finance-labor-costs', {})).code).toBeTruthy();
  });

  it('同名同工作分类同单位跨归档目录仍拒绝；不同单位允许，更新不越过查重', async () => {
    const first = await create('合成同名项目');
    await expect(create(' 合成同名项目 ', { archiveCategoryId: otherCategory })).rejects.toThrow(/工作名称、工作分类和计价单位完全相同/);
    const second = await create('合成同名项目', { unitId: otherUnit });
    expect(second.data.workCode).toBe(`${first.data.workCode}-2`);
    await expect(svc.update(actor, 'finance-labor-costs', second.id, { unitId: unit })).rejects.toThrow(/完全相同/);
    expect((await svc.get(actor, 'finance-labor-costs', second.id)).data.unitId).toBe(otherUnit);
  });

  it('不同名称同首字母加序号，编辑排除自身；内部空格不当成完全同名', async () => {
    const first = await create('装袋'), second = await create('扎袋'), third = await create('装 袋');
    expect(second.data.workCode).toBe(`${first.data.workCode}-2`);
    expect(third.data.workCode).toBe(`${first.data.workCode}-3`);
    const updated = await svc.update(actor, 'finance-labor-costs', second.id, { unitPrice: 123.4567 });
    expect(updated.data.workCode).toBe(second.data.workCode);
    expect(updated.data.unitPrice).toBe(123.4567);
    expect(await laborWorkCode(ds.manager, actor.companyId, updated.data, updated.id)).toBe(updated.data.workCode);
  });

  it('80位截断为序号留长度；不同版本可有相同编号，通用唯一索引仍保护版本内唯一', async () => {
    const a = await svc.create(actor, 'finance-labor-versions', { versionCode: `${'L'.repeat(79)}A`, versionName: '合成长版本甲' });
    const b = await svc.create(actor, 'finance-labor-versions', { versionCode: `${'L'.repeat(79)}B`, versionName: '合成长版本乙' });
    const ca = await svc.create(actor, 'finance-labor-categories', { versionId: a.id, name: '长编号目录' });
    const cb = await svc.create(actor, 'finance-labor-categories', { versionId: b.id, name: '长编号目录' });
    const first = await create('长项目甲', { versionId: a.id, archiveCategoryId: ca.id });
    const second = await create('长项目乙', { versionId: a.id, archiveCategoryId: ca.id });
    const third = await create('长项目丙', { versionId: a.id, archiveCategoryId: ca.id });
    expect(first.data.workCode).toHaveLength(80);
    expect(second.data.workCode).toMatch(/-2$/); expect(third.data.workCode).toMatch(/-3$/);
    expect(String(second.data.workCode).length).toBeLessThanOrEqual(80); expect(String(third.data.workCode).length).toBeLessThanOrEqual(80);
    const another = await create('长项目甲', { versionId: b.id, archiveCategoryId: cb.id });
    expect(another.data.workCode).toBe(first.data.workCode);
    const rawA = await ds.manager.findOneByOrFail(ResourceRecord, { id: first.id, companyId: actor.companyId });
    const rawB = await ds.manager.findOneByOrFail(ResourceRecord, { id: another.id, companyId: actor.companyId });
    expect(rawA.uniqueKey).toBeTruthy(); expect(rawB.uniqueKey).not.toBe(rawA.uniqueKey);
    await expect(svc.findByUnique(ds.manager, actor.companyId, 'finance-labor-costs', String(first.data.workCode))).rejects.toThrow(/多个成本版本/);
    expect((await svc.findByUnique(ds.manager, actor.companyId, 'finance-labor-costs', String(first.data.workCode), another.id))?.id).toBe(another.id);
  });

  it('并发首字母碰撞不落重复编号，冲突重试后能得到独立编号', async () => {
    const names = ['并发装袋甲', '并发扎袋甲'];
    const results = await Promise.allSettled(names.map(name => create(name)));
    const ids: number[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') ids.push(result.value.id);
      else { expect(result.reason).toBeInstanceOf(ConflictException); ids.push((await create(names[index])).id); }
    }
    const rows = await Promise.all(ids.map(id => svc.get(actor, 'finance-labor-costs', id)));
    expect(new Set(rows.map(row => row.data.workCode)).size).toBe(2);
    expect(new Set(rows.map(row => row.id)).size).toBe(2);
  });

  it('上游分类编码变化后各碰撞编号保持唯一，费用值和记录ID保留', async () => {
    const before = (await svc.list(actor, 'finance-labor-costs', { fieldKey: 'archiveCategoryId', fieldValue: category, pageSize: 200 } as never)).items;
    await svc.update(actor, 'finance-labor-categories', category, { code: 'UPDATED' });
    const after = await Promise.all(before.map(row => svc.get(actor, 'finance-labor-costs', row.id)));
    expect(new Set(after.map(row => row.data.workCode)).size).toBe(after.length);
    for (const row of after) {
      expect(row.data.workCode).toContain('-UPDATED-');
      expect(row.data.unitPrice).toBe(before.find(old => old.id === row.id)!.data.unitPrice);
      expect((await svc.findByUnique(ds.manager, actor.companyId, 'finance-labor-costs', String(row.data.workCode)))?.id).toBe(row.id);
    }
  });

  it('草稿项目按原规则删除后，重新维护可复用已释放编号', async () => {
    const first = await create('删除复用项目');
    await svc.remove(actor, 'finance-labor-costs', first.id, '合成删除复用验收');
    const again = await create('删除复用项目');
    expect(again.id).not.toBe(first.id); expect(again.data.workCode).toBe(first.data.workCode);
  });
  it('超过500节点的三级归档目录，上游改码仍更新末尾分支的项目', async () => {
    const root = await svc.create(actor, 'finance-labor-categories', { versionId: version, name: '合成大树根目录', code: 'ROOT' });
    const branches = await ds.manager.save(ResourceRecord, Array.from({ length: 501 }, (_, index) => ds.manager.create(ResourceRecord, { companyId: actor.companyId, type: 'finance-labor-categories', title: `合成分支${index}`, status: 'active', data: { versionId: version, parentId: root.id, name: `合成分支${index}`, code: `B${index}` }, searchText: '', createdBy: actor.id, updatedBy: actor.id })));
    const leaf = await svc.create(actor, 'finance-labor-categories', { versionId: version, parentId: branches.at(-1)!.id, name: '合成末尾叶子', code: 'LEAF' });
    const item = await create('大树末级项目', { archiveCategoryId: leaf.id });
    await svc.update(actor, 'finance-labor-categories', root.id, { code: 'ROOTNEW' });
    const refreshed = await svc.get(actor, 'finance-labor-costs', item.id);
    expect(refreshed.data.workCode).toContain('-ROOTNEW-B500-LEAF-');
    expect(refreshed.data.workCode).not.toBe(item.data.workCode);
    expect(refreshed.data.unitPrice).toBe(item.data.unitPrice);
  });
});
