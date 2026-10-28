import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, EmployeeCompensationRecord, PositionDuty, User } from '../entities';
import { buildServices } from '../test-support';
import { runLegacyImport } from './runner';
import { LegacyArchive } from './protocol';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('迁入：岗位档案条目与薪酬记录（隔离MySQL）', () => {
  let ds: DataSource, company: Company, actor: User, svc: ReturnType<typeof buildServices>;
  let source: LegacyArchive;
  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'isolated-migration-test-signing-key-32bytes';
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true }).initialize();
    svc = buildServices(ds);
    const tag = randomBytes(6).toString('hex');
    company = await ds.manager.save(Company, ds.manager.create(Company, { code: tag, name: '岗位迁前公司', status: 'active' }));
    actor = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'mig-duty-' + tag, name: '管理员', passwordHash: 'x', status: 'active', isCompanyAdmin: true, mustChangePassword: false }));
    source = {
      company: { id: 97, name: '岗位迁入公司' }, departments: [{ id: 1, name: '部门', status: 'active' }],
      positions: [{ id: 5, department_id: 1, name: '迁入岗', level: 'staff', status: 'active', workspace_template_key: 'finance' }],
      employees: [{ id: 7, name: '旧薪酬人', login_account: null, status: 'active', department_id: 1 }],
      employeePositions: [{ employee_id: 7, position_id: 5, is_primary: 1 }], positionPermissions: [], exclusions: [], loadFile: async () => Buffer.alloc(0), records: [],
      positionDuties: [
        { id: 1, position_id: 5, duty_category: '日常工作', title: '每日对账', description: '核对流水', frequency: '每日', is_key_duty: 1, status: 'active' },
        { id: 2, position_id: 5, duty_category: '财务', title: '旧领域分类条目', description: '原说明', status: 'active' },
        { id: 3, position_id: 99, duty_category: '日常工作', title: '岗位不在范围', status: 'active' },
      ],
      compensationRecords: [
        { id: 1, employee_id: 7, record_type: 'reward', title: '季度奖励', amount: '123.45', effective_date: '2026-03-01', created_at: '2026-03-02 08:00:00' },
        { id: 2, employee_id: 8, record_type: 'reward', title: '员工不在范围', amount: '1' },
        { id: 3, employee_id: 7, record_type: 'mystery', title: '未知类型', amount: '1' },
        { id: 4, employee_id: 7, record_type: 'penalty', title: '超精度', amount: '0.001' },
      ],
    } as LegacyArchive;
  });
  afterAll(async () => { await ds?.destroy(); });
  const run = (apply: boolean) => runLegacyImport(ds, svc.resources, svc.files, source, { companyId: company.id, actorId: actor.id, expectedName: '岗位迁前公司', apply });

  it('试跑回滚；正式迁入后条目和薪酬记录落库，旧分类不丢，范围外的列入排除；重跑不重复', async () => {
    const dry = await run(false);
    expect(dry.failures).toEqual([]);
    expect(dry.created.position_duty).toBe(2);
    expect(dry.created.comp_record).toBe(1);
    expect(await ds.manager.count(PositionDuty, { where: { companyId: company.id } })).toBe(0);
    const real = await run(true);
    expect(real.failures).toEqual([]);
    const duties = await ds.manager.find(PositionDuty, { where: { companyId: company.id }, order: { id: 'ASC' } });
    expect(duties.map((x) => [x.title, x.category, x.isKey])).toEqual([['每日对账', '日常工作', true], ['旧领域分类条目', '岗位职责', false]]);
    expect(duties[1].description).toBe('原说明（旧分类：财务）');
    const comps = await ds.manager.find(EmployeeCompensationRecord, { where: { companyId: company.id } });
    expect(comps).toHaveLength(1);
    expect(comps[0]).toMatchObject({ recordType: 'reward', amount: 12345, effectiveDate: '2026-03-01' });
    const ex = real.excluded.map((x) => `${x.type}:${x.id}`);
    expect(ex).toEqual(expect.arrayContaining(['position_duty:3', 'comp_record:2', 'comp_record:3', 'comp_record:4']));
    const again = await run(true);
    expect(again.created.position_duty ?? 0).toBe(0);
    expect(await ds.manager.count(PositionDuty, { where: { companyId: company.id } })).toBe(2);
  });
});
