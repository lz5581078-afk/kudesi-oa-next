import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChecker } from '@kudesi/shared';
import { flowApi } from '../flow/flowApi';
import { liveApi } from './liveApi';
import { LiveDeskPage } from './LiveDeskPage';
import { LiveManagePage } from './LiveManagePage';

vi.mock('./LiveCheckinPanel',()=>({LiveCheckinPanel:()=>null}));
vi.mock('./liveApi', () => ({ liveApi: {
  checkinContext:vi.fn(),checkoutPreview:vi.fn(),turnover: vi.fn(), options: vi.fn(), products: vi.fn(), overview: vi.fn(), roomDay: vi.fn(), schedules: vi.fn(), createSchedule: vi.fn(), updateSchedule: vi.fn(), cancelSchedule: vi.fn(), start: vi.fn(), sessions: vi.fn(), session: vi.fn(),
  candidates: vi.fn(), report: vi.fn(), submit: vi.fn(), reviewPreview: vi.fn(), workbench: vi.fn(), history: vi.fn(), commissions: vi.fn(), wages: vi.fn(), people: vi.fn(), rules: vi.fn(), createRule: vi.fn(), trial: vi.fn(),
  checkinQr:vi.fn().mockResolvedValue({token:null,version:0}),generateCheckinQr:vi.fn(),roomSettings:vi.fn(),trialPerson:vi.fn(),manualReport:vi.fn(),updateRule:vi.fn(),
  integrationStatus: vi.fn(), submissionStatus: vi.fn(), commissionPreview: vi.fn(),
  settlements: vi.fn(), settlement: vi.fn(), generateSettlement: vi.fn(), submitSettlement: vi.fn(),
} }));
vi.mock('../flow/flowApi', async (orig) => ({ ...(await orig<typeof import('../flow/flowApi')>()), flowApi: { pass: vi.fn(), back: vi.fn(), reject: vi.fn() } }));
let allow: string[] = [];
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: (p: string) => createChecker({ isCompanyAdmin: false, allow, deny: [] })(p), user: { name: '小王' } }) }));
const l = vi.mocked(liveApi);
const f = vi.mocked(flowApi);

const person = (id: number, name: string) => ({ id, name });
const opts = () => ({
  rooms: [{ id: 10, name: '直播间-北1', shortName: '北1', big: false, path: '', side: 'north' as const, live: false }],
  anchors: [{ ...person(3, '小主播'), detail: '', live: false }], controls: [{ ...person(4, '小中控'), detail: '' }], operators: [{ ...person(5, '小运营'), detail: '' }],
  douyinAccounts: [{ ...person(20, '抖音一号'), detail: '',platform:'douyin',storeIds:[30,31] }], stores: [{ ...person(30, '抖音店'), detail: '',platform:'douyin', hasJstShop: true }, { ...person(31, '无绑定店'), detail: '',platform:'douyin', hasJstShop: false }],
});
const sched = (o: Record<string, unknown> = {}) => ({ id: 1, roomId: 10, roomName: '直播间-北1', date: '2026-09-28', start: '2026-09-28 10:00:00', end: '2026-09-28 14:00:00', startTime: '10:00', endTime: '14:00', status: 'scheduled', statusLabel: '未开始', anchor: person(3, '小主播'), control: person(4, '小中控'), operator: null, douyinAccount: person(20, '抖音一号'), store: null, sessionId: null, note: null, cancelReason: null, canStart: true, mineRole: 'anchor', ...o });
const session = (o: Record<string, unknown> = {}) => ({ id: 7, scheduleId: 1, roomId: 10, roomName: '直播间-北1', date: '2026-09-28', startAt: '2026-09-28 10:02:00', endAt: null, plannedEnd: null, status: 'live', statusLabel: '直播中', anchor: person(3, '小主播'), control: person(4, '小中控'), operator: null, douyinAccount: person(20, '抖音一号'), store: null, finalSalesCents: null, finalSalesSource: null, finalSalesReason: null, returnReason: null, flowRunId: null, submittedAt: null, approvedAt: null, approverName: null, revision: 1, ...o });
const detail = (o: Record<string, unknown> = {}) => ({ ...session(), products: [{ id: 1, code: 'SKU-A', name: '毛巾', spec: '' }], reports: [], commissions: [], wage: null, preview: null, me: { reportRoles: ['anchor'], canSubmit: false, isManager: false }, flow: null, ...o });
const bench = (o: Record<string, unknown> = {}) => ({ today: '2026-09-28', month: '2026-09', identity: { isAnchor: true, isControl: false, canManage: false }, active: [], schedules: [sched()], recent: [], monthCommissionCents: 12345, monthWageCents: 20000, monthWageMinutes: 240, commissionRows: [], wageRows: [], ...o });

