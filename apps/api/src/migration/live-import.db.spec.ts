import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User, ResourceRecord } from '../entities';
import { buildServices } from '../test-support';
import { runLegacyImport } from './runner';
import type { LegacyArchive, LegacyLive } from './protocol';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
/** 旧直播管理数据导入：金额/点数/投产换算、引用映射、状态迁移规则、试跑回滚、复跑幂等、坏行只影响自己 */
d('旧直播管理数据迁入（隔离MySQL）', () => {
  let ds: DataSource, company: Company, actor: User, svc: ReturnType<typeof buildServices>, source: LegacyArchive;
  const fileRoot = mkdtempSync(join(tmpdir(), 'live-migration-files-'));
  const oldRoot = process.env.FILES_LOCAL_ROOT, oldJwt = process.env.JWT_SECRET;
  const tables = ['live_settlement_refunds', 'live_settlement_lines', 'live_settlements', 'live_wage_records', 'live_commission_records', 'live_session_orders', 'live_session_reports', 'live_session_products', 'live_sessions', 'live_schedules', 'live_commission_rule_versions'];
  const rules = { tiers: [{ min: 0, max: 1000, anchorRate: 3, controlRate: 2 }, { min: 1000, max: null, anchorRate: 3.5, controlRate: 2.5 }], boundary: 'min_inclusive', roiThreshold: 10, belowRoiAnchorDeduct: 2, belowRoiControlDeduct: 1.5 };
  const live = (): LegacyLive => ({
    commission_rule_versions: [{ id: 1, effective_from: '2026-01-01', rules_json: JSON.stringify(rules), note: '默认' }],
    schedules: [{ id: 1, room_location_id: 11, schedule_date: '2026-09-01', start_at: '2026-09-01 19:00:00', end_at: '2026-09-01 23:00:00', anchor_employee_id: 1, control_employee_id: 2, operator_employee_id: null, douyin_account_id: 12, store_id: 13, status: 'finished', session_id: 1, notification_version: 3, created_by: 1 }],
    sessions: [
      { id: 1, schedule_id: 1, room_location_id: 11, room_name: '一号间', anchor_employee_id: 1, control_employee_id: 2, douyin_account_id: 12, douyin_account_name: '抖音号', store_id: 13, store_name: '旗舰店', session_date: '2026-09-01', start_at: '2026-09-01 19:00:00', end_at: '2026-09-01 23:05:00', status: 'approved', started_by: 1, started_role: 'anchor', final_sales: '1234.56', final_sales_source: 'anchor', approved_by: 1, approved_at: '2026-09-02 10:00:00', revision: 2 },
      { id: 2, room_location_id: 11, anchor_employee_id: 1, douyin_account_id: 12, session_date: '2026-09-02', start_at: '2026-09-02 19:00:00', end_at: '2026-09-02 22:00:00', status: 'submitted', started_by: 1, started_role: 'anchor', submitted_by: 1, submitted_at: '2026-09-02 23:00:00', revision: 1 },
      { id: 3, room_location_id: 999, anchor_employee_id: 1, douyin_account_id: 12, session_date: '2026-09-03', start_at: '2026-09-03 19:00:00', status: 'pending_report', started_by: 1, started_role: 'anchor' },
    ],
    session_products: [{ id: 1, session_id: 1, base_code_id: 14, code_snapshot: 'B001', name_snapshot: '毛巾', spec_snapshot: '白', sort_order: 1 }],
    session_reports: [{ id: 1, session_id: 1, reporter_role: 'anchor', reporter_employee_id: 1, end_at: '2026-09-01 23:05:00', sales_amount: '1234.56', ad_spend: null, order_source: 'jushuitan', orders_total: '1200.00', order_count: 1, revision: 1 },
      { id: 2, session_id: 1, reporter_role: 'control', reporter_employee_id: 2, end_at: '2026-09-01 23:05:00', sales_amount: '1234.56', ad_spend: '100.5', order_count: 0 }],
    session_orders: [{ id: 1, session_id: 1, report_id: 1, order_id: 'SO1', inner_order_id: '55', amount: '1200.00', pay_time: '2026-09-01 20:00:00', order_status: 'Confirmed', shop_id: '777' }],
    commission_records: [
      { id: 1, session_id: 1, employee_id: 1, role: 'anchor', session_date: '2026-09-01', final_sales: '1234.56', ad_spend: '100.50', roi: '12.2842', below_roi: 0, rate: '3.50', amount: '43.21', rule_version_id: 1, rule_snapshot: '{"x":1}', approved_by: 1, approved_at: '2026-09-02 10:00:00' },
      { id: 2, session_id: 1, employee_id: 2, role: 'control', session_date: '2026-09-01', final_sales: '1234.56', ad_spend: '100.50', roi: '12.2842', below_roi: 0, rate: '2.50', amount: '30.86', rule_version_id: 1, rule_snapshot: '{"x":1}', approved_by: 1, approved_at: '2026-09-02 10:00:00' },
      { id: 3, session_id: 1, employee_id: 1, role: 'operator', session_date: '2026-09-01', final_sales: '1.005', rate: '1', amount: '0.01', rule_version_id: 1, approved_by: 1, approved_at: '2026-09-02 10:00:00' },
    ],
    wage_records: [{ id: 1, session_id: 1, employee_id: 1, session_date: '2026-09-01', start_at: '2026-09-01 19:00:00', end_at: '2026-09-01 23:05:00', minutes: 245, hourly_rate: '30.00', rate_source: 'archive', amount: '122.50', approved_by: 1, approved_at: '2026-09-02 10:00:00', review_snapshot: '{"a":1}' }],
    settlements: [{ id: 1, month: '2026-09', status: 'submitted', revision: 3, record_count: 2, commission_total: '74.07', refund_total: '10.00', deduction_total: '0.00', payable_total: '64.07', refunds_checked_at: '2026-10-01 09:00:00', created_by: 1 },
      { id: 2, month: '2026-08', status: 'approved', record_count: 0, commission_total: '0', refund_total: '0', deduction_total: '0', payable_total: '0', created_by: 1, submitted_by: 1, submitted_at: '2026-09-01 10:00:00', approved_by: 1, approved_at: '2026-09-02 10:00:00' }],
    settlement_lines: [{ id: 1, settlement_id: 1, commission_record_id: 1, session_id: 1, employee_id: 1, role: 'anchor', session_date: '2026-09-01', final_sales: '1234.56', rate: '3.50', commission_amount: '43.21', order_count: 1, orders_total: '1200.00', refund_amount: '10.00', deduction: '0', payable: '33.21' }],
    settlement_refunds: [{ id: 1, settlement_id: 1, session_id: 1, order_id: 'SO1', order_amount: '1200.00', refund_amount: '10.00', refund_source: 'refund', detail_json: '[{"kind":"refund"}]', checked_at: '2026-10-01 09:00:00' }],
  });
  beforeAll(async () => {
    process.env.FILES_LOCAL_ROOT = fileRoot; process.env.JWT_SECRET = 'isolated-migration-test-signing-key-32bytes';
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true }).initialize();
    svc = buildServices(ds);
    const tag = randomBytes(6).toString('hex');
    company = await ds.manager.save(Company, ds.manager.create(Company, { code: tag, name: '直播迁前公司', status: 'active' }));
    actor = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'live-mig-' + tag, name: '管理员', passwordHash: 'x', status: 'active', isCompanyAdmin: true, mustChangePassword: false } as never));
    // 位置/自媒体/店铺/基础编码资料视为此前已迁入：直接建记录并登记账本，live 导入只负责引用映射
    const seed = async (type: string, legacyId: number, title: string) => {
      const r = await ds.manager.save(ResourceRecord, ds.manager.create(ResourceRecord, { companyId: company.id, type, title, status: 'active', data: {}, searchText: title } as never));
      await ds.query("INSERT INTO legacy_import_links (source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES ('legacy-oa',98,?,?,?,?,'seed')", [company.id, `${type}:${legacyId}`, type, r.id]);
      return r;
    };
    await seed('locations', 11, '一号直播间'); await seed('self-media', 12, '抖音号'); await seed('stores', 13, '旗舰店'); await seed('finance-base-codes', 14, 'B001');
    source = { company: { id: 98, name: '直播迁入公司' }, departments: [{ id: 1, name: '直播部', status: 'active' }], positions: [], employees: [
      { id: 1, name: '主播甲', login_account: 'live-a-' + tag, status: 'active', department_id: 1, password_salt: '0123456789abcdef0123456789abcdef', password_hash: scryptSync('original-pass-123', '0123456789abcdef0123456789abcdef', 64).toString('hex') },
      { id: 2, name: '中控乙', login_account: 'live-c-' + tag, status: 'active', department_id: 1, password_salt: '0123456789abcdef0123456789abcdef', password_hash: scryptSync('original-pass-123', '0123456789abcdef0123456789abcdef', 64).toString('hex') },
    ], employeePositions: [], positionPermissions: [], exclusions: [], loadFile: async () => Buffer.alloc(0), records: [], live: live() };
  });
  afterAll(async () => { await ds?.destroy(); if (oldRoot === undefined) delete process.env.FILES_LOCAL_ROOT; else process.env.FILES_LOCAL_ROOT = oldRoot; if (oldJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldJwt; rmSync(fileRoot, { recursive: true, force: true }); });
  const run = (apply: boolean) => runLegacyImport(ds, svc.resources, svc.files, source, { companyId: company.id, actorId: actor.id, expectedName: '直播迁前公司', apply });
  const count = async (t: string) => Number((await ds.query(`SELECT COUNT(*) n FROM ${t} WHERE company_id = ?`, [company.id]))[0].n);

  it('试跑：报告 created/failed，随后全部回滚，不写任何直播表', async () => {
    const r = await run(false);
    expect(r.created.live_session).toBe(2);
    expect(r.created.live_commission).toBe(2);
    expect(r.failures.filter((f) => f.type.startsWith('live_')).map((f) => `${f.type}:${f.id}`).sort()).toEqual(['live_commission:3', 'live_session:3']);
    for (const t of tables) expect(await count(t)).toBe(0);
  });

  it('落库：金额按分、点数×100、投产×10000；待审核场次与审批中结算单改状态；坏行（缺直播间/不能精确换算）只影响自己', async () => {
    const r = await run(true);
    expect(r.created).toMatchObject({ live_rule_version: 1, live_schedule: 1, live_session: 2, live_session_product: 1, live_session_report: 2, live_session_order: 1, live_commission: 2, live_wage: 1, live_settlement: 2, live_settlement_line: 1, live_settlement_refund: 1 });
    const failed = r.failures.filter((f) => f.type.startsWith('live_'));
    expect(failed.find((f) => f.type === 'live_session' && f.id === '3')!.reason).toContain('直播间');
    expect(failed.find((f) => f.type === 'live_commission' && f.id === '3')!.reason).toContain('整数分');
    const [s1] = await ds.query("SELECT * FROM live_sessions WHERE company_id = ? AND status = 'approved'", [company.id]);
    expect(Number(s1.final_sales_cents)).toBe(123456); expect(s1.room_name).toBe('一号间'); expect(s1.approved_by).toBeTruthy();
    const [pending] = await ds.query("SELECT status FROM live_sessions WHERE company_id = ? AND status <> 'approved'", [company.id]);
    expect(pending.status).toBe('pending_report');
    expect(r.excluded.some((x) => x.type === 'live_session' && x.id === '2' && x.reason.includes('重新提交'))).toBe(true);
    const comm = await ds.query('SELECT role, rate_units, amount_cents, roi_scaled, ad_spend_cents FROM live_commission_records WHERE company_id = ? ORDER BY id', [company.id]);
    expect(comm.map((c: any) => [c.role, Number(c.rate_units), Number(c.amount_cents)])).toEqual([['anchor', 350, 4321], ['control', 250, 3086]]);
    expect(Number(comm[0].roi_scaled)).toBe(122842); expect(Number(comm[0].ad_spend_cents)).toBe(10050);
    const [rule] = await ds.query('SELECT rules_json FROM live_commission_rule_versions WHERE company_id = ?', [company.id]);
    const rj = typeof rule.rules_json === 'string' ? JSON.parse(rule.rules_json) : rule.rules_json;
    expect(rj.tiers[0]).toMatchObject({ minCents: 0, maxCents: 100000, anchorRateUnits: 300, controlRateUnits: 200 }); expect(rj.roiThresholdUnits).toBe(1000);
    const [w] = await ds.query('SELECT minutes, hourly_rate_cents, amount_cents FROM live_wage_records WHERE company_id = ?', [company.id]);
    expect([Number(w.minutes), Number(w.hourly_rate_cents), Number(w.amount_cents)]).toEqual([245, 3000, 12250]);
    const st = await ds.query('SELECT month, status, return_reason, payable_total_cents FROM live_settlements WHERE company_id = ? ORDER BY month', [company.id]);
    expect(st.map((x: any) => [x.month, x.status])).toEqual([['2026-08', 'approved'], ['2026-09', 'returned']]);
    expect(st[1].return_reason).toContain('重新提交'); expect(Number(st[1].payable_total_cents)).toBe(6407);
    const [sch] = await ds.query('SELECT session_id, notification_version, room_name FROM live_schedules WHERE company_id = ?', [company.id]);
    expect(Number(sch.session_id)).toBe(Number(s1.id)); expect(Number(sch.notification_version)).toBe(3); expect(sch.room_name).toBe('一号直播间');
    const [o] = await ds.query('SELECT amount_cents, shop_id FROM live_session_orders WHERE company_id = ?', [company.id]);
    expect([Number(o.amount_cents), o.shop_id]).toEqual([120000, '777']);
  });

  it('复跑幂等：已登记的行复用，不重复创建；坏行继续报告', async () => {
    const before = await Promise.all(tables.map(count));
    const r = await run(true);
    expect(Object.keys(r.created).filter((k) => k.startsWith('live_'))).toEqual([]);
    expect(r.reused.live_session).toBe(2);
    expect(await Promise.all(tables.map(count))).toEqual(before);
  });

  it('源数据变化时拒绝静默复用', async () => {
    source.live!.sessions![0].final_sales = '9999.00';
    await expect(run(true)).rejects.toThrow(/来源资料已变化/);
    source.live!.sessions![0].final_sales = '1234.56';
  });
});
