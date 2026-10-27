/** 直播管理的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_u9 npx jest --runInBand live */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { LIVE_DEFAULT_RULES, liveComputeCommission, liveSettleLine as liveSettleLineFor, type StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Notification, ResourceRecord, User } from '../entities';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { ensureDefaultLiveRules, liveClock } from './live-core';
import { LiveLedgerService } from './live-ledger.service';
import { LiveOrder, LiveOrderCandidates, LiveOrderSource, LiveRefund } from './live-order-source';
import { WorkspaceModuleRegistry } from '../workspace/module-registry';
import { LiveWorkspaceModule } from './live-workspace';
import { LiveScheduleService } from './live-schedule.service';
import { LiveSessionService } from './live-session.service';
import { LiveSettlementService } from './live-settlement.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const at = (text: string) => new Date(`${text.replace(' ', 'T')}+08:00`);

class FakeSource extends LiveOrderSource {
  orders: LiveOrder[] = [];
  refundMap = new Map<string, number>();
  down = false;
  async candidates(_c: number, _s: unknown, _o: unknown): Promise<LiveOrderCandidates> {
    return { available: true, reason: '', orders: this.orders, truncated: false, window: null };
  }
  async refunds(_c: number, _shop: string, orders: Array<{ orderId: string; amountCents: number }>) {
    if (this.down) throw new Error('接口超时');
    return new Map<string, LiveRefund>(orders.map((o) => [o.orderId, { cents: this.refundMap.get(o.orderId) ?? 0, source: this.refundMap.has(o.orderId) ? 'refund' : 'none', details: [] } as LiveRefund]));
  }
}
const order = (id: string, cents: number, extra: Partial<LiveOrder> = {}): LiveOrder => ({ orderId: id, innerId: `I${id}`, payTime: '2026-09-28 11:00:00', paid: true, amountCents: cents, status: 'Confirmed', statusLabel: '已确认', cancelled: false, ...extra });

