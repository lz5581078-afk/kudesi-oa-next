import { LiveCheckinClosureService } from './live-checkin-closure.service';
import { LiveTurnoverOrder } from './live-order-source';
import { LiveManualProducts1766000000000 } from '../database/migrations/1766000000000-LiveManualProducts';
import { livePeople, loadLiveAccess } from './live-access';
import { LiveTurnoverService } from './live-turnover.service';
import { LiveManagementService } from './live-management.service';
/** 直播管理的真实数据库测试。RESOURCE_DB_TEST=1 TEST_DB_NAME=kudesi_oa_test_u9 npx jest --runInBand live */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { LIVE_DEFAULT_RULES, liveComputeCommission, liveSettleLine as liveSettleLineFor, type StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Department, Notification, ResourceRecord, User } from '../entities';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { ensureDefaultLiveRules, liveClock } from './live-core';
import { LiveLedgerService } from './live-ledger.service';
import { LiveOrder, LiveOrderCandidates, LiveOrderSource, LiveRefund, type LiveSourceStatus } from './live-order-source';
import { FeishuNoticeService } from '../outbox/feishu-notice.service';
import { WorkspaceModuleRegistry } from '../workspace/module-registry';
import { LiveWorkspaceModule } from './live-workspace';
import { LiveScheduleService } from './live-schedule.service';
import { LiveSessionService } from './live-session.service';
import { LiveSettlementService } from './live-settlement.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const at = (text: string) => new Date(`${text.replace(' ', 'T')}+08:00`);