beforeEach(() => { l.schedules.mockResolvedValue({rows:[],from:"",to:"",canManage:true}); l.sessions.mockResolvedValue({total:0,page:1,pageSize:8,rows:[]}); l.checkinContext.mockResolvedValue({...bench(),schedules:[],rooms:[]} as never); l.submissionStatus.mockResolvedValue({ready:true,message:'审核流程已就绪'}); l.turnover.mockResolvedValue({available:true,orderCount:0,turnoverCents:0,stores:[],queriedAt:'2026-09-28 12:00:00'} as never); window.localStorage.clear(); allow = ['features.live-desk.view']; l.wages.mockResolvedValue({month:'2026-09',scope:'all',totalCents:0,summary:[],rows:[]}); l.options.mockResolvedValue(opts() as never); l.integrationStatus.mockResolvedValue({ ready: true, code: 'ready', message: '' }); l.commissionPreview.mockResolvedValue(null); l.products.mockResolvedValue([{ id: 1, code: 'SKU-A', name: '毛巾', spec: '白' }, { id: 2, code: 'SKU-B', name: '牙刷', spec: '' }]); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const wrap = (ui: JSX.Element) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('我的直播', () => {
  it('显示本月提成和工资、本周排场；开始前 2 小时之外的排场不能上播', async () => {
    l.workbench.mockResolvedValue(bench({ schedules: [sched(), sched({ id: 2, canStart: false, startTime: '20:00', endTime: '23:00' })] }) as never);
    wrap(<LiveDeskPage />);
    expect(await screen.findByText('¥123.45')).toBeTruthy();
    expect(screen.getByText('¥200.00')).toBeTruthy();
    const week = screen.getByLabelText('本周排场');
    const buttons = within(week).getAllByRole('button', { name: '上播' });
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('按排场上播：选择关联店铺和产品，提交多平台账号结构', async () => {
    l.workbench.mockResolvedValue(bench() as never);
    l.start.mockResolvedValue({ id: 7 });
    l.session.mockResolvedValue(detail() as never);
    wrap(<LiveDeskPage />);
    fireEvent.click(await screen.findByRole('button', { name: '上播' }));
    const dlg = await screen.findByRole('dialog', { name: '报上播（按排场）' });
    fireEvent.click(within(dlg).getByRole('button', { name: '确认上播' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('关联店铺');
    fireEvent.click(await within(dlg).findByLabelText('抖音一号关联抖音店'));
    fireEvent.click(within(dlg).getByRole('button', { name: '确认上播' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('在卖产品');
    fireEvent.change(within(dlg).getByLabelText('场次产品 1'), { target: { value: '毛巾' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '确认上播' }));
    await waitFor(() => expect(l.start).toHaveBeenCalled());
    expect(l.start.mock.calls[0][0]).toMatchObject({ scheduleId: 1, douyinAccountId: 20, storeId: 30, productEntries: [{ name: '毛巾' }] });
  });

  it('报下播：聚水潭未接入时给原因；勾选订单后按分提交（销售额、投流、订单号）', async () => {
    l.workbench.mockResolvedValue(bench({ active: [session()] }) as never);
    l.session.mockResolvedValue(detail({ me: { reportRoles: ['control'], canSubmit: false, isManager: false } }) as never);
    l.candidates.mockResolvedValueOnce({ available: false, reason: '聚水潭订单查询还没有接入', orders: [], truncated: false, startAt: '', endAt: '' });
    wrap(<LiveDeskPage />);
    fireEvent.click(await screen.findByRole('button', { name: /报下播/ }));
    fireEvent.click(await screen.findByRole('button', { name: '报下播' }));
    const dlg = await screen.findByRole('dialog', { name: '报下播（中控）' });
    expect((await within(dlg).findByRole('status')).textContent).toContain('还没有接入');
    l.candidates.mockResolvedValueOnce({ available: true, reason: '', orders: [{ orderId: 'A1', innerId: '1', payTime: '2026-09-28 11:00:00', paid: true, amountCents: 60000, status: 'Confirmed', statusLabel: '已确认', cancelled: false }, { orderId: 'U1', innerId: '2', payTime: null, paid: false, amountCents: 100, status: 'WaitPay', statusLabel: '待付款', cancelled: false }], truncated: false, startAt: '', endAt: '' });
    fireEvent.click(within(dlg).getByRole('button', { name: '刷新订单' }));
    fireEvent.click(within(dlg).getByRole('button', { name: '提交下播' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('销售额');
    fireEvent.change(within(dlg).getByLabelText('销售额'), { target: { value: '600.5' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '提交下播' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('投流');
    fireEvent.change(within(dlg).getByLabelText('投流费用'), { target: { value: '50' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '提交下播' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('勾选');
    expect((await within(dlg).findByLabelText(/U1/) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(await within(dlg).findByLabelText(/A1/));
    expect(within(dlg).getByText(/已勾选 1 单，合计 ¥600.00/)).toBeTruthy();
    l.report.mockResolvedValue({ ok: true });
    fireEvent.click(within(dlg).getByRole('button', { name: '提交下播' }));
    await waitFor(() => expect(l.report).toHaveBeenCalled());
    expect(l.report.mock.calls[0][1]).toMatchObject({ role: 'control', salesCents: 60050, adSpendCents: 5000, orderIds: ['A1'] });
  });

  it('聚水潭未授权时顶部提示原因；报下播可一键勾选已付款，销售额跟随订单合计并显示预估提成', async () => {
    l.integrationStatus.mockResolvedValue({ ready: false, code: 'unauthorized', message: '公司还没有授权聚水潭，请管理员授权' });
    l.workbench.mockResolvedValue(bench({ active: [session()] }) as never);
    l.session.mockResolvedValue(detail({ me: { reportRoles: ['anchor'], canSubmit: false, isManager: false } }) as never);
    l.candidates.mockResolvedValue({ available: true, reason: '', orders: [{ orderId: 'A1', innerId: '1', payTime: '2026-09-28 11:00:00', paid: true, amountCents: 60000, status: 'Confirmed', statusLabel: '已确认', cancelled: false }, { orderId: 'A2', innerId: '2', payTime: '2026-09-28 11:10:00', paid: true, amountCents: 12345, status: 'Confirmed', statusLabel: '已确认', cancelled: false }, { orderId: 'U1', innerId: '3', payTime: null, paid: false, amountCents: 999, status: 'WaitPay', statusLabel: '待付款', cancelled: false }], truncated: false, startAt: '', endAt: '' } as never);
    l.commissionPreview.mockResolvedValue({ available: true, reason: '', basisSalesCents: 72345, anchor: { userId: 1, name: '小王', rateUnits: 300, amountCents: 2170 }, control: null, operator: null } as never);
    wrap(<LiveDeskPage />);
    expect((await screen.findAllByTestId('live-source-status'))[0].textContent).toContain('授权');
    fireEvent.click(await screen.findByRole('button', { name: /报下播/ }));
    fireEvent.click(await screen.findByRole('button', { name: '报下播' }));
    const dlg = await screen.findByRole('dialog', { name: '报下播（主播）' });
    fireEvent.click(await within(dlg).findByRole('button', { name: '勾选全部已付款' }));
    expect(within(dlg).getByText(/已勾选 2 单，合计 ¥723.45/)).toBeTruthy();
    expect((within(dlg).getByLabelText('销售额') as HTMLInputElement).value).toBe('723.45');
    await waitFor(() => expect(l.commissionPreview).toHaveBeenCalled());
    fireEvent.click(within(dlg).getByRole('button', { name: '清空' }));
    expect(within(dlg).getByText(/已勾选 0 单/)).toBeTruthy();
  });

  it('提交审核：待提交的场次可以提交，失败的原因显示出来', async () => {
    l.workbench.mockResolvedValue(bench({ active: [session({ status: 'pending_report', statusLabel: '待提交审核' })] }) as never);
    l.session.mockResolvedValue(detail({ status: 'pending_report', statusLabel: '待提交审核', me: { reportRoles: [], canSubmit: true, isManager: false } }) as never);
    l.submit.mockRejectedValueOnce(new Error('中控还没有报下播'));
    wrap(<LiveDeskPage />);
    fireEvent.click(await screen.findByRole('button', { name: /补报/ }));
    fireEvent.click(await screen.findByRole('button', { name: '提交审核' }));
    expect((await screen.findByRole('alert')).textContent).toContain('中控还没有报下播');
    l.submit.mockResolvedValue({ runId: 1 });
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
    await waitFor(() => expect(l.submit).toHaveBeenCalledTimes(2));
  });

  it('历史：按月汇总和分页入口', async () => {
    l.workbench.mockResolvedValue(bench() as never);
    const p = { sessions: 3, minutes: 600, commissionCents: 5000, wageCents: 8000, wageMinutes: 300 };
    l.history.mockResolvedValue({ mode: 'month', month: '2026-09', total: 1, page: 1, pageSize: 20, rows: [{ ...session({ status: 'approved', statusLabel: '已审核', endAt: '2026-09-28 14:00:00', finalSalesCents: 100000 }), myRoles: ['主播'], commissionCents: 5000, wageCents: 8000 }], summary: { all: p, thisMonth: p, lastMonth: p } } as never);
    wrap(<LiveDeskPage />);
    fireEvent.click(await screen.findByRole('tab', { name: '我的场次历史' }));
    expect(await screen.findByLabelText('累计')).toBeTruthy();
    expect(screen.getByText(/提成 ¥50.00 工资 ¥80.00/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('历史范围'), { target: { value: 'all' } });
    await waitFor(() => expect(l.history).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'all' })));
  });
});

describe('直播管理', () => {
  beforeEach(() => { allow = ['features.live.view']; });
  const empty = () => ({ date: '2026-09-28', now: '2026-09-28 09:00:00', groups: { north: [], south: [], none: [] }, corridorFound: false, totals: { rooms: 0, live: 0, scheduled: 0, pendingReview: 0 } });

  it('页签按权限显示；没有全员权限看不到结算；没有直播间时给引导', async () => {
    l.overview.mockResolvedValue(empty() as never);
    wrap(<LiveManagePage />);
    expect(await screen.findByText('还没有直播间')).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['全览', '排场', '场次记录', '待审核', '主播工资', '中控工资', '运营提成', '提成规则']);
    cleanup();
    allow = ['features.live.view', 'live.commissions.view'];
    wrap(<LiveManagePage />);
    expect(await screen.findByRole('tab', { name: '工资结算' })).toBeTruthy();
  });

  it('全览：南北两排、大房间、正在直播的信息；筛选只看正在直播', async () => {
    const tile = (id: number, name: string, side: string, status: string, big = false) => ({ id, name, shortName: name.slice(-2), big, path: '', side, status, statusLabel: status === 'live' ? '正在直播' : '未开播', next: null, timeline: [], live: status === 'live' ? { id: 1, startAt: '2026-09-28 08:00:00', plannedEnd: '2026-09-28 12:00:00', anchor: person(3, '小主播'), control: null, operator: null, douyinAccount: person(20, '抖音一号') } : null });
    l.overview.mockResolvedValue({ ...empty(), corridorFound: true, totals: { rooms: 3, live: 1, scheduled: 2, pendingReview: 4 }, groups: { north: [tile(1, '直播间-北1', 'north', 'live'), tile(2, '直播间-北2', 'north', 'idle', true)], south: [tile(3, '直播间-南1', 'south', 'idle')], none: [] } } as never);
    wrap(<LiveManagePage />);
    expect(await screen.findByLabelText('直播间-北1，正在直播')).toBeTruthy();
    expect(screen.getByLabelText('西走廊平面')).toBeTruthy();
    expect(screen.getByLabelText('统计').textContent).toContain('待审核场次4');
    fireEvent.click(screen.getByRole('button', { name: '正在直播' }));
    expect(screen.queryByLabelText('直播间-南1，未开播')).toBeNull();
    expect(screen.getByLabelText('直播间-北1，正在直播').textContent).toContain('小主播');
  });

  it('全览在正在直播时也显示下一场的时间、全部人员和场次产品', async () => {
    allow = ['features.live.view'];
    const next = {kind:'schedule',id:8,start:'2026-09-28 16:00:00',end:'2026-09-28 18:00:00',plannedEnd:'2026-09-28 18:00:00',anchorName:'下一场主播',controlName:'下一场中控',operatorName:'下一场运营',products:[{id:99,code:'HY25',name:'花育25',spec:'大包'}],state:'upcoming'};
    const tile = {id:10,name:'直播间-南1',shortName:'南1',side:'south',big:false,status:'live',statusLabel:'正在直播',timeline:[],next,live:{id:7,startAt:'2026-09-28 10:00:00',plannedEnd:'2026-09-28 14:00:00',anchor:person(3,'本场主播'),control:null,operator:null,douyinAccount:person(20,'抖音一号')}};
    l.overview.mockResolvedValue({...empty(),corridorFound:true,groups:{south:[tile],north:[],none:[]}} as never);
    wrap(<LiveManagePage />);
    const section = await screen.findByLabelText('南1下一场');
    expect(section.textContent).toContain('16:00–18:00');
    for(const text of ['下一场主播','下一场中控','下一场运营','花育25（大包）']) expect(section.textContent).toContain(text);
    expect(screen.getByText('本场主播')).toBeTruthy();
  });

  it('排场：只有管理权限能新增；后端的冲突提示原样显示；取消要写原因', async () => {
    allow = ['features.live.view', 'live.manage'];
    l.overview.mockResolvedValue(empty() as never);
    l.schedules.mockResolvedValue({ from: '', to: '', canManage: true, rows: [sched({ date: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) })] } as never);
    wrap(<LiveManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '排场' }));
    fireEvent.click(await screen.findAllByRole('button', { name: '新增排场' }).then(b=>b[0]));
    const dlg = await screen.findByRole('dialog', { name: '新增排场' });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('请填写');
    await within(dlg).findByRole('option', { name: '直播间-北1' });
    fireEvent.change(within(dlg).getByLabelText('直播间'), { target: { value: '10' } });
    fireEvent.change(within(dlg).getByLabelText('开始时间'), { target: { value: '10:00' } });
    fireEvent.change(within(dlg).getByLabelText('结束时间'), { target: { value: '12:00' } });
    fireEvent.change(within(dlg).getByLabelText('主播'), { target: { value: '3' } });
    fireEvent.click(within(dlg).getByLabelText('抖音一号'));
    fireEvent.click(within(dlg).getByLabelText('抖音一号关联抖音店'));
    l.createSchedule.mockRejectedValueOnce(new Error('该直播间 10:00–14:00 已有排场，时间段不能重叠'));
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('不能重叠');
    expect(l.createSchedule.mock.calls[0][0]).toMatchObject({ roomId: 10, startTime: '10:00', endTime: '12:00', anchorId: 3, controlId: null, douyinAccountId: 20 });
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    const cd = await screen.findByRole('dialog', { name: '取消排场' });
    fireEvent.click(within(cd).getByRole('button', { name: '确认取消' }));
    expect((await within(cd).findByRole('alert')).textContent).toContain('原因');
    l.cancelSchedule.mockResolvedValue({ ok: true });
    fireEvent.change(within(cd).getByLabelText('取消原因'), { target: { value: '主播请假' } });
    fireEvent.click(within(cd).getByRole('button', { name: '确认取消' }));
    await waitFor(() => expect(l.cancelSchedule).toHaveBeenCalledWith(1, '主播请假'));
  });

  it('待审核：审核人选来源后试算，通过时按分提交；退回要写原因；手填要原因', async () => {
    l.overview.mockResolvedValue(empty() as never);
    l.sessions.mockResolvedValue({ total: 1, page: 1, pageSize: 20, rows: [session({ status: 'submitted', statusLabel: '待审核', endAt: '2026-09-28 14:00:00' })] } as never);
    const run = { id: 99, revision: 3, title: '审核', status: 'running', activeStep: { id: 55, name: '场次审核' }, me: { canPass: true, canReturn: true, canReject: true, canCancel: false } };
    const rep = (role: string, label: string) => ({ role, roleLabel: label, reporter: person(role === 'anchor' ? 3 : 4, label), endAt: '2026-09-28 14:00:00', salesCents: 100000, adSpendCents: role === 'control' ? 5000 : null, ordersTotalCents: 98000, orderCount: 2, note: '', orders: [] });
    l.session.mockResolvedValue(detail({ status: 'submitted', statusLabel: '待审核', endAt: '2026-09-28 14:00:00', reports: [rep('anchor', '主播'), rep('control', '中控')], flow: run, me: { reportRoles: [], canSubmit: false, isManager: false } }) as never);
    l.reviewPreview.mockResolvedValue({ finalSource: 'anchor', finalSalesCents: 100000, adSpendCents: 5000, roiScaled: 200000, belowRoi: false, ruleVersion: { id: 1, effectiveFrom: '2026-01-01' }, anchor: { rateUnits: 400, amountCents: 4000 }, control: { rateUnits: 300, amountCents: 3000 }, operator: null, operatorUserId: null, operatorDoubledAsControl: false, wage: { startAt: '', endAt: '', minutes: 118, hourlyRateCents: 5000, amountCents: 9833, rateSource: 'archive', archiveHourlyRateCents: 5000 } });
    wrap(<LiveManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '待审核' }));
    fireEvent.click(await screen.findByRole('button', { name: '去审核' }));
    fireEvent.click(await screen.findByRole('button', { name: '审核' }));
    const dlg = await screen.findByRole('dialog', { name: '审核直播场次' });
    fireEvent.click(within(dlg).getByRole('button', { name: '审核通过' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('最终销售额');
    fireEvent.change(within(dlg).getByLabelText('最终销售额来源'), { target: { value: 'manual' } });
    fireEvent.change(within(dlg).getByLabelText('手填最终销售额'), { target: { value: '980' } });
    expect(await within(dlg).findByText('手填最终销售额必须写原因', { selector: '.notice.warn' })).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: '审核通过' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('必须写原因');
    expect(f.pass).not.toHaveBeenCalled();
    expect(l.reviewPreview).not.toHaveBeenCalled();
    fireEvent.change(within(dlg).getByLabelText('最终销售额来源'), { target: { value: 'anchor' } });
    await waitFor(() => expect(within(dlg).getByLabelText('审核试算').textContent).toContain('¥98.33'));
    expect(within(dlg).getByLabelText('审核试算').textContent).toContain('¥40.00');
    fireEvent.click(within(dlg).getByRole('button', { name: '退回修改' }));
    fireEvent.click(within(dlg).getByRole('button', { name: '确认退回' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('退回要写原因');
    fireEvent.click(within(dlg).getByRole('button', { name: '返回' }));
    fireEvent.change(within(dlg).getByLabelText('主播时薪'), { target: { value: '80' } });
    f.pass.mockResolvedValue({} as never);
    fireEvent.click(within(dlg).getByRole('button', { name: '审核通过' }));
    await waitFor(() => expect(f.pass).toHaveBeenCalled());
    expect(f.pass.mock.calls[0]).toEqual([99, { revision: 3, stepId: 55, form: { finalSource: 'anchor', wageHourlyRateCents: 8000 } }]);
  });

  it('提成记录：本人范围提示、汇总、导出可用；规则页新增版本带试算', async () => {
    allow = ['features.live.view', 'live.manage', 'live.commissions.view'];
    l.overview.mockResolvedValue(empty() as never);
    l.people.mockResolvedValue([person(3, '小主播')]);
    l.commissions.mockResolvedValue({ month: '2026-09', scope: 'all', totalCents: 4000, summary: [{ userId: 3, name: '小主播', role: 'anchor', roleLabel: '主播', sessions: 1, salesCents: 100000, amountCents: 4000 }], rows: [{ id: 1, sessionId: 7, userId: 3, userName: '小主播', role: 'anchor', roleLabel: '主播', date: '2026-09-28', roomName: '直播间-北1', startAt: '', douyinName: '', finalSalesCents: 100000, adSpendCents: 5000, roiScaled: 200000, belowRoi: false, rateUnits: 400, amountCents: 4000, ruleVersionId: 1 }] } as never);
    wrap(<LiveManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '主播工资' }));
    expect(await screen.findByText(/全部人员/,{selector:'p'})).toBeTruthy();
    expect(screen.getByLabelText('工资提成明细').textContent).toContain('4%');
    expect((screen.getByRole('button', { name: '导出明细' }) as HTMLButtonElement).disabled).toBe(false);
    const form = { boundary: 'min_inclusive', roiThreshold: '2', belowRoiAnchorDeduct: '1', belowRoiControlDeduct: '1', operatorRate: '0.5', tiers: [{ min: '0', max: '', anchorRate: '4', controlRate: '3' }] };
    l.rules.mockResolvedValue({ canManage: true, currentId: 1, versions: [{ id: 1, effectiveFrom: '2026-01-01', note: null, createdAt: '2026-01-01 00:00:00', creatorName: null, usedCount: 2, form }] });
    l.trial.mockResolvedValue({ tierIndex: 0, roiScaled: 200000, belowRoi: false, anchor: { rateUnits: 400, amountCents: 4000 }, control: { rateUnits: 300, amountCents: 3000 }, operator: { rateUnits: 50, amountCents: 500 } });
    fireEvent.click(screen.getByRole('tab', { name: '提成规则' }));
    expect(await screen.findByText('当前生效')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '新增规则版本' }));
    const dlg = await screen.findByRole('dialog', { name: '新增规则版本' });
    fireEvent.change(within(dlg).getByLabelText('试算销售额'), { target: { value: '1000' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '试算' }));
    await waitFor(() => expect(l.trial).toHaveBeenCalledWith({ rules: form, sales: '1000', adSpend: '' }));
    expect(await within(dlg).findByText('¥40.00')).toBeTruthy();
    l.createRule.mockRejectedValueOnce(new Error('这个生效日期已经有一个规则版本'));
    fireEvent.click(within(dlg).getByRole('button', { name: '保存为新版本' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('已经有一个规则版本');
  });

  it('提成结算：生成后查看明细；失败原因显示；只有已核对的才能提交审批', async () => {
    allow = ['features.live.view', 'live.manage', 'live.commissions.view'];
    l.overview.mockResolvedValue(empty() as never);
    l.settlements.mockResolvedValue({ canManage: true, defaultMonth: '2026-09', rows: [] });
    wrap(<LiveManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '工资结算' }));
    expect(((await screen.findByLabelText('结算月份')) as HTMLInputElement).value).toBe('2026-09');
    l.generateSettlement.mockRejectedValueOnce(new Error('聚水潭店铺 JST1 的退款暂时查不到，没有生成结算单'));
    fireEvent.click(screen.getByRole('button', { name: '生成 / 重新核对' }));
    expect((await screen.findByRole('alert')).textContent).toContain('暂时查不到');
    const head = { id: 5, month: '2026-09', status: 'draft', statusLabel: '待提交', recordCount: 1, commissionTotalCents: 4000, refundTotalCents: 30000, deductionTotalCents: 1200, payableTotalCents: 2800, refundsCheckedAt: '2026-10-05 10:00:00', note: '', returnReason: null, flowRunId: null, creatorName: '人事', submittedAt: null, approvedAt: null, revision: 1 };
    l.generateSettlement.mockResolvedValue({ id: 5 });
    l.settlement.mockResolvedValue({ ...head, canManage: true, byPerson: [{ userId: 3, name: '小主播', role: 'anchor', roleLabel: '主播', commissionCents: 4000, deductionCents: 1200, payableCents: 2800, sessions: 1 }], lines: [{ id: 1, sessionId: 7, userId: 3, userName: '小主播', role: 'anchor', roleLabel: '主播', date: '2026-09-28', roomName: '直播间-北1', startTime: '10:02', finalSalesCents: 100000, rateUnits: 400, commissionCents: 4000, orderCount: 1, ordersTotalCents: 60000, refundCents: 30000, deductionCents: 1200, payableCents: 2800 }], refunds: [{ sessionId: 7, orderId: 'A1', orderAmountCents: 60000, refundCents: 30000, source: 'refund', details: [], checkedAt: '' }] } as never);
    l.settlements.mockResolvedValue({ canManage: true, defaultMonth: '2026-09', rows: [head] as never });
    fireEvent.click(screen.getByRole('button', { name: '生成 / 重新核对' }));
    const dlg = await screen.findByRole('dialog', { name: '2026-09 至 2026-09 工资结算' });
    expect(within(dlg).getByLabelText('退款依据').textContent).toContain('A1');
    expect(within(dlg).getByLabelText('结算明细').textContent).toContain('¥12.00');
    l.submitSettlement.mockResolvedValue({ runId: 1 });
    fireEvent.click(within(dlg).getByRole('button', { name: '提交审批' }));
    await waitFor(() => expect(l.submitSettlement).toHaveBeenCalledWith(5));
  });
  it('排场列出所有空房间，按房间新增会带出当前日期与房间，支持新试播主播',async()=>{
    allow=['features.live.view','live.manage'];l.overview.mockResolvedValue(empty() as never);
    const o=opts();l.schedules.mockResolvedValue({from:'',to:'',rows:[],rooms:[...o.rooms,{...o.rooms[0],id:11,name:'直播间-南1',shortName:'南1',side:'south'}],canManage:true} as never);
    wrap(<LiveManagePage/>);fireEvent.click(await screen.findByRole('tab',{name:'排场'}));
    const room=await screen.findByRole('region',{name:'直播间-南1'});
    expect(within(room).getByText('当天暂无排场')).toBeTruthy();
    fireEvent.click(within(room).getByRole('button',{name:'新增排场'}));
    const dialog=await screen.findByRole('dialog',{name:'新增排场'});
    // 下拉选项包含真实服务端房间清单。
    l.options.mockResolvedValue({...o,rooms:[...o.rooms,{...o.rooms[0],id:11,name:'直播间-南1',shortName:'南1',side:'south'}]} as never);
    fireEvent.click(within(dialog).getByRole('button',{name:/新增试播主播/}));
    const trial=await screen.findByRole('dialog',{name:'新增试播主播'});
    l.trialPerson.mockResolvedValue({id:88,name:'试播乙'});
    l.options.mockResolvedValue({...o,anchors:[...o.anchors,{id:88,name:'试播乙',detail:'试播主播',trial:true}]} as never);
    fireEvent.change(within(trial).getByLabelText('试播姓名'),{target:{value:'试播乙'}});
    fireEvent.change(within(trial).getByLabelText('试播时薪'),{target:{value:'65'}});
    fireEvent.click(within(trial).getByRole('button',{name:'保存并选择'}));
    await waitFor(()=>expect(l.trialPerson).toHaveBeenCalledWith({name:'试播乙',hourlyRateCents:6500}));
    await waitFor(()=>expect((within(dialog).getByLabelText('主播') as HTMLSelectElement).value).toBe('88'));
  });

  it('全览南在上北在下，显示彩色状态、直播进度与可编辑房间资料',async()=>{
    allow=['features.live.view','live.manage'];
    const tile=(id:number,side:string)=>({id,name:`直播间-${side==='south'?'南':'北'}1`,shortName:side==='south'?'南1':'北1',side,big:false,path:'',status:'live',statusLabel:'正在直播',ownerId:5,ownerName:'小运营',products:'毛巾',live:{id:7,startAt:'2026-09-28 10:00:00',plannedEnd:'2026-09-28 14:00:00',anchor:person(3,'小主播'),control:person(4,'小中控'),operator:null,douyinAccount:person(20,'抖音一号')},next:null,timeline:[]});
    l.overview.mockResolvedValue({...empty(),now:'2026-09-28 12:00:00',corridorFound:true,groups:{south:[tile(11,'south')],north:[tile(10,'north')],none:[]}} as never);
    l.people.mockResolvedValue([person(5,'小运营')]);l.roomSettings.mockResolvedValue({ok:true});
    wrap(<LiveManagePage/>);
    const south=await screen.findByLabelText('南侧直播间'),north=screen.getByLabelText('北侧直播间');
    expect(!!(south.compareDocumentPosition(north)&Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(within(south).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    expect(south.textContent).toContain('小中控');expect(south.textContent).toContain('毛巾');
    fireEvent.click(within(south).getByRole('button',{name:'编辑房间'}));
    const dlg=await screen.findByRole('dialog',{name:'直播间-南1 · 房间设置'});
    expect(within(dlg).getByLabelText('房间管理员')).toBeTruthy();
    expect(within(dlg).queryByRole('img',{name:/二维码/})).toBeNull();
    expect(south.textContent).toContain('房间管理员');
    fireEvent.change(within(dlg).getByLabelText('房间产品 1'),{target:{value:'牙刷'}});
    fireEvent.click(within(dlg).getByRole('button',{name:'＋ 添加产品'}));
    fireEvent.change(within(dlg).getByLabelText('房间产品 2'),{target:{value:'花育25'}});
    fireEvent.click(within(dlg).getByRole('button',{name:'＋ 添加产品'}));
    fireEvent.click(within(dlg).getByRole('button',{name:'删除房间产品 3'}));
    fireEvent.click(within(dlg).getByRole('button',{name:'保存房间信息'}));
    await waitFor(()=>expect(l.roomSettings).toHaveBeenCalledWith(11,{ownerId:5,products:'牙刷\n花育25'}));
    const tabs=screen.getAllByRole('tab');
    expect(tabs[tabs.length-1].textContent).toBe('上下播二维码');
    expect(tabs[tabs.length-2].textContent).toBe('通知设置');
    expect(screen.queryByRole('button',{name:'上下播二维码'})).toBeNull();
    fireEvent.click(screen.getByRole('tab',{name:'上下播二维码'}));
    expect(await screen.findByText('所有直播间共用此码，上播、下播通用。长期有效，重新生成后旧码立即失效。')).toBeTruthy();
    expect(screen.getByRole('tab',{name:'上下播二维码'}).getAttribute('aria-selected')).toBe('true');
    expect(window.localStorage.getItem('kudesi.live.tab')).toBe('qr');
  });

  it('人事补报按分提交并保留原因；区间工资结算提交起止日期',async()=>{
    allow=['features.live.view','live.manage','live.commissions.view'];l.overview.mockResolvedValue(empty() as never);
    l.session.mockResolvedValue(detail({id:91}) as never);l.manualReport.mockResolvedValue({id:91});wrap(<LiveManagePage/>);
    fireEvent.click(await screen.findByRole('tab',{name:'人事补报'}));
    fireEvent.click(await screen.findByRole('button',{name:'新建补报'}));
    await screen.findByLabelText('抖音一号');
    fireEvent.click(screen.getByLabelText('抖音一号'));fireEvent.click(screen.getByLabelText('抖音一号关联抖音店'));
    for(const [label,value]of [['直播间','10'],['主播','3'],['抖音店营业额','123.45'],['补报原因','漏报补录']] as const)fireEvent.change(screen.getByLabelText(label),{target:{value}});
    fireEvent.click(screen.getByRole('button',{name:'保存并核对'}));
    await waitFor(()=>expect(l.manualReport).toHaveBeenCalledWith(expect.objectContaining({salesCents:12345,reason:'漏报补录',roomId:10,anchorId:3})));
    fireEvent.click(await screen.findByRole('button',{name:'关闭详情'}));
    l.settlements.mockResolvedValue({canManage:true,defaultMonth:'2026-09',rows:[]});l.generateSettlement.mockRejectedValue(new Error('日期范围重叠'));
    fireEvent.click(screen.getByRole('tab',{name:'工资结算'}));
    fireEvent.change(await screen.findByLabelText('结算方式'),{target:{value:'range'}});
    fireEvent.change(screen.getByLabelText('结算开始日期'),{target:{value:'2026-09-01'}});fireEvent.change(screen.getByLabelText('结算结束日期'),{target:{value:'2026-09-15'}});
    fireEvent.click(screen.getByRole('button',{name:'生成 / 重新核对'}));
    await waitFor(()=>expect(l.generateSettlement).toHaveBeenCalledWith('2026-09',undefined,{from:'2026-09-01',to:'2026-09-15'}));
    expect((await screen.findByRole('alert')).textContent).toContain('重叠');
  });

  it('填报前提示流程不可用，保存校验错误留在底部并获得焦点',async()=>{
    allow=['features.live.view','live.manage','flow.templates.view','flow.templates.manage'];
    l.overview.mockResolvedValue(empty() as never);
    l.submissionStatus.mockResolvedValue({ready:false,message:'审核流程尚未启用'});
    wrap(<LiveManagePage/>);
    fireEvent.click(await screen.findByRole('tab',{name:'人事补报'}));
    fireEvent.click(await screen.findByRole('button',{name:'新建补报'}));
    expect(await screen.findByText(/审核流程尚未启用/)).toBeTruthy();
    expect(screen.getByRole('link',{name:'配置直播场次审核'}).getAttribute('href')).toBe('/flow/templates?flow=live-session-review');
    fireEvent.click(screen.getByRole('button',{name:'保存并核对'}));
    const alert=await screen.findByRole('alert');
    expect(alert.textContent).toContain('请完整填写');
    expect(alert.closest('.live-manual-feedback')).toBe(document.activeElement);
    expect(l.manualReport).not.toHaveBeenCalled();
  });

  it('详情提前拦截未就绪审核，可重新检查后提交，成功结果明确可见',async()=>{
    allow=['features.live.view','live.manage'];l.overview.mockResolvedValue(empty() as never);
    l.sessions.mockResolvedValue({total:1,page:1,pageSize:20,rows:[session({status:'pending_report'})]} as never);
    const pending={status:'pending_report',me:{reportRoles:[],canSubmit:true,isManager:true}};
    l.session.mockResolvedValue(detail({...pending,submission:{ready:false,message:'审核流程尚未启用'}}) as never);
    wrap(<LiveManagePage/>);fireEvent.click(await screen.findByRole('tab',{name:'场次记录'}));
    fireEvent.click(await screen.findByRole('button',{name:'详情'}));
    const dlg=await screen.findByRole('dialog',{name:'直播场次'});
    expect((await within(dlg).findByRole('button',{name:'提交审核'}) as HTMLButtonElement).disabled).toBe(true);
    l.session.mockResolvedValue(detail({...pending,submission:{ready:true,message:'审核流程已就绪'}}) as never);
    fireEvent.click(within(dlg).getByRole('button',{name:'重新检查'}));
    await waitFor(()=>expect((within(dlg).getByRole('button',{name:'提交审核'}) as HTMLButtonElement).disabled).toBe(false));
    l.submit.mockResolvedValue({runId:99});
    l.session.mockResolvedValue(detail({status:'submitted',me:{reportRoles:[],canSubmit:false,isManager:true}}) as never);
    fireEvent.click(within(dlg).getByRole('button',{name:'提交审核'}));
    expect(await within(dlg).findByText('已提交审核，请等待审核人处理。')).toBeTruthy();
    expect(within(dlg).queryByRole('button',{name:'提交审核'})).toBeNull();
  });

});