d('直播管理（真实数据库）', () => {
  let ds: DataSource, flow: FlowService, schedules: LiveScheduleService, sessions: LiveSessionService, ledger: LiveLedgerService, settlements: LiveSettlementService;
  const source = new FakeSource();
  let company: number;
  let admin: AuthUser, manager: AuthUser, anchor: AuthUser, control: AuthUser, operator: AuthUser, reviewer: AuthUser, stranger: AuthUser, foreign: AuthUser;
  const ids: Record<string, number> = {};
  const realNow = liveClock.now;
  const clock = (text: string) => { liveClock.now = () => at(text); };

  const mkUser = async (companyId: number, account: string, name: string, extra: Record<string, unknown> = {}) =>
    (await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra } as never))).id;
  const au = (id: number, companyId: number, name: string, allow: string[] = []): AuthUser => ({ id, companyId, name, permissions: { isCompanyAdmin: false, allow, deny: [] } });
  const position = async (companyId: number, name: string, type: string) => Number((await ds.query('INSERT INTO positions (company_id, name, workspace_type) VALUES (?,?,?)', [companyId, name, type])).insertId);
  const rec = (companyId: number, type: string, title: string, data: Record<string, unknown>, status = 'normal') =>
    ds.manager.save(ResourceRecord, ds.manager.create(ResourceRecord, { companyId, type, title, uniqueKey: `${type}-${title}-${crypto.randomBytes(3).toString('hex')}`, status, statusReason: null, searchText: title.toLowerCase(), data } as never)).then((r) => r.id);
  const step = (key: string, name: string, type: StepDef['type'], assigneeId?: number): StepDef =>
    ({ key, name, type, ...(assigneeId ? { assignee: { source: 'employee', id: assigneeId } } : type === 'submit' ? { assignee: { source: 'requester' } } : {}) }) as StepDef;

  const baseStart = (over: Record<string, unknown> = {}) => ({ productIds: [ids.p1, ids.p2], douyinAccountId: ids.account, storeId: ids.store, ...over });
  const input = (over: Record<string, unknown> = {}) => ({ date: '2026-09-28', roomId: ids.n1, startTime: '10:00', endTime: '14:00', anchorId: anchor.id, controlId: control.id, operatorId: operator.id, douyinAccountId: ids.account, storeId: ids.store, ...over }) as never;
  const reviewForm = (over: Record<string, unknown> = {}) => ({ finalSource: 'anchor', ...over });
  const runOf = async (sessionId: number) => { const s = await sessions.detail(reviewer, sessionId); return s.flow as { id: number; revision: number; activeStep: { id: number } | null; me: { canPass: boolean } }; };
  const approve = async (sessionId: number, form: Record<string, unknown> = reviewForm()) => {
    const f = await runOf(sessionId);
    return flow.pass(reviewer, f.id, { revision: f.revision, stepId: f.activeStep!.id, form });
  };

  /** 一场完整的直播：排场 → 上播 → 主播、中控报下播 */
  const liveThrough = async (opts: { day: string; from: string; to: string; room: number; sales: number; ad: number; orders: LiveOrder[]; submit?: boolean }) => {
    clock(`${opts.day} ${opts.from}:00`);
    const sch = await schedules.create(manager, input({ date: opts.day, startTime: opts.from, endTime: opts.to, roomId: opts.room }));
    const started = await sessions.start(anchor, { scheduleId: sch.id, ...baseStart() });
    clock(`${opts.day} ${opts.to}:05`);
    source.orders = opts.orders;
    await sessions.report(anchor, started.id, { endAt: `${opts.day} ${opts.to}:00`, salesCents: opts.sales, orderIds: opts.orders.map((o) => o.orderId) });
    await sessions.report(control, started.id, { endAt: `${opts.day} ${opts.to}:00`, salesCents: opts.sales, adSpendCents: opts.ad, orderIds: opts.orders.map((o) => o.orderId) });
    if (opts.submit !== false) await sessions.submit(anchor, started.id);
    return started.id;
  };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test_u9' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    flow = new FlowService(ds, s.resources, new FinanceDocumentsService(ds));
    schedules = new LiveScheduleService(ds);
    sessions = new LiveSessionService(ds, flow, source);
    ledger = new LiveLedgerService(ds);
    settlements = new LiveSettlementService(ds, flow, source);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `l${crypto.randomBytes(5).toString('hex')}`, name: '直播测试', status: 'active' }));
    company = c.id;
    await ensureDefaultLiveRules(ds.manager, company);
    const posAnchor = await position(company, '主播', 'live_anchor'), posControl = await position(company, '中控', 'live_control'), posOps = await position(company, '运营', 'operations'), posOther = await position(company, '财务', 'finance');
    const adminId = await mkUser(company, 'admin', '管理员', { isCompanyAdmin: true });
    admin = { id: adminId, companyId: company, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    manager = au(await mkUser(company, 'hr', '人事', { positionId: posOther }), company, '人事', ['features.live.view', 'live.manage', 'live.commissions.view', 'flow.apply.view']);
    anchor = au(await mkUser(company, 'anchor', '小主播', { positionId: posAnchor, payType: 'hourly', hourlyRate: 5000 }), company, '小主播', ['features.live-desk.view']);
    control = au(await mkUser(company, 'control', '小中控', { positionId: posControl }), company, '小中控', ['features.live-desk.view']);
    operator = au(await mkUser(company, 'ops', '小运营', { positionId: posOps }), company, '小运营', ['features.live-desk.view']);
    reviewer = au(await mkUser(company, 'rev', '审核人', { positionId: posOther }), company, '审核人', ['features.live.view']);
    stranger = au(await mkUser(company, 'str', '路人', { positionId: posOther }), company, '路人', []);
    const fc = await ds.manager.save(Company, ds.manager.create(Company, { code: `l${crypto.randomBytes(5).toString('hex')}`, name: '别家', status: 'active' }));
    foreign = au(await mkUser(fc.id, 'fm', '外人'), fc.id, '外人', ['features.live.view', 'live.manage']);
    // 资料：西走廊下的直播间、抖音号、抖音店铺、产品
    const corridor = await rec(company, 'locations', '西走廊办公室', { name: '西走廊办公室', locationType: 'floor' });
    ids.n1 = await rec(company, 'locations', '直播间-北1', { name: '直播间-北1', locationType: 'room', parentId: corridor });
    ids.s1 = await rec(company, 'locations', '直播间-南1', { name: '直播间-南1', locationType: 'room', parentId: corridor });
    ids.account = await rec(company, 'self-media', '抖音一号', { name: '抖音一号', platform: 'douyin' });
    ids.kuaishou = await rec(company, 'self-media', '快手号', { name: '快手号', platform: 'kuaishou' });
    ids.store = await rec(company, 'stores', '抖音店', { name: '抖音店', platform: 'douyin', jushuitanShopId: 'JST1' });
    ids.storeNoJst = await rec(company, 'stores', '无绑定店', { name: '无绑定店', platform: 'douyin' });
    ids.p1 = await rec(company, 'finance-base-codes', 'SKU-A', { name: '毛巾', spec: '白色' });
    ids.p2 = await rec(company, 'finance-base-codes', 'SKU-B', { name: '牙刷', spec: '软毛', cost: 123 });
    // 流程：审核、月结都由「审核人」办理（管理员在流程配置里发布）
    await flow.saveDraft(admin, 'live-session-review', [step('apply', '提交审核', 'submit'), step('review', '场次审核', 'approval', reviewer.id), step('end', '结束', 'end')], []);
    await flow.publish(admin, 'live-session-review');
    await flow.saveDraft(admin, 'live-settlement', [step('apply', '提交审批', 'submit'), step('approve', '月结审批', 'approval', reviewer.id), step('end', '结束', 'end')], []);
    await flow.publish(admin, 'live-settlement');
  });
  afterAll(async () => { liveClock.now = realNow; await ds?.destroy(); });

  it('流程模板由业务页面发起：申请中心发不了，也不列出可申请', async () => {
    await expect(flow.start(manager, 'live-session-review', { sessionId: 1 })).rejects.toThrow(/直播管理/);
  });

  it('排场：时间、房间、人员校验；同房间不重叠、同主播不同时两个房间；首尾相接可以；通知相关人', async () => {
    clock('2026-09-28 09:00:00');
    await expect(schedules.create(anchor, input())).rejects.toThrow(/权限/);
    await expect(schedules.create(manager, input({ date: '2026-09-27' }))).rejects.toThrow(/今天及未来7天/);
    await expect(schedules.create(manager, input({ date: '2026-10-06' }))).rejects.toThrow(/今天及未来7天/);
    await expect(schedules.create(manager, input({ startTime: '10:00', endTime: '04:00' }))).rejects.toThrow(/16 小时/);
    await expect(schedules.create(manager, input({ anchorId: control.id }))).rejects.toThrow(/不是主播岗位/);
    await expect(schedules.create(manager, input({ controlId: anchor.id }))).rejects.toThrow(/不是中控岗位/);
    await expect(schedules.create(manager, input({ douyinAccountId: ids.kuaishou }))).rejects.toThrow(/抖音号/);
    await expect(schedules.create(manager, input({ roomId: 999999 }))).rejects.toThrow(/直播间/);
    const first = await schedules.create(manager, input());
    expect((await ds.manager.count(Notification, { where: { companyId: company, kind: 'live_schedule', userId: anchor.id } }))).toBe(1);
    await expect(schedules.create(manager, input({ startTime: '12:00', endTime: '16:00' }))).rejects.toThrow(/时间段不能重叠/);
    await expect(schedules.create(manager, input({ roomId: ids.s1, startTime: '13:00', endTime: '15:00' }))).rejects.toThrow(/同一主播不能同时在两个房间/);
    const adjacent = await schedules.create(manager, input({ startTime: '14:00', endTime: '16:00' }));
    // 修改：已存在的自己不算冲突；换人后原中控收到「已不再参与」
    await schedules.update(manager, adjacent.id, input({ startTime: '14:00', endTime: '17:00', controlId: null }));
    expect((await ds.manager.count(Notification, { where: { companyId: company, userId: control.id, title: '原排班已调整，您已不再参与' } }))).toBe(1);
    await expect(schedules.cancel(manager, adjacent.id, '')).rejects.toThrow(/原因/);
    await schedules.cancel(manager, adjacent.id, '主播请假');
    await expect(schedules.update(manager, adjacent.id, input())).rejects.toThrow(/不能修改/);
    expect((await schedules.list(manager, {})).rows.map((r) => r.status)).toEqual(['scheduled', 'cancelled']);
    // 只能看到自己的排场；陌生人没有入口
    expect((await schedules.list(operator, {})).rows.map((r) => r.status)).toEqual(['scheduled', 'cancelled']);
    expect((await schedules.list(control, {})).rows.map((r) => r.status)).toEqual(['scheduled']); // 被移出排场的中控只剩原来那一场
    await expect(schedules.list(stranger, {})).rejects.toThrow(/无权/);
    // 别家公司看不到、改不了
    await expect(schedules.cancel(foreign, first.id, '试试')).rejects.toThrow(/不存在/);
    // 开播前 30 分钟提醒：每个排场版本只提醒一次
    clock('2026-09-28 09:35:00');
    await schedules.scanReminders(at('2026-09-28 09:35:00'));
    await schedules.scanReminders(at('2026-09-28 09:36:00'));
    expect((await ds.manager.count(Notification, { where: { companyId: company, userId: anchor.id, title: '开播前30分钟提醒' } }))).toBe(1);
    await schedules.cancel(manager, first.id, '改期');
  });

  it('上播：身份、产品、店铺绑定、时间窗、同房间同主播只能一场直播中', async () => {
    clock('2026-09-30 09:00:00');
    const sch = await schedules.create(manager, input({ date: '2026-09-30', startTime: '10:00', endTime: '12:00' }));
    await expect(sessions.start(stranger, { scheduleId: sch.id, ...baseStart() })).rejects.toThrow(/无权/);
    await expect(sessions.start(anchor, { scheduleId: sch.id, ...baseStart({ productIds: [] }) })).rejects.toThrow(/产品/);
    await expect(sessions.start(anchor, { scheduleId: sch.id, ...baseStart({ storeId: ids.storeNoJst }) })).rejects.toThrow(/聚水潭店铺编号/);
    await expect(sessions.start(anchor, { scheduleId: sch.id, ...baseStart({ startAt: '2026-09-30 09:30:00' }) })).rejects.toThrow(/晚于现在/);
    clock('2026-09-30 06:00:00');
    await expect(sessions.start(anchor, { scheduleId: sch.id, ...baseStart() })).rejects.toThrow(/还早/);
    clock('2026-09-30 10:02:00');
    const s1 = await sessions.start(anchor, { scheduleId: sch.id, ...baseStart() });
    await expect(sessions.start(anchor, { scheduleId: sch.id, ...baseStart() })).rejects.toThrow(/已上播/);
    await expect(sessions.start(manager, { roomId: ids.n1, anchorId: anchor.id, ...baseStart() })).rejects.toThrow(/正在直播/);
    const detail = await sessions.detail(anchor, s1.id);
    expect(detail).toMatchObject({ status: 'live', roomName: '直播间-北1', products: [{ code: 'SKU-A' }, { code: 'SKU-B' }] });
    expect(JSON.stringify(detail)).not.toContain('cost'); // 产品只带编码、名称、规格
    await expect(sessions.detail(stranger, s1.id)).rejects.toThrow(/无权|没有查看/);
    await expect(sessions.detail(foreign, s1.id)).rejects.toThrow(/不存在/);
    // 当天排场在全览里显示为直播中
    const ov = await schedules.overview(manager, '2026-09-30');
    expect(ov.totals).toMatchObject({ rooms: 2, live: 1 });
    // 清理这一场，后续用例用别的日期
    clock('2026-09-30 12:05:00');
    source.orders = [order('X1', 100)];
    await sessions.report(anchor, s1.id, { endAt: '2026-09-30 12:00:00', salesCents: 100, orderIds: ['X1'] });
    expect((await sessions.detail(anchor, s1.id)).status).toBe('pending_report');
    await sessions.report(control, s1.id, { endAt: '2026-09-30 12:00:00', salesCents: 100, adSpendCents: 0, orderIds: ['X1'] });
    await sessions.submit(control, s1.id);
    await approve(s1.id, reviewForm({ noOperator: true }));
    expect((await sessions.detail(manager, s1.id)).status).toBe('approved');
  });

  it('报下播：只能本人填报；必须勾选聚水潭订单；订单金额以服务端为准；提交前两人都要报', async () => {
    clock('2026-09-29 10:02:00');
    const sch = await schedules.create(manager, input({ date: '2026-09-29', startTime: '10:00', endTime: '12:00' }));
    const s = await sessions.start(anchor, { scheduleId: sch.id, ...baseStart() });
    clock('2026-09-29 12:05:00');
    source.orders = [order('A1', 60000), order('A2', 40000), order('U1', 5000, { paid: false }), order('C1', 7000, { cancelled: true })];
    await expect(sessions.report(manager, s.id, { endAt: '2026-09-29 12:00:00', salesCents: 100000, orderIds: ['A1'] })).rejects.toThrow(/本人/);
    await expect(sessions.report(anchor, s.id, { endAt: '2026-09-29 12:00:00', salesCents: 100000, orderIds: [] })).rejects.toThrow(/勾选/);
    await expect(sessions.report(anchor, s.id, { endAt: '2026-09-29 12:00:00', salesCents: 100000, orderIds: ['U1'] })).rejects.toThrow(/未付款或已取消/);
    await expect(sessions.report(anchor, s.id, { endAt: '2026-09-29 12:00:00', salesCents: 100000, orderIds: ['NOPE'] })).rejects.toThrow(/不在本场/);
    await expect(sessions.report(anchor, s.id, { endAt: '2026-09-29 09:00:00', salesCents: 100000, orderIds: ['A1'] })).rejects.toThrow(/晚于上播/);
    await expect(sessions.report(anchor, s.id, { endAt: '2026-09-29 13:00:00', salesCents: 100000, orderIds: ['A1'] })).rejects.toThrow(/不能晚于现在/);
    await expect(sessions.report(control, s.id, { endAt: '2026-09-29 12:00:00', salesCents: 100000, orderIds: ['A1'] })).rejects.toThrow(/投流/);
    await sessions.report(anchor, s.id, { endAt: '2026-09-29 12:00:00', salesCents: 100000, orderIds: ['A1', 'A2'] });
    await expect(sessions.submit(anchor, s.id)).rejects.toThrow(/中控还没有报下播/);
    const d1 = await sessions.detail(anchor, s.id);
    expect(d1).toMatchObject({ status: 'pending_report', endAt: '2026-09-29 12:00:00' });
    expect(d1.reports[0]).toMatchObject({ role: 'anchor', ordersTotalCents: 100000, orderCount: 2 });
    // 预估提成：主播只看到自己的角色
    expect(d1.preview).toMatchObject({ available: true, control: null, operator: null });
    expect(d1.preview!.anchor).toEqual(liveComputeCommission({ rules: LIVE_DEFAULT_RULES, finalSalesCents: 100000, adSpendCents: null }).anchor);
    // 上播房间/主播在下播后空出来
    clock('2026-09-29 12:10:00');
    await sessions.report(control, s.id, { endAt: '2026-09-29 12:00:00', salesCents: 100000, adSpendCents: 5000, orderIds: ['A1', 'A2'] });
    await sessions.report(control, s.id, { endAt: '2026-09-29 12:00:00', salesCents: 99000, adSpendCents: 5000, orderIds: ['A1', 'A2'] }); // 提交前可以改
    expect((await sessions.detail(manager, s.id)).reports.find((r) => r.role === 'control')).toMatchObject({ salesCents: 99000 });
    // 提交：主播发起，流程里生成一张审核单；已提交后不能再改报告
    const submitted = await sessions.submit(anchor, s.id);
    expect((await sessions.detail(anchor, s.id)).status).toBe('submitted');
    await expect(sessions.report(anchor, s.id, { endAt: '2026-09-29 12:00:00', salesCents: 1, orderIds: ['A1'] })).rejects.toThrow(/已提交审核/);
    await expect(sessions.submit(anchor, s.id)).rejects.toThrow();
    // 审核人看得到这场（不是参与人），陌生人看不到
    expect((await sessions.list(reviewer, { status: 'submitted' })).rows.map((r) => r.id)).toContain(s.id);
    expect((await sessions.list(stranger, {}).catch(() => ({ rows: [] }))).rows).toHaveLength(0);
    // 退回 → 主播改后重新提交（中控也可以提交）→ 审核通过
    const f = await runOf(s.id);
    expect(submitted.runId).toBe(f.id);
    await flow.returnBack(reviewer, f.id, { revision: f.revision, stepId: f.activeStep!.id, reason: '销售额对不上' });
    expect(await sessions.detail(anchor, s.id)).toMatchObject({ status: 'returned', returnReason: '销售额对不上' });
    await sessions.report(control, s.id, { endAt: '2026-09-29 12:00:00', salesCents: 100000, adSpendCents: 5000, orderIds: ['A1', 'A2'] });
    await sessions.submit(control, s.id);
    expect((await sessions.detail(anchor, s.id)).status).toBe('submitted');
    await expect(sessions.reviewPreview(stranger, s.id, reviewForm())).rejects.toThrow(/权限|无权/);
    // 手填必须写原因；运营不能是主播；时薪缺省取档案（50元/小时 × 2小时）
    await expect(approve(s.id, { finalSource: 'manual', finalSalesCents: 120000 })).rejects.toThrow(/原因/);
    await expect(approve(s.id, reviewForm({ operatorUserId: anchor.id }))).rejects.toThrow(/不能同时是本场主播/);
    const pv = await sessions.reviewPreview(reviewer, s.id, reviewForm({ finalSource: 'control_orders' }));
    expect(pv).toMatchObject({ finalSalesCents: 100000, wage: { minutes: 118, hourlyRateCents: 5000, amountCents: 9833, rateSource: 'archive' } });
    await approve(s.id, reviewForm({ finalSource: 'control_orders' }));
    const done = await sessions.detail(manager, s.id);
    const expected = liveComputeCommission({ rules: LIVE_DEFAULT_RULES, finalSalesCents: 100000, adSpendCents: 5000 });
    expect(done).toMatchObject({ status: 'approved', finalSalesCents: 100000, finalSalesSource: 'control_orders', wage: { amountCents: 9833, minutes: 118 } });
    expect(done.commissions.map((c) => [c.role, c.amountCents])).toEqual([['anchor', expected.anchor.amountCents], ['control', expected.control.amountCents], ['operator', expected.operator.amountCents]]);
    // 提成金额只给本人看：主播只看到自己那一行
    expect((await sessions.detail(anchor, s.id)).commissions.map((c) => c.role)).toEqual(['anchor']);
    expect((await sessions.detail(operator, s.id)).commissions.map((c) => c.role)).toEqual(['operator']);
  });

  it('拒绝：场次回到已退回并解除流程关联，重新提交会发起新的审核流程', async () => {
    const id = await liveThrough({ day: '2026-09-27', from: '10:00', to: '12:00', room: ids.s1, sales: 50000, ad: 0, orders: [order('B1', 50000)] });
    const f = await runOf(id);
    await flow.stop(reviewer, f.id, 'reject', { revision: f.revision, stepId: f.activeStep!.id, reason: '数据不真实' });
    const after = await sessions.detail(manager, id);
    expect(after).toMatchObject({ status: 'returned', flowRunId: null, returnReason: '数据不真实' });
    const again = await sessions.submit(anchor, id);
    expect(again.runId).not.toBe(f.id);
    // 本场也审核通过，运营不参与：不生成运营提成
    await approve(id, reviewForm({ noOperator: true, wageHourlyRateCents: 8000 }));
    const done = await sessions.detail(manager, id);
    expect(done.commissions.map((c) => c.role)).toEqual(['anchor', 'control']);
    expect(done.wage).toMatchObject({ hourlyRateCents: 8000, amountCents: 16000, rateSource: 'manual' });
  });

  it('提成、工资记录：全员权限者看全部，其他人只看本人；规则只追加', async () => {
    const all = await ledger.commissions(manager, { month: '2026-09' });
    expect(all.scope).toBe('all');
    expect(all.rows.length).toBe(3 + 2 + 2 - 0); // 09-29 三人、09-27 两人（无运营）、09-30 两人
    const mine = await ledger.commissions(anchor, { month: '2026-09' });
    expect(mine.scope).toBe('mine');
    expect(new Set(mine.rows.map((r) => r.userId))).toEqual(new Set([anchor.id]));
    expect(mine.totalCents).toBe(all.rows.filter((r) => r.userId === anchor.id).reduce((t, r) => t + r.amountCents, 0));
    expect((await ledger.wages(anchor, { month: '2026-09' })).rows).toHaveLength(3);
    expect((await ledger.wages(control, { month: '2026-09' })).rows).toHaveLength(0);
    await expect(ledger.commissions(stranger, { month: '2026-09' })).rejects.toThrow(/无权/);
    const rules = await ledger.rules(manager);
    expect(rules.versions).toHaveLength(1);
    expect(rules.versions[0].usedCount).toBeGreaterThan(0);
    const form = rules.versions[0].form;
    await expect(ledger.createRule(manager, { effectiveFrom: '2026-01-01', rules: form })).rejects.toThrow(/已经有一个规则版本/);
    await expect(ledger.createRule(manager, { effectiveFrom: '2026-11-01', rules: { ...form, tiers: [{ ...form.tiers[0], min: '1' }] } })).rejects.toThrow(/从 0 开始/);
    await ledger.createRule(manager, { effectiveFrom: '2026-11-01', note: '提高运营比例', rules: { ...form, operatorRate: '1' } });
    expect((await ledger.rules(manager)).versions.map((v) => v.effectiveFrom)).toEqual(['2026-11-01', '2026-01-01']);
    expect(await ledger.trial(manager, { rules: form, sales: '10000', adSpend: '1000' })).toMatchObject({ belowRoi: false });
  });

  it('月结：必须只读核对退款（查不到不生成）；按原比例扣减；提交后锁月；审批通过后锁定', async () => {
    clock('2026-10-05 10:00:00');
    const unconfigured = new LiveSettlementService(ds, flow, new (await import('./live-order-source')).UnconfiguredLiveOrderSource());
    await expect(unconfigured.generate(manager, '2026-09')).rejects.toThrow(/没有生成结算单/);
    await expect(settlements.generate(anchor, '2026-09')).rejects.toThrow(/权限/);
    await expect(settlements.generate(manager, '2026-10')).rejects.toThrow(/没有已审核的提成记录/);
    source.down = true;
    await expect(settlements.generate(manager, '2026-09')).rejects.toThrow(/暂时查不到/);
    source.down = false;
    source.refundMap = new Map([['A1', 30000], ['B1', 50000]]);
    const { id } = await settlements.generate(manager, '2026-09', '九月月结');
    const detail = await settlements.detail(manager, id);
    expect(detail).toMatchObject({ status: 'draft', month: '2026-09', recordCount: 7, refundTotalCents: 80000 });
    for (const line of detail.lines) {
      const refund = line.sessionId === detail.lines.find((l) => l.date === '2026-09-29')!.sessionId ? 30000 : line.date === '2026-09-27' ? 50000 : 0;
      const expected = liveSettleLineFor({ commissionCents: line.commissionCents, rateUnits: line.rateUnits, refundCents: refund });
      expect([line.refundCents, line.deductionCents, line.payableCents]).toEqual([refund, expected.deductionCents, expected.payableCents]);
    }
    expect(detail.commissionTotalCents - detail.deductionTotalCents).toBe(detail.payableTotalCents);
    expect(detail.refunds.map((r) => r.orderId).sort()).toEqual(['A1', 'B1']);
    // 重新核对：同一张单更新，不会多出一张
    const again = await settlements.generate(manager, '2026-09');
    expect(again.id).toBe(id);
    // 提交审批：之后本月不能再新建场次
    await expect(settlements.submit(anchor, id)).rejects.toThrow(/权限/);
    await settlements.submit(manager, id);
    expect((await settlements.detail(manager, id)).status).toBe('submitted');
    await expect(settlements.generate(manager, '2026-09')).rejects.toThrow(/正在审批中/);
    clock('2026-09-30 23:00:00');
    await expect(sessions.start(manager, { roomId: ids.s1, anchorId: anchor.id, ...baseStart() })).rejects.toThrow(/结算审批/);
    clock('2026-10-05 11:00:00');
    const run = (await settlements.detail(manager, id)).flowRunId!;
    const f = await flow.detail(reviewer, run);
    await flow.pass(reviewer, run, { revision: f.revision, stepId: f.activeStep!.id });
    const done = await settlements.detail(manager, id);
    expect(done).toMatchObject({ status: 'approved' });
    await expect(settlements.generate(manager, '2026-09')).rejects.toThrow(/已经结算完成/);
    // 别家公司看不到
    await expect(settlements.detail(foreign, id)).rejects.toThrow(/权限|不存在/);
    expect((await settlements.list(manager)).rows.map((r) => r.month)).toEqual(['2026-09']);
  });

  it('接入工作台：总控台看到待审核与过时未上播；运营看今日排场；主播看自己的提成；没有权限的不出卡片', async () => {
    const registry = new WorkspaceModuleRegistry();
    const mod = new LiveWorkspaceModule(ds, registry);
    expect(registry.has('live')).toBe(true);
    clock('2026-10-12 09:00:00');
    const sch = await schedules.create(manager, input({ date: '2026-10-12', startTime: '08:00', endTime: '11:00' }));
    expect(sch.id).toBeGreaterThan(0);
    const boss = await registry.get('live')!.bossCards!(manager);
    expect(boss.find((c) => c.key === 'live-missed')).toMatchObject({ value: 1, tone: 'bad', page: 'features.live' });
    expect(await mod.bossCards(stranger)).toEqual([]);
    const ops = await registry.get('live')!.deskCards!(operator, 'operations');
    expect(ops.find((c) => c.key === 'live-today')).toMatchObject({ value: 1, label: '我今天的直播排场' });
    const mine = await registry.get('live')!.deskCards!(anchor, 'live_anchor');
    expect(mine.find((c) => c.key === 'live-mine')!.value).toBe(1);
    expect(Number(mine.find((c) => c.key === 'live-commission')!.value)).toBeGreaterThanOrEqual(0);
    expect(await mod.deskCards(manager, 'finance')).toEqual([]);
  });
});
