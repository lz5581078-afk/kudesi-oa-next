import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User, ResourceRecord, ResourceLink } from '../entities';
import { buildServices } from '../test-support';
import { runLegacyImport } from './runner';
import { LegacyArchive, legacyRef as ref } from './protocol';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('迁入：归档行与手动关联（隔离MySQL）', () => {
  let ds: DataSource, company: Company, actor: User, svc: ReturnType<typeof buildServices>;
  let source: LegacyArchive;
  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'isolated-migration-test-signing-key-32bytes';
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true }).initialize();
    svc = buildServices(ds);
    const tag = randomBytes(6).toString('hex');
    company = await ds.manager.save(Company, ds.manager.create(Company, { code: tag, name: '归档迁前公司', status: 'active' }));
    actor = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'mig-arc-' + tag, name: '管理员', passwordHash: 'x', status: 'active', isCompanyAdmin: true, mustChangePassword: false }));
    source = {
      company: { id: 98, name: '归档迁入公司' }, departments: [{ id: 1, name: '部门', status: 'active' }], positions: [],
      employees: [{ id: 7, name: '旧归档人', login_account: null, status: 'active', department_id: 1 }],
      employeePositions: [], positionPermissions: [], exclusions: [], loadFile: async () => Buffer.alloc(0),
      records: [
        { type: 'licenses', id: 'L1', data: { category: 'operation', companyName: '在用公司', creditCode: '91110000AAAAAAAA01', legalPerson: '张三' } },
        { type: 'licenses', id: 'L2', status: 'inactive', data: { category: 'operation', companyName: '已归档公司', creditCode: '91110000AAAAAAAA02', legalPerson: '李四' },
          archive: { at: '2026-03-05 10:20:30', by: '7', reason: '主体注销', fromStatus: 'abnormal' } },
        { type: 'stores', id: 'S1', data: { platform: 'pdd', name: '店铺一' } },
        { type: 'stores', id: 'S2', status: 'inactive', data: { platform: 'pdd', name: '归档店铺' }, archive: { at: '2026-04-01 00:00:00' } },
        { type: 'partners', id: 'P1', data: { name: '合作人甲', licenseId: ref('licenses', 'L1') } },
      ],
      links: [
        { id: '1', relation: 'partner_profile_license', sourceType: 'partners', sourceId: 'P1', targetType: 'licenses', targetId: 'L1' },
        { id: '2', relation: 'partner_profile_license', sourceType: 'partners', sourceId: 'P1', targetType: 'licenses', targetId: 'L2', validFrom: '2026-01-01', validTo: '2026-12-31', purpose: '历史主体' },
        { id: '3', relation: 'partner_profile_store', sourceType: 'partners', sourceId: 'P1', targetType: 'stores', targetId: 'S1', purpose: '店铺代理' },
        { id: '4', relation: 'partner_profile_store', sourceType: 'partners', sourceId: 'P1', targetType: 'stores', targetId: 'S1' },
        { id: '5', relation: 'license_operator', sourceType: 'licenses', sourceId: 'L1', targetType: 'user', targetId: '7', validFrom: '2026-02-01' },
        { id: '6', relation: 'partner_profile_store', sourceType: 'partners', sourceId: 'P1', targetType: 'stores', targetId: 'GONE' },
      ],
    };
  });
  afterAll(async () => { await ds?.destroy(); });
  const run = (apply: boolean) => runLegacyImport(ds, svc.resources, svc.files, source, { companyId: company.id, actorId: actor.id, expectedName: '归档迁前公司', apply });

  it('干跑给出归档行数、关联迁入数和跳过原因，且全部回滚', async () => {
    const r = await run(false);
    expect(r.failures).toEqual([]);
    expect(r.archived.total).toBe(2);
    expect(r.archived.byType).toEqual({ licenses: 1, stores: 1 });
    expect(r.links.created).toBe(3);
    expect(r.links.skipped).toBe(3);
    expect(r.links.skippedReasons['新系统已存在同一对象的关联（重复，保留先迁入的一条）']).toBe(2); // 字段已生成的关联 + 重复行
    expect(Object.keys(r.links.skippedReasons).sort()).toEqual([
      '关联一端的资料未迁入（旧库已删除、失败或不在迁入范围）',
      '新系统已存在同一对象的关联（重复，保留先迁入的一条）',
    ].sort());
    expect(await ds.manager.count(ResourceLink, { where: { companyId: company.id } })).toBe(0);
    expect(await ds.manager.count(ResourceRecord, { where: { companyId: company.id } })).toBe(0);
  });

  it('归档行迁成“已归档”，关联迁成带属性的手动关联，复跑不重复', async () => {
    const r = await run(true);
    expect(r.failures).toEqual([]);
    const l2 = await ds.manager.findOneByOrFail(ResourceRecord, { companyId: company.id, type: 'licenses', title: '已归档公司' });
    expect(l2.archivedAt).toBeInstanceOf(Date);
    expect(l2.archivedAt!.toISOString()).toBe('2026-03-05T02:20:30.000Z');
    expect(l2.archiveReason).toBe('主体注销');
    expect(l2.archivedFromStatus).toBe('abnormal');
    expect(l2.status).toBe('inactive');
    const by = await ds.manager.findOneByOrFail(User, { companyId: company.id, name: '旧归档人' });
    expect(l2.archivedBy).toBe(by.id);
    const s2 = await ds.manager.findOneByOrFail(ResourceRecord, { companyId: company.id, type: 'stores', title: '归档店铺' });
    expect(s2.archiveReason).toBe('旧系统归档（原因未记录）');
    expect(s2.archivedFromStatus).toBeNull();
    const l1 = await ds.manager.findOneByOrFail(ResourceRecord, { companyId: company.id, type: 'licenses', title: '在用公司' });
    expect(l1.archivedAt).toBeNull();
    const p1 = await ds.manager.findOneByOrFail(ResourceRecord, { companyId: company.id, type: 'partners' });
    const links = await ds.manager.find(ResourceLink, { where: { companyId: company.id, relation: 'manual' } });
    expect(links).toHaveLength(3);
    const toL2 = links.find((x) => x.targetId === l2.id)!;
    expect([toL2.sourceType, toL2.sourceId, toL2.validFrom, toL2.validTo, toL2.purpose]).toEqual(['partners', p1.id, '2026-01-01', '2026-12-31', '历史主体']);
    const op = links.find((x) => x.targetType === 'user')!;
    expect([op.sourceId, op.targetId, op.validFrom]).toEqual([l1.id, by.id, '2026-02-01']);
    expect(links.find((x) => x.targetType === 'stores')!.purpose).toBe('店铺代理');
    // 归档后可按新系统的恢复流程回到归档前状态
    const boss = { id: actor.id, companyId: company.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    await svc.resources.restore(boss, 'licenses', l2.id, '测试恢复');
    expect((await ds.manager.findOneByOrFail(ResourceRecord, { id: l2.id })).status).toBe('abnormal');
    await ds.manager.update(ResourceRecord, { id: l2.id }, { status: 'inactive', archivedAt: l2.archivedAt, archivedBy: l2.archivedBy, archiveReason: l2.archiveReason, archivedFromStatus: l2.archivedFromStatus });
    const again = await run(true);
    expect(again.failures).toEqual([]);
    expect(again.created).toEqual({});
    expect(again.archived.total).toBe(0);
    expect(await ds.manager.count(ResourceLink, { where: { companyId: company.id, relation: 'manual' } })).toBe(3);
  });
});