class FakeSource extends LiveOrderSource {
  orders: LiveOrder[] = [];
  turnover: LiveTurnoverOrder[]=[];
  async turnoverOrders(){return {available:!this.unavailable,reason:this.unavailable,orders:this.turnover,truncated:this.truncated};}
  refundMap = new Map<string, number>();
  down = false;
  unavailable = ''; truncated = false;
  state: LiveSourceStatus = { ready: true, code: 'ready', message: '' };
  async status(_c: number) { return this.state; }
  async candidates(_c: number, _s: unknown, _o: unknown): Promise<LiveOrderCandidates> {
    if (this.unavailable) return { available: false, reason: this.unavailable, orders: [], truncated: false, window: null };
    return { available: true, reason: this.truncated ? '订单太多' : '', orders: this.orders, truncated: this.truncated, window: null };
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
    control = au(await mkUser(company, 'control', '小中控', { positionId: posControl, payType:'hourly',hourlyRate:3000 }), company, '小中控', ['features.live-desk.view']);
    operator = au(await mkUser(company, 'ops', '小运营', { positionId: posOps }), company, '小运营', ['features.live-desk.view']);
    reviewer = au(await mkUser(company, 'rev', '审核人', { positionId: posOther }), company, '审核人', ['features.live.view']);
    stranger = au(await mkUser(company, 'str', '路人', { positionId: posOther }), company, '路人', []);
    const fc = await ds.manager.save(Company, ds.manager.create(Company, { code: `l${crypto.randomBytes(5).toString('hex')}`, name: '别家', status: 'active' }));
    foreign = au(await mkUser(fc.id, 'fm', '外人'), fc.id, '外人', ['features.live.view', 'live.manage']);
    // 资料：西走廊下的直播间、抖音号、抖音店铺、产品
    const corridor = await rec(company, 'locations', '西走廊办公室', { name: '西走廊办公室', locationType: 'floor' });
    ids.n1 = await rec(company, 'locations', '直播间-北1', { name: '直播间-北1', locationType: 'room', parentId: corridor });
    ids.s1 = await rec(company, 'locations', '直播间-南1', { name: '直播间-南1', locationType: 'room', parentId: corridor });
    ids.account = await rec(company, 'self-media', '抖音一号', { name: '抖音一号', platform: 'douyin',livePermission:true });
    ids.kuaishou = await rec(company, 'self-media', '快手号', { name: '快手号', platform: 'kuaishou' });
    ids.store = await rec(company, 'stores', '抖音店', { name: '抖音店', platform: 'douyin', jushuitanShopId: 'JST1' });
    ids.storeNoJst = await rec(company, 'stores', '无绑定店', { name: '无绑定店', platform: 'douyin' });
    await ds.query("UPDATE resource_records SET data=JSON_SET(data,'$.storeIds',CAST(? AS JSON)) WHERE company_id=? AND id=?",[JSON.stringify([ids.store,ids.storeNoJst]),company,ids.account]);
    ids.p1 = await rec(company, 'finance-base-codes', 'SKU-A', { name: '毛巾', spec: '白色' });
    ids.p2 = await rec(company, 'finance-base-codes', 'SKU-B', { name: '牙刷', spec: '软毛', cost: 123 });
    // 流程：审核、月结都由「审核人」办理（管理员在流程配置里发布）
    await flow.saveDraft(admin, 'live-session-review', [step('apply', '提交审核', 'submit'), step('review', '场次审核', 'approval', reviewer.id), step('end', '结束', 'end')], []);
    await flow.publish(admin, 'live-session-review');
    await flow.saveDraft(admin, 'live-settlement', [step('apply', '提交审批', 'submit'), step('approve', '月结审批', 'approval', reviewer.id), step('end', '结束', 'end')], []);
    await flow.publish(admin, 'live-settlement');
  },30000);
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
    await expect(schedules.create(manager, input({ douyinAccountId: ids.kuaishou }))).rejects.toThrow(/直播账号/);
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
    // Unbound shops can be used; reporting them requires an explicit manual reason.
    expect((await schedules.options(manager)).stores.find(s=>s.id===ids.storeNoJst)?.hasJstShop).toBe(false);
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
    // Simulate pre-upgrade session: no channel snapshot, retain its original single-shop calculation.
    await ds.query('UPDATE live_sessions SET channels_json=NULL WHERE company_id=? AND id=?',[company,s1.id]);
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
    expect((await sessions.detail(control,s.id)).wages.map(w=>w.role)).toEqual(['control']);
    expect((await sessions.detail(control,s.id)).wage).toBeNull();
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
    expect((await ledger.wages(control, { month: '2026-09' })).rows).toHaveLength(3);
    await expect(ledger.commissions(stranger, { month: '2026-09' })).rejects.toThrow(/无权/);
    const sid=mine.rows[0].sessionId;
    const manualProduct=await ds.query("INSERT INTO live_session_products(company_id,session_id,base_code_id,code_snapshot,name_snapshot,spec_snapshot,sort_order) VALUES(?,?,NULL,'','本场手填产品','大包',99)",[company,sid]);
    const otherProduct=await ds.query("INSERT INTO live_session_products(company_id,session_id,base_code_id,code_snapshot,name_snapshot,spec_snapshot,sort_order) VALUES(?,?,NULL,'','别家公司产品','',100)",[foreign.companyId,sid]);
    try {
      const refreshed=await ledger.commissions(anchor,{month:'2026-09'});
      const row=refreshed.rows.find(r=>r.sessionId===sid)!;
      const original=await sessions.detail(anchor,sid);
      expect(row.startAt).toBe(original.startAt.slice(0,16));expect(row.endAt).toBe(original.endAt!.slice(0,16));
      const millis=(value:string)=>Date.parse(value.replace(' ','T')+'+08:00');
      expect(row.liveMinutes).toBe(Math.round((millis(original.endAt!)-millis(original.startAt))/60000));
      try {
        await ds.query('UPDATE live_sessions SET start_at=?,end_at=? WHERE company_id=? AND id=?',['2026-09-01 23:00:10','2026-09-02 01:00:40',company,sid]);
        const cross=(await ledger.commissions(anchor,{month:'2026-09'})).rows.find(r=>r.sessionId===sid)!;
        expect(cross.liveMinutes).toBe(121);
        expect(cross.amountCents).toBe(row.amountCents);
        await ds.query('UPDATE live_sessions SET end_at=NULL WHERE company_id=? AND id=?',[company,sid]);
        expect((await ledger.commissions(anchor,{month:'2026-09'})).rows.find(r=>r.sessionId===sid)!.liveMinutes).toBeNull();
      } finally {
        await ds.query('UPDATE live_sessions SET start_at=?,end_at=? WHERE company_id=? AND id=?',[original.startAt,original.endAt,company,sid]);
      }
      expect(row.products).toEqual(original.products);
      expect(row.products).toContainEqual({id:null,code:'',name:'本场手填产品',spec:'大包'});
      expect(JSON.stringify(row.products)).not.toContain('别家公司产品');expect(JSON.stringify(row.products)).not.toContain('cost');
    }finally{
      await ds.query('DELETE FROM live_session_products WHERE id IN (?,?)',[manualProduct.insertId,otherProduct.insertId]);
    }
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
    await expect(unconfigured.generate(manager, '2026-09')).rejects.toThrow(/不能生成结算单.*授权/);
    // 有要核对退款的订单、但聚水潭读取没就绪（没授权）时，明确提示，不生成残缺结算单
    source.state = { ready: false, code: 'unauthorized', message: '公司还没有授权聚水潭' };
    await expect(settlements.generate(manager, '2026-09')).rejects.toThrow(/不能生成结算单.*授权聚水潭/);
    source.state = { ready: true, code: 'ready', message: '' };
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
      expect([line.refundCents, line.deductionCents, line.payableCents]).toEqual([refund, expected.deductionCents, expected.payableCents+(line.wageCents??0)]);
    }
    expect(detail.commissionTotalCents + detail.wageTotalCents - detail.deductionTotalCents).toBe(detail.payableTotalCents);
    expect(detail.refunds.filter(r=>r.refundCents>0).map((r) => r.orderId).sort()).toEqual(['A1', 'B1']);
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

  it('对齐旧站：聚水潭没授权不能报下播；本场没订单可以不勾；订单被截断不放行；预估提成按角色过滤', async () => {
    clock('2026-10-14 10:02:00');
    const sch = await schedules.create(manager, input({ date: '2026-10-14', startTime: '10:00', endTime: '12:00' }));
    const s = await sessions.start(anchor, { scheduleId: sch.id, ...baseStart() });
    clock('2026-10-14 12:05:00');
    const body = { endAt: '2026-10-14 12:00:00', salesCents: 80000, orderIds: [] as string[] };
    source.unavailable = '公司还没有授权聚水潭';
    await expect(sessions.report(anchor, s.id, body)).rejects.toThrow(/授权聚水潭.*人工核定原因/);
    source.unavailable = ''; source.truncated = true; source.orders = [order('T1', 1000)];
    await expect(sessions.report(anchor, s.id, { ...body, orderIds: ['T1'] })).rejects.toThrow(/订单太多/);
    source.truncated = false; source.orders = [order('CANCELLED-ONLY',1000,{cancelled:true,status:'Cancelled'})];
    await sessions.report(anchor, s.id, body); // 聚水潭查到本场没有订单：允许空勾选
    expect((await sessions.detail(anchor, s.id)).reports[0]).toMatchObject({ role: 'anchor', ordersTotalCents: 0, orderCount: 0, salesCents: 80000 });
    // 预估提成：主播只能看到自己的角色；陌生人不能看；格式不对给 400
    const own = await sessions.previewFor(anchor, s.id, { sales: '800' });
    expect(own).toMatchObject({ available: true, basisSalesCents: 80000, control: null, operator: null });
    expect(own!.anchor!.amountCents).toBe(liveComputeCommission({ rules: LIVE_DEFAULT_RULES, finalSalesCents: 80000, adSpendCents: null }).anchor.amountCents);
    await expect(sessions.previewFor(stranger, s.id, { sales: '800' })).rejects.toThrow();
    await expect(sessions.previewFor(anchor, s.id, { sales: '8x' })).rejects.toThrow();
    expect(await sessions.previewFor(anchor, s.id, { sales: '' })).toMatchObject({ available: false });
    // 授权状态：就绪/未授权都能读到，不会抛错
    expect(await sessions.integrationStatus(anchor)).toMatchObject({ ready: true });
    source.state = { ready: false, code: 'unauthorized', message: '公司还没有授权聚水潭' };
    expect(await sessions.integrationStatus(anchor)).toMatchObject({ ready: false, code: 'unauthorized' });
    await expect(sessions.integrationStatus(stranger)).rejects.toThrow();
    source.state = { ready: true, code: 'ready', message: '' };
  });

  it('对齐旧站：排场通知同步入飞书队列（开关开启时），改排场作废旧的未发通知，取消另发一条', async () => {
    const feishu = new FeishuNoticeService(ds);
    const withFeishu = new LiveScheduleService(ds, feishu);
    await ds.query('INSERT INTO outbox_switches (company_id, channel, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [company, 'feishu']);
    clock('2026-10-19 09:00:00');
    const sch = await withFeishu.create(manager, input({ date: '2026-10-20', startTime: '10:00', endTime: '12:00' }));
    const jobs = () => ds.query("SELECT status, JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.kind')) kind, JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.userId')) uid FROM outbox_jobs WHERE company_id = ? AND channel = 'feishu' AND resource_type = 'live-schedule' AND resource_id = ? ORDER BY id", [company, sch.id]);
    const first = await jobs();
    expect(first.length).toBeGreaterThanOrEqual(2); // 主播、中控、运营各一条
    expect(first.every((j: any) => j.status === 'pending' && j.kind === 'schedule')).toBe(true);
    await withFeishu.update(manager, sch.id, input({ date: '2026-10-20', startTime: '11:00', endTime: '13:00' }));
    const after = await jobs();
    expect(after.filter((j: any) => j.kind === 'schedule' && j.status === 'cancelled').length).toBe(first.length);
    expect(after.filter((j: any) => j.kind === 'changed' && j.status === 'pending').length).toBeGreaterThan(0);
    await withFeishu.cancel(manager, sch.id, '主播请假');
    expect((await jobs()).some((j: any) => j.kind === 'cancelled' && j.status === 'pending')).toBe(true);
    await ds.query("UPDATE outbox_switches SET enabled = 0 WHERE company_id = ? AND channel = 'feishu'", [company]);
    const before = (await jobs()).length;
    const sch2 = await withFeishu.create(manager, input({ date: '2026-10-21', startTime: '10:00', endTime: '12:00' }));
    expect(sch2.id).toBeGreaterThan(0);
    expect((await jobs()).length).toBe(before); // 开关关着时不入队
  });
  it('房间设置、试播身份、人事补报：公司隔离、审计与统一审核', async()=>{
    clock('2026-08-20 18:00:00');
    const management=new LiveManagementService(ds,source);
    await expect(management.room(stranger,ids.s1,{products:'毛巾'})).rejects.toThrow(/权限/);
    await expect(management.room(foreign,ids.s1,{products:'毛巾'})).rejects.toThrow(/不存在/);
    await management.room(manager,ids.s1,{ownerId:operator.id,products:'毛巾 / 白色'});
    expect((await schedules.options(manager)).rooms.find(r=>r.id===ids.s1)).toMatchObject({ownerId:operator.id,products:'毛巾 / 白色'});
    expect((await schedules.list(manager,{})).rooms).toHaveLength(2);
    const trial=await management.trial(manager,{name:'试播甲',hourlyRateCents:6000});
    expect((await schedules.options(manager)).anchors.find(p=>p.id===trial.id)).toMatchObject({trial:true,name:'试播甲'});
    const [person]=await ds.query('SELECT account,password_hash,position_id FROM users WHERE company_id=? AND id=?',[company,trial.id]);
    expect(person).toMatchObject({account:null,password_hash:'!no-login',position_id:null});
    await expect(management.trial(manager,{name:'试播甲',hourlyRateCents:6000})).rejects.toThrow(/同名/);
    const body={roomId:ids.s1,anchorId:trial.id,controlId:control.id,operatorId:operator.id,douyinAccountId:ids.account,storeId:ids.store,startAt:'2026-08-18 10:00:00',endAt:'2026-08-18 12:00:00',salesCents:100000,adSpendCents:5000,reason:'试播漏报，人事核定',controlSalesCents:90000,operatorSalesCents:110000,orderIds:[]};
    await expect(management.manual(stranger,body)).rejects.toThrow(/权限/);
    await expect(management.manual(manager,{...body,anchorId:foreign.id})).rejects.toThrow(/有效/);
    const made=await management.manual(manager,body);
    await expect(management.manual(manager,body)).rejects.toThrow(/已有/);
    await expect(sessions.submit(stranger,made.id)).rejects.toThrow();
    const reported=await sessions.detail(manager,made.id);
    expect(reported.reports.find(r=>r.role==='control')!.salesCents).toBe(90000);
    expect(reported.reports.find(r=>r.role==='operator')!.salesCents).toBe(110000);
    await sessions.submit(manager,made.id);
    await approve(made.id,reviewForm({controlWageHourlyRateCents:4000}));
    expect((await ledger.wages(manager,{month:'2026-08',role:'anchor'})).rows).toEqual([expect.objectContaining({userId:trial.id,amountCents:12000,minutes:120})]);
    expect((await ledger.wages(manager,{month:'2026-08',role:'control'})).rows).toEqual([expect.objectContaining({userId:control.id,amountCents:8000,role:'control'})]);
    const [audit]=await ds.query("SELECT COUNT(*) n FROM audit_logs WHERE company_id=? AND action='live.manual.report'",[company]);
    expect(Number(audit.n)).toBe(1);
  });

  it('原场次详情回带秒级时间、逐店订单和角色投流；按原编号补报更新同一记录',async()=>{
    const management=new LiveManagementService(ds,source);
    clock('2026-04-17 09:00:00');
    const schedule=await schedules.create(manager,input({date:'2026-04-17',startTime:'10:00',endTime:'12:00',productIds:[ids.p1]}));
    clock('2026-04-17 10:02:37');
    const started=await sessions.start(anchor,{scheduleId:schedule.id,...baseStart({startAt:'2026-04-17 10:02:37',productIds:[ids.p1]})});
    clock('2026-04-17 12:10:00');
    source.unavailable='';source.truncated=false;source.orders=[order('LOAD-ORIGINAL',12345,{payTime:'2026-04-17 11:00:00'})];
    await sessions.report(anchor,started.id,{endAt:'2026-04-17 12:08:49',salesCents:12345,orderIds:['LOAD-ORIGINAL'],note:'原主播说明'});
    await sessions.report(control,started.id,{endAt:'2026-04-17 12:08:49',salesCents:12345,adSpendCents:678,orderIds:['LOAD-ORIGINAL']});
    const original=await sessions.detail(manager,started.id);
    expect(original).toMatchObject({scheduleId:schedule.id,startAt:'2026-04-17 10:02:37',endAt:'2026-04-17 12:08:49'});
    expect(original.products).toHaveLength(1);
    expect(original.reports.find(r=>r.role==='control')!.storeLines[0].adSpendCents).toBe(678);
    const line={...original.reports.find(r=>r.role==='anchor')!.storeLines[0],salesCents:13000,adSpendCents:900,reason:'核对后修正'};
    const saved=await management.manual(manager,{sessionId:original.id,roomId:original.roomId,anchorId:original.anchor.id,controlId:original.control!.id,operatorId:original.operator!.id,channels:original.channels.map(c=>({accountId:c.accountId,storeIds:c.storeIds})),douyinAccountId:original.douyinAccount.id,storeId:original.store!.id,startAt:original.startAt,endAt:original.endAt!,salesCents:13000,adSpendCents:900,storeLines:[line],reason:'核对后修正'});
    expect(saved.id).toBe(started.id);
    const again=await sessions.detail(manager,started.id);
    expect(again).toMatchObject({scheduleId:schedule.id,startAt:'2026-04-17 10:02:37',manualReason:'核对后修正'});
    expect(again.products).toEqual(original.products);
    expect(again.reports.find(r=>r.role==='anchor')!).toMatchObject({salesCents:13000,orders:[expect.objectContaining({orderId:'LOAD-ORIGINAL'})]});
    expect(again.reports.find(r=>r.role==='control')!.adSpendCents).toBe(900);
    const [count]=await ds.query('SELECT COUNT(*) n FROM live_sessions WHERE company_id=? AND schedule_id=?',[company,schedule.id]);
    expect(Number(count.n)).toBe(1);
  });

  it('874元单平台3小时审核：提成与工资按角色只落账一次，重复审核不能重复计薪',async()=>{
    clock('2026-03-17 21:05:00');source.orders=[];source.unavailable='';source.truncated=false;
    const management=new LiveManagementService(ds,source);
    const [old]=await ds.query('SELECT hourly_rate FROM users WHERE company_id=? AND id=?',[company,control.id]);
    await ds.query('UPDATE users SET hourly_rate=2000 WHERE company_id=? AND id=?',[company,control.id]);
    try {
      const made=await management.manual(manager,{roomId:ids.s1,anchorId:anchor.id,controlId:control.id,operatorId:null,douyinAccountId:ids.account,storeId:ids.store,channels:[{accountId:ids.account,storeIds:[ids.store]}],startAt:'2026-03-17 18:00:00',endAt:'2026-03-17 21:00:00',salesCents:87400,adSpendCents:0,storeLines:[{storeId:ids.store,platform:'douyin',salesCents:87400,adSpendCents:0,orderIds:[],reason:'本地874元核验'}],reason:'本地874元核验'});
      await sessions.submit(manager,made.id);
      const preview=await sessions.reviewPreview(reviewer,made.id,{finalSource:'anchor'});
      expect(preview.platforms).toHaveLength(1);
      expect(preview.anchor.amountCents).toBe(2622);expect(preview.control!.amountCents).toBe(1748);
      expect(preview.wage).toMatchObject({minutes:180,hourlyRateCents:5000,amountCents:15000});
      expect(preview.controlWage).toMatchObject({minutes:180,hourlyRateCents:2000,amountCents:6000});
      const flowBefore=await runOf(made.id);
      const body={revision:flowBefore.revision,stepId:flowBefore.activeStep!.id,form:{finalSource:'anchor'}};
      await flow.pass(reviewer,flowBefore.id,body);
      await expect(flow.pass(reviewer,flowBefore.id,body)).rejects.toThrow();
      const records=await ds.query('SELECT role,platform,amount_cents FROM live_commission_records WHERE company_id=? AND session_id=? ORDER BY role',[company,made.id]);
      expect(records.map((r:Record<string,unknown>)=>({...r,amount_cents:Number(r.amount_cents)}))).toEqual([{role:'anchor',platform:'douyin',amount_cents:2622},{role:'control',platform:'douyin',amount_cents:1748}]);
      const wages=await ds.query('SELECT role,amount_cents FROM live_wage_records WHERE company_id=? AND session_id=? ORDER BY role',[company,made.id]);
      expect(wages.map((r:Record<string,unknown>)=>({...r,amount_cents:Number(r.amount_cents)}))).toEqual([{role:'anchor',amount_cents:15000},{role:'control',amount_cents:6000}]);
    }finally{await ds.query('UPDATE users SET hourly_rate=? WHERE company_id=? AND id=?',[old.hourly_rate,company,control.id]);}
  });

  it('区间工资结算：时间工资加提成、特殊核定、重叠与结算日锁定',async()=>{
    clock('2026-08-20 18:00:00');
    const made=await settlements.generate(manager,'',undefined,{from:'2026-08-18',to:'2026-08-18'});
    const detail=await settlements.detail(manager,made.id);
    expect(detail).toMatchObject({from:'2026-08-18',to:'2026-08-18',wageTotalCents:20000});
    expect(detail.payableTotalCents).toBe(detail.wageTotalCents+detail.commissionTotalCents-detail.deductionTotalCents);
    expect(detail.lines.every(l=>l.source==='manual'&&l.manualReason==='试播漏报，人事核定')).toBe(true);
    expect(detail.lines.reduce((n,l)=>n+l.wageCents,0)).toBe(20000);
    await expect(settlements.generate(manager,'2026-08')).rejects.toThrow(/重叠/);
    await expect(settlements.generate(manager,'',undefined,{from:'2026-08-17',to:'2026-08-18'})).rejects.toThrow(/重叠/);
    expect((await settlements.generate(manager,'',undefined,{from:'2026-08-18',to:'2026-08-18'})).id).toBe(made.id);
    await settlements.submit(manager,made.id);
    const sid=detail.lines[0].sessionId;
    const management=new LiveManagementService(ds,source);
    const original=await sessions.detail(manager,sid);
    await expect(management.manual(manager,{sessionId:sid,roomId:ids.s1,anchorId:original.anchor.id,controlId:control.id,operatorId:operator.id,douyinAccountId:ids.account,storeId:ids.store,startAt:'2026-08-18 10:00:00',endAt:'2026-08-18 12:00:00',salesCents:100000,adSpendCents:0,reason:'修改'})).rejects.toThrow(/结算/);
    const f=await flow.detail(reviewer,(await settlements.detail(manager,made.id)).flowRunId!);
    clock('2026-08-18 23:00:00');
    await expect(flow.pass(reviewer,f.id,{revision:f.revision,stepId:f.activeStep!.id})).rejects.toThrow(/日期范围结束后/);
    clock('2026-08-20 18:00:00');
    await flow.pass(reviewer,f.id,{revision:f.revision,stepId:f.activeStep!.id});
    expect((await settlements.detail(manager,made.id)).status).toBe('approved');
    // 月内其他日期仍能补报，不扩大成整月锁定。
    const next=await management.manual(manager,{roomId:ids.s1,anchorId:anchor.id,controlId:null,operatorId:null,douyinAccountId:ids.account,storeId:ids.store,startAt:'2026-08-19 10:00:00',endAt:'2026-08-19 11:00:00',salesCents:0,adSpendCents:0,reason:'另一天试播'});
    expect(next.id).toBeGreaterThan(sid);
  });

  it('人事订单补报用服务端金额；未使用规则可编辑，已使用快照保留',async()=>{
    clock('2026-08-22 18:00:00');
    const management=new LiveManagementService(ds,source);
    source.orders=[order('MANUAL-1',54321)];
    const made=await management.manual(manager,{roomId:ids.s1,anchorId:anchor.id,controlId:null,operatorId:null,douyinAccountId:ids.account,storeId:ids.store,startAt:'2026-08-21 10:00:00',endAt:'2026-08-21 11:00:00',salesCents:54321,adSpendCents:0,reason:'接口异常后补单',orderIds:['MANUAL-1']});
    expect((await sessions.detail(manager,made.id)).reports[0]).toMatchObject({ordersTotalCents:54321,orderCount:1});
    const rules=await ledger.rules(manager),used=rules.versions.find(r=>r.usedCount>0)!;
    await expect(management.updateRule(manager,used.id,{effectiveFrom:used.effectiveFrom,rules:used.form})).rejects.toThrow(/另存新版本/);
    const unused=rules.versions.find(r=>r.usedCount===0)!;
    await expect(management.updateRule(foreign,unused.id,{effectiveFrom:unused.effectiveFrom,rules:unused.form})).rejects.toThrow(/不存在/);
    await management.updateRule(manager,unused.id,{effectiveFrom:unused.effectiveFrom,rules:{...unused.form,operatorRate:'2'}});
    expect((await ledger.rules(manager)).versions.find(r=>r.id===unused.id)!.form.operatorRate).toBe('2');
  });

  it('同场三平台四店：账号权限、逐店审核、分平台提成、工资一次、分平台售后与历史快照',async()=>{
    clock('2026-07-06 18:00:00');
    const platforms=['douyin','douyin','kuaishou','channels'];
    const shops:number[]=[];
    for(let i=0;i<4;i++)shops.push(await rec(company,'stores',`多平台店${i}`,{name:`多平台店${i}`,platform:platforms[i],jushuitanShopId:`MP${i}`}));
    const accounts:number[]=[];
    for(const [i,platform] of ['douyin','kuaishou','channels'].entries())accounts.push(await rec(company,'self-media',`多平台账号${i}`,{name:`多平台账号${i}`,platform,livePermission:true,storeIds:i===0?shops.slice(0,2):[shops[i+1]]}));
    const disabled=await rec(company,'self-media','未授权直播账号',{platform:'douyin',storeIds:[shops[0]]});
    expect((await schedules.options(manager)).douyinAccounts.some(a=>a.id===disabled)).toBe(false);
    const perShop=new FakeSource();
    const amounts=[60000,40000,1000000,200000];
    perShop.candidates=async(_c:number,v:any)=>({available:true,reason:'',truncated:false,orders:[order('SAME',amounts[Number(String(v.shopId).slice(2))]) ]});
    perShop.refunds=async(_c:number,shop:string,orders)=>new Map(orders.map(o=>[o.orderId,{cents:shop==='MP0'?20000:0,source:shop==='MP0'?'refund' as const:'none' as const,details:[]} ]));
    const management=new LiveManagementService(ds,perShop);
    const channels=accounts.map((accountId,i)=>({accountId,storeIds:i===0?shops.slice(0,2):[shops[i+1]]}));
    const body={roomId:ids.s1,anchorId:anchor.id,controlId:control.id,operatorId:operator.id,douyinAccountId:accounts[0],storeId:shops[0],channels,startAt:'2026-07-04 10:00:00',endAt:'2026-07-04 13:00:00',salesCents:0,adSpendCents:0,reason:'多平台漏报补录',storeLines:shops.map((storeId,i)=>({storeId,platform:platforms[i],salesCents:amounts[i],adSpendCents:i===2?1000000:0,orderIds:['SAME']}))};
    await expect(management.manual(manager,{...body,channels:[{accountId:disabled,storeIds:[shops[0]]}]})).rejects.toThrow(/直播权限/);
    await expect(management.manual(foreign,body)).rejects.toThrow();
    await expect(management.manual(manager,{...body,storeLines:body.storeLines.slice(1)})).rejects.toThrow(/全部店铺/);
    await expect(management.manual(manager,{...body,channels:[channels[0],channels[0]]})).rejects.toThrow(/重复/);
    await expect(management.manual(manager,{...body,channels:[{accountId:accounts[1],storeIds:[shops[0]]}]})).rejects.toThrow(/同一平台/);
    const made=await management.manual(manager,body);
    await expect(management.manual(manager,{...body,startAt:'2026-07-03 10:00:00',endAt:'2026-07-03 13:00:00'})).rejects.toThrow(/订单已计入其他场次/);
    const detail=await sessions.detail(manager,made.id);
    expect(detail.channels).toHaveLength(3);expect(detail.reports[0].storeLines).toHaveLength(4);
    expect(detail.reports[0].orders).toHaveLength(4);
    await ds.query("UPDATE resource_records SET data=JSON_SET(data,'$.livePermission',false) WHERE company_id=? AND id IN (?,?,?)",[company,...accounts]);
    const submitted=await sessions.submit(manager,made.id),run=await flow.detail(reviewer,submitted.runId);
    const review={finalSource:'manual',finalReason:'逐店核定',storeLines:body.storeLines,wageHourlyRateCents:5000,controlWageHourlyRateCents:3000};
    const preview=await sessions.reviewPreview(manager,made.id,review);
    expect(preview.platforms).toHaveLength(3);expect(preview.wage.minutes).toBe(180);
    await flow.pass(reviewer,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:review});
    const approved=await sessions.detail(manager,made.id);
    expect(approved.commissions).toHaveLength(9);expect(approved.wages.map(w=>w.minutes)).toEqual([180,180]);
    for(const platform of ['douyin','kuaishou','channels']){
      const p=preview.platforms.find(p=>p.platform===platform)!;
      expect(approved.commissions.find(c=>c.platform===platform&&c.role==='anchor')?.amountCents).toBe(p.anchor.amountCents);
    }
    const settlementService=new LiveSettlementService(ds,flow,perShop);
    const settled=await settlementService.generate(manager,'',undefined,{from:'2026-07-04',to:'2026-07-04'});
    const payroll=await settlementService.detail(manager,settled.id);
    expect(payroll.lines).toHaveLength(9);expect(payroll.wageTotalCents).toBe(24000);
    expect(payroll.lines.reduce((n,l)=>n+l.wageCents,0)).toBe(24000);
    expect(payroll.lines.reduce((n,l)=>n+l.minutes,0)).toBe(360);
    expect(payroll.byPerson.every(p=>p.sessions===1)).toBe(true);
    expect(payroll.lines.filter(l=>l.platform==='kuaishou').every(l=>l.refundCents===0)).toBe(true);
    expect(payroll.refundTotalCents).toBe(20000);expect(payroll.refunds).toHaveLength(4);
    await settlementService.submit(manager,settled.id);
  });

  it('未绑定聚水潭也可开播；逐店说明后人工核定，工资和报表保留未核对标记',async()=>{
    clock('2026-06-15 12:05:00');
    const offline=new FakeSource();offline.unavailable='聚水潭授权过期';
    const service=new LiveSessionService(ds,flow,offline);
    const start=await service.start(manager,{roomId:ids.n1,anchorId:anchor.id,controlId:control.id,douyinAccountId:ids.account,storeId:ids.storeNoJst,channels:[{accountId:ids.account,storeIds:[ids.storeNoJst]}],productIds:[ids.p1],startAt:'2026-06-15 10:00:00'});
    const line={storeId:ids.storeNoJst,platform:'douyin',salesCents:100000,adSpendCents:10000,orderIds:[]};
    await expect(service.report(anchor,start.id,{endAt:'2026-06-15 12:00:00',salesCents:100000,storeLines:[line]})).rejects.toThrow(/人工核定原因/);
    await service.report(anchor,start.id,{endAt:'2026-06-15 12:00:00',salesCents:100000,storeLines:[{...line,reason:'未绑定聚水潭，按平台后台营业额填报'}]});
    await service.report(control,start.id,{endAt:'2026-06-15 12:00:00',salesCents:100000,storeLines:[{...line,reason:'中控核对平台后台'}]});
    const submitted=await service.submit(anchor,start.id),run=await flow.detail(reviewer,submitted.runId);
    await flow.pass(reviewer,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:{finalSource:'anchor'}});
    const payroll=new LiveSettlementService(ds,flow,offline);
    clock('2026-06-16 12:00:00');
    const generated=await payroll.generate(manager,'',undefined,{from:'2026-06-15',to:'2026-06-15'});
    const detail=await payroll.detail(manager,generated.id);
    expect(detail.lines.every(l=>l.unverifiedStores.length===1)).toBe(true);
    expect(detail.refunds).toHaveLength(0);expect(detail.wageTotalCents).toBe(16000);
  });

  it('排场保存产品快照、更新产品、导入同房间上次配置并隔离公司与权限', async () => {
    clock('2026-11-01 09:00:00');
    const first = await schedules.create(manager, input({date:'2026-11-01',productIds:[ids.p1,ids.p1,ids.p2]}));
    const rows = (await schedules.list(manager,{from:'2026-11-01',to:'2026-11-01'})).rows;
    expect(rows.find(r=>r.id===first.id)!.products).toEqual(expect.arrayContaining([expect.objectContaining({id:ids.p1,name:'毛巾'}),expect.objectContaining({id:ids.p2,name:'牙刷'})]));
    expect(rows.find(r=>r.id===first.id)!.products).toHaveLength(2);
    await schedules.update(manager,first.id,input({date:'2026-11-01',productIds:[ids.p2]}));
    const cancelled = await schedules.create(manager,input({date:'2026-11-01',startTime:'15:00',endTime:'16:00'}));
    await schedules.cancel(manager,cancelled.id,'取消不应导入');
    expect((await schedules.previous(manager,{roomId:ids.n1,date:'2026-11-01'}))!.id).toBe(first.id);
    expect((await schedules.previous(manager,{roomId:ids.n1,date:'2026-11-01',startTime:'09:00'}))?.date).not.toBe('2026-11-01');
    const template = await schedules.previous(manager,{roomId:ids.n1,date:'2026-11-02'});
    expect(template).toMatchObject({id:first.id,products:[{id:ids.p2,code:'SKU-B',name:'牙刷',spec:'软毛'}]});
    expect(await schedules.previous(manager,{roomId:ids.s1,date:'2026-01-01'})).toBeNull();
    await expect(schedules.previous(anchor,{roomId:ids.n1,date:'2026-11-02'})).rejects.toThrow(/权限/);
    await expect(schedules.previous(foreign,{roomId:ids.n1,date:'2026-11-02'})).rejects.toThrow(/不存在/);
    await expect(schedules.create(manager,input({date:'2026-11-02',productIds:[ids.account]}))).rejects.toThrow(/产品/);
    const foreignProduct = await rec(foreign.companyId,'finance-base-codes','FOREIGN',{name:'外公司产品'});
    await expect(schedules.create(manager,input({date:'2026-11-02',productIds:[foreignProduct]}))).rejects.toThrow(/产品/);
    await ds.query("UPDATE resource_records SET status='disabled' WHERE company_id=? AND id=?",[company,ids.p2]);
    await expect(schedules.create(manager,input({date:'2026-11-02',productIds:[ids.p2]}))).rejects.toThrow(/产品/);
    await ds.query("UPDATE resource_records SET status='normal' WHERE company_id=? AND id=?",[company,ids.p2]);
    // 已经在播仍保留下一场，产品来自该场快照而非房间产品文本。
    const next = await schedules.create(manager,input({date:'2026-11-01',startTime:'16:00',endTime:'18:00',productIds:[ids.p1]}));
    clock('2026-11-01 10:00:00');
    const live = await sessions.start(anchor,{scheduleId:first.id,...baseStart()});
    const overview = await schedules.overview(manager,'2026-11-01');
    const tile = overview.groups.north.find(r=>r.id===ids.n1)!;
    expect(tile.next).toMatchObject({id:next.id,controlName:'小中控',operatorName:'小运营',products:[expect.objectContaining({id:ids.p1})]});
    expect(tile.live!.products).toHaveLength(2);
    expect((await sessions.workbench(anchor)).schedules.find(s=>s.id===next.id)!.products).toHaveLength(1);
    await ds.query("UPDATE live_sessions SET status='pending_report',end_at='2026-11-01 11:00:00' WHERE company_id=? AND id=?",[company,live.id]);
  });

  it('传统运营中控只计中控提成，审核后调岗仍列在运营提成，同场运营独立计提', async () => {
    const day = '2026-05-06';
    const id = await liveThrough({ day, from:'10:00', to:'12:00', room:ids.s1, sales:100000, ad:0, orders:[order('CTRL-OPS',100000)] });
    const department = await ds.query("INSERT INTO departments(company_id,name,status) VALUES(?,'传统运营部','active')", [company]);
    await ds.query('UPDATE users SET department_id=? WHERE company_id=? AND id=?', [department.insertId,company,control.id]);
    try {
      expect((await sessions.detail(reviewer,id)).controlCommissionOnly).toBe(true);
      const form = reviewForm({controlWageHourlyRateCents: 6000});
      const preview = await sessions.reviewPreview(reviewer,id,form);
      expect(preview.controlWage).toBeNull();
      await approve(id,form);
      expect((await sessions.detail(manager,id)).wages.map(w=>w.role)).toEqual(['anchor']);
    } finally {
      await ds.query('UPDATE users SET department_id=NULL WHERE company_id=? AND id=?',[company,control.id]);
    }
    const period = {from:day,to:day};
    const ops = await ledger.commissions(manager,{...period,role:'operator'});
    expect(ops.rows.map(r=>r.userId).sort()).toEqual([control.id,operator.id].sort());
    expect(ops.rows.map(r=>r.liveMinutes)).toEqual([120,120]);
    expect(ops.rows.find(r=>r.userId===control.id)?.amountCents).toBe(liveComputeCommission({rules:LIVE_DEFAULT_RULES,finalSalesCents:100000,adSpendCents:0}).control.amountCents);
    expect((await ledger.commissions(manager,{...period,role:'control'})).rows).toEqual([]);
  });

  it('传统电商部门及有效下级、主兼任人员可选中控；目录、保存及本人上播一致，停用和跨公司不放行', async () => {
    const cid = (await ds.manager.save(Company, ds.manager.create(Company, { code: `tc${crypto.randomBytes(5).toString('hex')}`, name: '传统电商测试', status: 'active' }))).id;
    await ensureDefaultLiveRules(ds.manager, cid);
    const dept = async (name: string, parent: number | null = null, status = 'active', co = cid) => Number((await ds.query('INSERT INTO departments(company_id,name,parent_id,status) VALUES(?,?,?,?)', [co,name,parent,status])).insertId);
    const root = await dept('传统电商'), child = await dept('店铺运营组',root), off = await dept('停用组',root,'inactive');
    const offChild = await dept('停用组下级',off), other = await dept('其他部门'), similar = await dept('传统电商协作组');
    const foreignDept = await dept('传统电商',null,'active',foreign.companyId);
    const pos = async (name: string, departmentId: number, type = 'blank', status = 'active') => {
      const id = await position(cid,name,type); await ds.query('UPDATE positions SET department_id=?,status=? WHERE id=?',[departmentId,status,id]); return id;
    };
    const primaryPos = await pos('普通员工',child), offPos = await pos('停用岗位',root,'blank','inactive');
    const originalControl = await pos('现有中控',other,'live_control');
    const direct = await mkUser(cid,'tc-direct','部门直属人员',{departmentId:root});
    const primary = await mkUser(cid,'tc-primary','主岗位人员',{positionId:primaryPos});
    const extra = await mkUser(cid,'tc-extra','兼任人员',{departmentId:other,extraPositionIds:[primaryPos]});
    const duplicate = await mkUser(cid,'tc-existing','原中控人员',{departmentId:root,positionId:originalControl,extraPositionIds:[primaryPos]});
    const disabled = await mkUser(cid,'tc-disabled','停用人员',{departmentId:root,status:'disabled'});
    const badPosition = await mkUser(cid,'tc-off-pos','停用岗位人员',{departmentId:other,extraPositionIds:[offPos]});
    const offDepartment = await mkUser(cid,'tc-off-dept','停用部门人员',{departmentId:off});
    const offDescendant = await mkUser(cid,'tc-off-child','停用父部门下人员',{departmentId:offChild});
    const wrongDepartment = await mkUser(cid,'tc-similar','相似部门名称人员',{departmentId:similar});
    const foreignReference = await mkUser(cid,'tc-bad-ref','错误外公司部门引用',{departmentId:foreignDept});
    const foreignPerson = await mkUser(foreign.companyId,'tc-foreign','其他公司人员',{departmentId:foreignDept});
    const people = await livePeople(ds.manager,cid), expected = [direct,primary,extra,duplicate].sort((a,b)=>a-b);
    expect(people.controls.map(p=>p.id)).toEqual(expected);
    expect(people.anchors).toEqual([]);
    for (const id of [disabled,badPosition,offDepartment,offDescendant,wrongDepartment,foreignReference,foreignPerson]) expect(people.controls.some(p=>p.id===id)).toBe(false);
    const actor = au(extra,cid,'兼任人员',['features.live-desk.view']);
    expect(await loadLiveAccess(ds.manager,actor)).toMatchObject({isControl:true,isAnchor:false,canManage:false,canViewAll:false});
    await expect(schedules.options(au(extra,cid,'兼任人员'))).rejects.toThrow(/无权/);
    const managerActor = au(direct,cid,'排场管理员',['live.manage']);
    expect((await schedules.options(managerActor)).controls.map(p=>p.id)).toEqual(expected);
    const anchorPos = await pos('主播',other,'live_anchor');
    const anchorId = await mkUser(cid,'tc-anchor','主播',{positionId:anchorPos});
    const corridor = await rec(cid,'locations','西走廊办公室',{name:'西走廊办公室',locationType:'floor'});
    const room = await rec(cid,'locations','直播间-南1',{name:'直播间-南1',locationType:'room',parentId:corridor});
    const account = await rec(cid,'self-media','测试抖音号',{name:'测试抖音号',platform:'douyin',livePermission:true});
    const store = await rec(cid,'stores','测试店铺',{name:'测试店铺',platform:'douyin',jushuitanShopId:'TC1'});
    const product = await rec(cid,'finance-base-codes','TC-SKU',{name:'商品',spec:'一份'});
    clock('2026-11-01 09:00:00');
    await ds.query("UPDATE resource_records SET data=JSON_SET(data,'$.storeId',?) WHERE company_id=? AND id=?",[store,cid,account]);
    const body = {date:'2026-11-02',roomId:room,startTime:'10:00',endTime:'11:00',anchorId,controlId:primary,douyinAccountId:account,storeId:store};
    const schedule = await schedules.create(managerActor,body);
    await schedules.update(managerActor,schedule.id,{...body,controlId:extra});
    expect((await schedules.list(managerActor,{from:'2026-11-02',to:'2026-11-02'})).rows[0].control?.id).toBe(extra);
    const started = await sessions.start(actor,{roomId:room,anchorId,controlId:extra,douyinAccountId:account,storeId:store,productIds:[product]});
    expect((await sessions.detail(actor,started.id)).control?.id).toBe(extra);
    await ds.query("UPDATE departments SET status='inactive' WHERE id=?",[root]);
    expect((await livePeople(ds.manager,cid)).controls.map(p=>p.id)).toEqual([duplicate]); // 原live_control资格仍保留。
    expect((await loadLiveAccess(ds.manager,actor)).isControl).toBe(false);
    await expect(schedules.update(managerActor,schedule.id,{...body,controlId:primary})).rejects.toThrow(/不是中控岗位/);
  });

  it('手填排场产品新增/编辑/导入/上播/详情/全览完整回读，旧引用不丢失且不允许伪造关联', async () => {
    const cid = (await ds.manager.save(Company, ds.manager.create(Company,{code:`mp${crypto.randomBytes(5).toString('hex')}`,name:'手填产品测试',status:'active'}))).id;
    await ensureDefaultLiveRules(ds.manager,cid);
    const adminId = await mkUser(cid,'mp-admin','管理员',{isCompanyAdmin:true});
    const boss: AuthUser = {id:adminId,companyId:cid,name:'管理员',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    const pos = await position(cid,'主播','live_anchor'), anchorId = await mkUser(cid,'mp-anchor','主播',{positionId:pos});
    const actor = au(anchorId,cid,'主播',['features.live-desk.view']);
    const corridor = await rec(cid,'locations','西走廊办公室',{name:'西走廊办公室',locationType:'floor'});
    const room = await rec(cid,'locations','直播间-北1',{name:'直播间-北1',locationType:'room',parentId:corridor});
    const store = await rec(cid,'stores','测试店',{name:'测试店',platform:'douyin',jushuitanShopId:'MP1'});
    const account = await rec(cid,'self-media','测试号',{name:'测试号',platform:'douyin',livePermission:true,storeId:store});
    const legacy = await rec(cid,'finance-base-codes','MP-SKU',{name:'旧引用商品',spec:'大包'});
    clock('2026-12-01 09:00:00');
    const body = {date:'2026-12-01',roomId:room,startTime:'10:00',endTime:'11:00',anchorId,douyinAccountId:account,storeId:store};
    const entries = [{name:'  花育25 大包  '},{name:'甜玉米种子'},{productId:legacy}];
    const created = await schedules.create(boss,{...body,productEntries:entries});
    const first = (await schedules.list(boss,{from:body.date,to:body.date})).rows.find(r=>r.id===created.id)!;
    expect(first.products).toEqual([{id:null,code:'',name:'花育25 大包',spec:''},{id:null,code:'',name:'甜玉米种子',spec:''},{id:legacy,code:'MP-SKU',name:'旧引用商品',spec:'大包'}]);
    await schedules.update(boss,created.id,{...body,productEntries:[{name:'茄子苗'},{name:'甜玉米种子'},{productId:legacy}]});
    const previous = await schedules.previous(boss,{roomId:room,date:'2026-12-02'});
    expect(previous!.products.map(p=>p.name)).toEqual(['茄子苗','甜玉米种子','旧引用商品']);
    const foreignProduct = await rec(foreign.companyId,'finance-base-codes','MP-FOREIGN',{name:'外公司商品'});
    for (const invalid of [[{name:' '}],[{name:'x'.repeat(201)}],[{productId:0}],[{productId:legacy,name:'冒认名称'}],[{productId:foreignProduct}],[{name:'名称',code:'伪造编码'}],Array.from({length:101},()=>({name:'产品'}))]) {
      await expect(schedules.create(boss,{...body,date:'2026-12-02',productEntries:invalid} as never)).rejects.toThrow(/产品/);
    }
    await expect(schedules.create(boss,{...body,date:'2026-12-02',productIds:[legacy],productEntries:[{name:'歧义'}]})).rejects.toThrow(/两种格式/);
    clock('2026-12-01 10:00:00');
    const started = await sessions.start(actor,{scheduleId:created.id,productEntries:[{name:'茄子苗'},{name:'甜玉米种子'},{productId:legacy}]});
    const detail = await sessions.detail(actor,started.id);
    expect(detail.products).toEqual(previous!.products);
    const tile = (await schedules.overview(boss,body.date)).groups.north.find(r=>r.id===room)!;
    expect(tile.live!.products).toEqual(previous!.products);
    const [stored] = await ds.query('SELECT SUM(base_code_id IS NULL) manual_count,SUM(base_code_id=?) referenced_count FROM live_session_products WHERE company_id=? AND session_id=?',[legacy,cid,started.id]);
    expect(Number(stored.manual_count)).toBe(2); expect(Number(stored.referenced_count)).toBe(1);
    const qr=ds.createQueryRunner(); await qr.connect();
    try { await expect(new LiveManualProducts1766000000000().down(qr)).rejects.toThrow(/手填场次产品/); } finally { await qr.release(); }
    await expect(sessions.detail(foreign,started.id)).rejects.toThrow(/不存在/);
  });

  it('本场营业额真实公司鉴权、时间窗、退款归属与已结束场次回看', async () => {
    const startAt='2027-01-15 10:00:00', endAt='2027-01-15 11:00:00';
    const result=await ds.query(`INSERT INTO live_sessions(company_id,room_id,room_name,anchor_user_id,douyin_account_id,douyin_account_name,store_id,store_name,jst_shop_id,session_date,start_at,end_at,status,started_by,started_role) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'pending_report',?,'anchor')`,[company,ids.n1,'直播间-北1',anchor.id,ids.account,'抖音一号',ids.store,'抖音店','JST1','2027-01-15',startAt,endAt,anchor.id]);
    const id=Number(result.insertId),seen:string[][]=[];
    const turnover=new LiveTurnoverService(ds,{
      turnoverOrders:async()=>({available:true,truncated:false,reason:'',orders:[{...order('OLD',50000),orderTime:'2027-01-14 10:00:00'},{...order('NEW',12000),orderTime:'2027-01-15 10:30:00'}]}),
      refunds:async(_c:number,_shop:string,orders:Array<{orderId:string}>)=>{seen.push(orders.map(o=>o.orderId));return new Map([['NEW',{cents:2000,source:'refund',details:[]}],['OLD',{cents:50000,source:'refund',details:[]}]]);},
    } as unknown as LiveOrderSource);
    clock('2027-01-16 12:00:00');
    expect(await turnover.read(manager,id)).toMatchObject({sessionId:id,live:false,startAt,endAt,orderCount:1,turnoverCents:10000,refundCents:2000});
    expect(seen).toEqual([['NEW']]);
    await expect(turnover.read(stranger,id)).rejects.toThrow(/权限/);
    await expect(turnover.read(foreign,id)).rejects.toThrow(/不存在/);
    const tile=(await schedules.overview(manager,'2027-01-15')).groups.north.find(r=>r.id===ids.n1)!;
    expect(tile.current).toMatchObject({id,endAt,status:'pending_report'});
  });

  it('审核预检按公司隔离、草稿不放行；人事部门任一在职人员可办理，人员失效及时提示', async () => {
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `ready${crypto.randomBytes(4).toString('hex')}`, name: '审核预检', status: 'active' }));
    const dep = await ds.manager.save(Department, ds.manager.create(Department, { companyId: c.id, name: '人事综合部' }));
    const first = await mkUser(c.id, 'hr1', '人事一', { departmentId: dep.id });
    const second = await mkUser(c.id, 'hr2', '人事二', { departmentId: dep.id });
    const config = { ...admin, companyId: c.id, id: first };
    const employee = au(first, c.id, '人事一', ['features.live.view', 'live.manage']);
    expect(await sessions.submissionStatus(employee)).toMatchObject({ready:false, message:expect.stringContaining('未启用')});
    const review: StepDef = { ...step('review', '场次审核', 'approval'), assignee: { source: 'department', id: dep.id } };
    await flow.saveDraft(config, 'live-session-review', [step('apply','提交审核','submit'), review, step('end','结束','end')], []);
    expect((await sessions.submissionStatus(employee)).ready).toBe(false);
    await flow.publish(config, 'live-session-review');
    expect((await sessions.submissionStatus(employee)).ready).toBe(true);
    expect((await flow.resolveRecipients(ds.manager,c.id,review,first)).sort()).toEqual([first,second].sort());
    await ds.query("UPDATE users SET status='disabled' WHERE company_id=? AND id=?", [c.id,second]);
    expect(await flow.resolveRecipients(ds.manager,c.id,review,first)).toEqual([first]);
    await ds.query("UPDATE users SET status='disabled' WHERE company_id=? AND id=?", [c.id,first]);
    expect(await sessions.submissionStatus(config)).toMatchObject({ready:false,message:expect.stringContaining('没有在职员工')});
    expect((await sessions.submissionStatus(foreign)).ready).toBe(false);
    await expect(sessions.submissionStatus(stranger)).rejects.toThrow(/无权/);
  });

  it('扫码与工作台共享实际打卡：提前二次确认、中控核对、首报30分钟锁场、流程失败重试、运营依据及退款增量',async()=>{
    clock('2026-12-01 10:00:00');source.down=false;source.unavailable='';source.truncated=false;source.orders=[];source.refundMap.clear();
    const posA=await position(company,'扫码主播','live_anchor'),posC=await position(company,'扫码中控','live_control');
    const aa=au(await mkUser(company,'qr-anchor','扫码主播',{positionId:posA,payType:'hourly',hourlyRate:5000}),company,'扫码主播',['features.live-desk.view']);
    const cc=au(await mkUser(company,'qr-control','扫码中控',{positionId:posC,payType:'hourly',hourlyRate:3000}),company,'扫码中控',['features.live-desk.view']);
    const [oldRoom]=await ds.query('SELECT data FROM resource_records WHERE company_id=? AND id=?',[company,ids.n1]);
    const parent=(typeof oldRoom.data==='string'?JSON.parse(oldRoom.data):oldRoom.data).parentId;
    const room=await rec(company,'locations','直播间-扫码测试',{name:'直播间-扫码测试',locationType:'room',parentId:parent});
    const shop=await rec(company,'stores','扫码测试店',{name:'扫码测试店',platform:'douyin',jushuitanShopId:'QRSHOP'});
    const account=await rec(company,'self-media','扫码测试号',{name:'扫码测试号',platform:'douyin',livePermission:true,storeIds:[shop]});
    const plan=await schedules.create(manager,input({date:'2026-12-01',roomId:room,anchorId:aa.id,controlId:cc.id,douyinAccountId:account,storeId:shop,startTime:'14:00',endTime:'16:00'}));
    const fingerprint=(await sessions.workbench(aa)).schedules.find(r=>r.id===plan.id)!.fingerprint;
    const start={actualCheckin:true,scheduleId:plan.id,scheduleFingerprint:fingerprint,productIds:[ids.p1],channels:[{accountId:account,storeIds:[shop]}],startAt:'2026-12-01 01:00:00'};
    await expect(sessions.start(aa,start)).rejects.toThrow(/二次确认/);
    await expect(sessions.start(aa,{...start,scheduleFingerprint:'stale',confirmEarly:true})).rejects.toThrow(/排班已更新/);
    const made=await sessions.start(aa,{...start,confirmEarly:true});
    expect((await sessions.start(aa,{...start,confirmEarly:true})).id).toBe(made.id);
    expect((await sessions.detail(aa,made.id)).startAt).toBe('2026-12-01 10:00:00');
    await expect(sessions.start(foreign,{actualCheckin:true,sessionId:made.id,confirmDetails:true})).rejects.toThrow(/不存在/);
    const bareOps={...operator,permissions:{isCompanyAdmin:false,allow:[],deny:[]}};
    expect((await sessions.checkinContext(bareOps,room)).joinable.some(s=>s.canJoinOperator)).toBe(false);
    await expect(sessions.start(bareOps,{actualCheckin:true,role:'operator',sessionId:made.id,confirmDetails:true})).rejects.toThrow(/中控/);
    clock('2026-12-01 10:05:00');
    await expect(sessions.start(cc,{actualCheckin:true,sessionId:made.id})).rejects.toThrow(/核对/);
    await sessions.start(cc,{actualCheckin:true,sessionId:made.id,confirmDetails:true,channels:[{accountId:account,storeIds:[shop]}],productEntries:[{name:'中控核对后的产品'}]});
    expect((await sessions.detail(cc,made.id)).products[0].name).toBe('中控核对后的产品');
    expect((await sessions.checkinContext(bareOps,room)).joinable.find(s=>s.id===made.id)?.canJoinOperator).toBe(true);
    await sessions.start(bareOps,{actualCheckin:true,role:'operator',sessionId:made.id,confirmDetails:true});
    expect((await sessions.workbench(bareOps)).active.find(s=>s.id===made.id)?.myCheckin?.role).toBe('operator');
    await expect(sessions.start(bareOps,{actualCheckin:true,role:'control',sessionId:made.id,confirmDetails:true})).rejects.toThrow(/切换身份/);
    source.turnover=[{...order('QR1',10000),orderTime:'2026-12-01 10:10:00'},{...order('QR2',10000),orderTime:'2026-12-01 11:05:00'},{...order('BEFORE',99999),orderTime:'2026-12-01 09:59:59'}];
    source.refundMap.set('QR1',2000);
    clock('2026-12-01 11:00:00');
    const preview=await sessions.checkoutPreview(cc,made.id,'control');
    expect(preview.salesCents).toBe(8000);expect(preview.wage?.minutes).toBe(55);
    await sessions.report(cc,made.id,{role:'control',endAt:'2026-12-01 10:59:00',salesCents:999999,adSpendCents:0});
    expect((await sessions.detail(cc,made.id)).reportDeadline).toBe('2026-12-01 11:30:00');
    clock('2026-12-01 11:10:00');
    await sessions.report(aa,made.id,{role:'anchor',endAt:'2026-12-01 08:00:00',salesCents:999999});
    expect((await sessions.detail(aa,made.id)).endAt).toBe('2026-12-01 11:10:00');
    expect((await sessions.detail(aa,made.id)).reportDeadline).toBe('2026-12-01 11:30:00');
    await expect(sessions.submit(aa,made.id)).rejects.toThrow(/30分钟/);
    clock('2026-12-01 11:20:00');
    await sessions.report(operator,made.id,{role:'operator',endAt:'2026-12-01 11:10:00',salesCents:18000,storeLines:[{storeId:shop,platform:'douyin',salesCents:18000,adSpendCents:0,reason:'运营核实有效销售额'}]});
    expect((await sessions.workbench(bareOps)).active.find(s=>s.id===made.id)?.myCheckin?.endAt).toBe('2026-12-01 11:20:00');
    clock('2026-12-01 11:30:00');
    await expect(sessions.report(aa,made.id,{role:'anchor',endAt:'2026-12-01 11:30:00',salesCents:0})).rejects.toThrow(/锁定/);
    const autoFlow={start:jest.fn().mockRejectedValueOnce(new Error('模拟流程未发布')).mockImplementation((...args:Parameters<FlowService['start']>)=>flow.start(...args))};
    const closure=new LiveCheckinClosureService(ds,{me:async(id:number)=>({name:id===aa.id?aa.name:cc.name,permissions:aa.permissions})} as never,autoFlow as never,source);
    await closure.scan();expect((await sessions.detail(aa,made.id)).autoSubmitError).toContain('流程未发布');
    clock('2026-12-01 11:31:00');await closure.scan();await closure.scan();
    const ready=await sessions.detail(reviewer,made.id);expect(ready.status).toBe('submitted');expect(ready.reportsLocked).toBe(true);expect(ready.me.reportRoles).toEqual([]);
    expect(autoFlow.start).toHaveBeenCalledTimes(2);
    const saved=await ds.query('SELECT * FROM live_session_order_snapshots WHERE company_id=? AND session_id=?',[company,made.id]);expect(saved.map((r:Record<string,unknown>)=>r.order_id).sort()).toEqual(['QR1','QR2']);
    await expect(sessions.reviewPreview(reviewer,made.id,{finalSource:'anchor'})).rejects.toThrow(/运营/);
    await approve(made.id,{finalSource:'operator'});
    const final=await sessions.detail(manager,made.id);expect(final.finalSalesSource).toBe('operator');expect(final.wages.map(w=>[w.role,w.minutes])).toEqual(expect.arrayContaining([['anchor',70],['control',55]]));
    source.refundMap.set('QR1',5000);clock('2026-12-02 10:00:00');
    const payroll=await settlements.generate(manager,'2026-12',undefined,{from:'2026-12-01',to:'2026-12-01'});
    const detail=await settlements.detail(manager,payroll.id);expect(detail.refundTotalCents).toBe(3000);expect(detail.refunds.find(r=>r.orderId==='QR1')?.refundCents).toBe(5000);
    const anchorLine=detail.lines.find(l=>l.role==='anchor')!;
    expect(anchorLine.deductionCents).toBe(liveSettleLineFor({commissionCents:anchorLine.commissionCents,rateUnits:anchorLine.rateUnits,refundCents:3000}).deductionCents);
    source.refundMap.set('QR1',6000);await expect(settlements.submit(manager,payroll.id)).rejects.toThrow(/退款已变化/);
    source.down=true;await expect(settlements.generate(manager,'2026-12',undefined,{from:'2026-12-01',to:'2026-12-01'})).rejects.toThrow(/退款/);source.down=false;
    // No plan is required; only the anchor reports, while an assigned control never clocks in.
    clock('2026-12-02 15:00:00');source.turnover=[];
    const solo=await sessions.start(aa,{actualCheckin:true,roomId:room,anchorId:aa.id,controlId:cc.id,productIds:[ids.p1],channels:[{accountId:account,storeIds:[shop]}]});
    clock('2026-12-02 16:00:00');source.unavailable='模拟订单接口故障';
    await sessions.report(aa,solo.id,{role:'anchor',endAt:'2026-12-02 15:30:00',salesCents:0});
    expect((await sessions.detail(aa,solo.id)).ordersCaptureStatus).toBe('pending');
    clock('2026-12-02 16:30:00');await closure.scan();
    expect((await sessions.detail(reviewer,solo.id)).status).toBe('submitted');
    await expect(approve(solo.id,{finalSource:'anchor'})).rejects.toThrow(/订单尚未完整归集/);
    source.unavailable='';await closure.scan();
    expect((await sessions.detail(reviewer,solo.id)).ordersCaptureStatus).toBe('ready');
    await approve(solo.id,{finalSource:'anchor'});
    const soloFinal=await sessions.detail(manager,solo.id);expect(soloFinal.wages.map(w=>w.role)).toEqual(['anchor']);expect(soloFinal.commissions.map(c=>c.role)).toEqual(['anchor']);
    clock('2026-12-03 10:00:00');
    const disputed=await sessions.start(aa,{actualCheckin:true,roomId:room,anchorId:aa.id,productIds:[ids.p1],channels:[{accountId:account,storeIds:[shop]}]});
    source.turnover=[{...order('QR1',10000),orderTime:'2026-12-03 10:10:00'}];clock('2026-12-03 11:00:00');
    await sessions.report(aa,disputed.id,{role:'anchor',endAt:'2026-12-03 10:30:00',salesCents:0});
    const disputedDetail=await sessions.detail(aa,disputed.id);expect(disputedDetail.endAt).toBe('2026-12-03 11:00:00');expect(disputedDetail.ordersCaptureStatus).toBe('pending');expect(disputedDetail.ordersCaptureError).toContain('其他场次');expect(disputedDetail.reports[0].pending).toBe(true);
    clock('2026-12-04 10:00:00');
    const vacant=await sessions.start(aa,{actualCheckin:true,roomId:room,anchorId:aa.id,operatorId:operator.id,productIds:[ids.p1],channels:[{accountId:account,storeIds:[shop]}]});
    const context=await sessions.checkinContext(bareOps,room);expect(context.joinable.find(s=>s.id===vacant.id)).toMatchObject({canJoinControl:true,canJoinOperator:false});
    await sessions.start(bareOps,{actualCheckin:true,role:'control',sessionId:vacant.id,confirmDetails:true});
    expect((await sessions.workbench(bareOps)).active.find(s=>s.id===vacant.id)?.myCheckin?.role).toBe('control');
    expect((await sessions.detail(bareOps,vacant.id)).operator).toBeNull();
    const outsider=au(await mkUser(company,'op-outsider','另一运营',{positionId:await position(company,'运营入场测试','operations')}),company,'另一运营');
    expect((await sessions.checkinContext(outsider,room)).joinable.find(s=>s.id===vacant.id)?.canJoinOperator).toBe(true);
    await expect(sessions.start(foreign,{actualCheckin:true,role:'operator',sessionId:vacant.id,confirmDetails:true})).rejects.toThrow();
    await sessions.start(outsider,{actualCheckin:true,role:'operator',sessionId:vacant.id,confirmDetails:true});
    expect((await sessions.workbench(outsider)).active.find(s=>s.id===vacant.id)?.myCheckin?.role).toBe('operator');
    source.turnover=[];clock('2026-12-04 11:00:00');
    await sessions.report(bareOps,vacant.id,{role:'control',endAt:'2026-12-04 11:00:00',salesCents:0,adSpendCents:0});
    clock('2026-12-04 11:02:00');await sessions.report(aa,vacant.id,{role:'anchor',endAt:'2026-12-04 11:02:00',salesCents:0});
    await ds.manager.update(User,{id:operator.id,companyId:company},{extraPositionIds:[posA]});
    clock('2026-12-05 10:00:00');
    const dual=await sessions.start(bareOps,{actualCheckin:true,role:'control',roomId:room,anchorId:aa.id,productIds:[ids.p1],channels:[{accountId:account,storeIds:[shop]}]});
    expect((await sessions.workbench(bareOps)).active.find(s=>s.id===dual.id)?.myCheckin?.role).toBe('control');




  },30000);
  it('成功上播事务自动通知总经办，重复上播不重复通知；采用实际开播而非登记时间', async()=>{
    await ds.query("UPDATE live_sessions SET status='approved' WHERE company_id=? AND status='live'",[company]);
    const dept=await ds.manager.save(Department,ds.manager.create(Department,{companyId:company,name:'总经办',status:'active'}));
    const recipient=await mkUser(company,'start-alert-'+crypto.randomBytes(3).toString('hex'),'总经办收件人',{departmentId:dept.id});
    clock('2026-12-02 09:00:00');
    const sch=await schedules.create(manager,input({date:'2026-12-02',startTime:'10:00',endTime:'12:00'}));
    clock('2026-12-02 10:30:00');
    const started=await sessions.start(anchor,{scheduleId:sch.id,...baseStart({startAt:'2026-12-02 10:05:01'})});
    const rows=await ds.manager.find(Notification,{where:{companyId:company,userId:recipient,title:'开播时间异常：推迟超过5分钟'}});
    expect(rows).toHaveLength(1);expect(rows[0].body).toContain('5分1秒');expect(rows[0].body).toContain('实际开播：2026-12-02 10:05:01');
    await expect(sessions.start(anchor,{scheduleId:sch.id,...baseStart()})).rejects.toThrow('已上播');
    expect(await ds.query('SELECT * FROM live_notification_events WHERE company_id=? AND event_key=?',[company,`start-deviation:${started.id}`])).toHaveLength(1);
  });

});
