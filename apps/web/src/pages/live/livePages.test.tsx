import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChecker } from '@kudesi/shared';
import { flowApi } from '../flow/flowApi';
import { liveApi } from './liveApi';
import { LiveDeskPage } from './LiveDeskPage';
import { LiveManagePage } from './LiveManagePage';

vi.mock('./liveApi', () => ({ liveApi: {
  options: vi.fn(), products: vi.fn(), overview: vi.fn(), roomDay: vi.fn(), schedules: vi.fn(), createSchedule: vi.fn(), updateSchedule: vi.fn(), cancelSchedule: vi.fn(), start: vi.fn(), sessions: vi.fn(), session: vi.fn(),
  candidates: vi.fn(), report: vi.fn(), submit: vi.fn(), reviewPreview: vi.fn(), workbench: vi.fn(), history: vi.fn(), commissions: vi.fn(), wages: vi.fn(), people: vi.fn(), rules: vi.fn(), createRule: vi.fn(), trial: vi.fn(),
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
  douyinAccounts: [{ ...person(20, '抖音一号'), detail: '' }], stores: [{ ...person(30, '抖音店'), detail: '', hasJstShop: true }, { ...person(31, '无绑定店'), detail: '', hasJstShop: false }],
});
const sched = (o: Record<string, unknown> = {}) => ({ id: 1, roomId: 10, roomName: '直播间-北1', date: '2026-09-28', start: '2026-09-28 10:00:00', end: '2026-09-28 14:00:00', startTime: '10:00', endTime: '14:00', status: 'scheduled', statusLabel: '未开始', anchor: person(3, '小主播'), control: person(4, '小中控'), operator: null, douyinAccount: person(20, '抖音一号'), store: null, sessionId: null, note: null, cancelReason: null, canStart: true, mineRole: 'anchor', ...o });
const session = (o: Record<string, unknown> = {}) => ({ id: 7, scheduleId: 1, roomId: 10, roomName: '直播间-北1', date: '2026-09-28', startAt: '2026-09-28 10:02:00', endAt: null, plannedEnd: null, status: 'live', statusLabel: '直播中', anchor: person(3, '小主播'), control: person(4, '小中控'), operator: null, douyinAccount: person(20, '抖音一号'), store: null, finalSalesCents: null, finalSalesSource: null, finalSalesReason: null, returnReason: null, flowRunId: null, submittedAt: null, approvedAt: null, approverName: null, revision: 1, ...o });
const detail = (o: Record<string, unknown> = {}) => ({ ...session(), products: [{ id: 1, code: 'SKU-A', name: '毛巾', spec: '' }], reports: [], commissions: [], wage: null, preview: null, me: { reportRoles: ['anchor'], canSubmit: false, isManager: false }, flow: null, ...o });
const bench = (o: Record<string, unknown> = {}) => ({ today: '2026-09-28', month: '2026-09', identity: { isAnchor: true, isControl: false, canManage: false }, active: [], schedules: [sched()], recent: [], monthCommissionCents: 12345, monthWageCents: 20000, monthWageMinutes: 240, ...o });

beforeEach(() => { window.localStorage.clear(); allow = ['features.live-desk.view']; l.options.mockResolvedValue(opts() as never); l.products.mockResolvedValue([{ id: 1, code: 'SKU-A', name: '毛巾', spec: '白' }, { id: 2, code: 'SKU-B', name: '牙刷', spec: '' }]); });
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

  it('按排场上播：必须选店铺和产品；店铺没绑聚水潭时拦住；提交带上所选', async () => {
    l.workbench.mockResolvedValue(bench() as never);
    l.start.mockResolvedValue({ id: 7 });
    l.session.mockResolvedValue(detail() as never);
    wrap(<LiveDeskPage />);
    fireEvent.click(await screen.findByRole('button', { name: '上播' }));
    const dlg = await screen.findByRole('dialog', { name: '报上播（按排场）' });
    fireEvent.click(within(dlg).getByRole('button', { name: '确认上播' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('抖音店铺');
    fireEvent.change(within(dlg).getByLabelText('抖音店铺'), { target: { value: '31' } });
    expect(within(dlg).getByText(/聚水潭店铺编号/)).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText('抖音店铺'), { target: { value: '30' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '确认上播' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('在卖产品');
    fireEvent.click(await within(dlg).findByLabelText(/SKU-A/));
    fireEvent.click(within(dlg).getByRole('button', { name: '确认上播' }));
    await waitFor(() => expect(l.start).toHaveBeenCalled());
    expect(l.start.mock.calls[0][0]).toMatchObject({ scheduleId: 1, douyinAccountId: 20, storeId: 30, productIds: [1] });
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
    expect(tabs).toEqual(['全览', '排场', '场次记录', '待审核', '提成记录', '主播工资', '提成规则']);
    cleanup();
    allow = ['features.live.view', 'live.commissions.view'];
    wrap(<LiveManagePage />);
    expect(await screen.findByRole('tab', { name: '提成结算' })).toBeTruthy();
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

  it('排场：只有管理权限能新增；后端的冲突提示原样显示；取消要写原因', async () => {
    allow = ['features.live.view', 'live.manage'];
    l.overview.mockResolvedValue(empty() as never);
    l.schedules.mockResolvedValue({ from: '', to: '', canManage: true, rows: [sched({ date: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) })] } as never);
    wrap(<LiveManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '排场' }));
    fireEvent.click(await screen.findByRole('button', { name: '新增排场' }));
    const dlg = await screen.findByRole('dialog', { name: '新增排场' });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('请填写');
    await within(dlg).findByRole('option', { name: '直播间-北1' });
    fireEvent.change(within(dlg).getByLabelText('直播间'), { target: { value: '10' } });
    fireEvent.change(within(dlg).getByLabelText('开始时间'), { target: { value: '10:00' } });
    fireEvent.change(within(dlg).getByLabelText('结束时间'), { target: { value: '12:00' } });
    fireEvent.change(within(dlg).getByLabelText('主播'), { target: { value: '3' } });
    fireEvent.change(within(dlg).getByLabelText('抖音号'), { target: { value: '20' } });
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
    fireEvent.click(await screen.findByRole('tab', { name: '提成记录' }));
    expect(await screen.findByText(/全部人员/)).toBeTruthy();
    expect(within(screen.getByLabelText('提成明细')).getByText('4%')).toBeTruthy();
    expect((screen.getByRole('button', { name: '导出 CSV' }) as HTMLButtonElement).disabled).toBe(false);
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
    fireEvent.click(await screen.findByRole('tab', { name: '提成结算' }));
    expect(((await screen.findByLabelText('结算月份')) as HTMLInputElement).value).toBe('2026-09');
    l.generateSettlement.mockRejectedValueOnce(new Error('聚水潭店铺 JST1 的退款暂时查不到，没有生成结算单'));
    fireEvent.click(screen.getByRole('button', { name: '生成 / 重新核对' }));
    expect((await screen.findByRole('alert')).textContent).toContain('暂时查不到');
    const head = { id: 5, month: '2026-09', status: 'draft', statusLabel: '待提交', recordCount: 1, commissionTotalCents: 4000, refundTotalCents: 30000, deductionTotalCents: 1200, payableTotalCents: 2800, refundsCheckedAt: '2026-10-05 10:00:00', note: '', returnReason: null, flowRunId: null, creatorName: '人事', submittedAt: null, approvedAt: null, revision: 1 };
    l.generateSettlement.mockResolvedValue({ id: 5 });
    l.settlement.mockResolvedValue({ ...head, canManage: true, byPerson: [{ userId: 3, name: '小主播', role: 'anchor', roleLabel: '主播', commissionCents: 4000, deductionCents: 1200, payableCents: 2800, sessions: 1 }], lines: [{ id: 1, sessionId: 7, userId: 3, userName: '小主播', role: 'anchor', roleLabel: '主播', date: '2026-09-28', roomName: '直播间-北1', startTime: '10:02', finalSalesCents: 100000, rateUnits: 400, commissionCents: 4000, orderCount: 1, ordersTotalCents: 60000, refundCents: 30000, deductionCents: 1200, payableCents: 2800 }], refunds: [{ sessionId: 7, orderId: 'A1', orderAmountCents: 60000, refundCents: 30000, source: 'refund', details: [], checkedAt: '' }] } as never);
    l.settlements.mockResolvedValue({ canManage: true, defaultMonth: '2026-09', rows: [head] as never });
    fireEvent.click(screen.getByRole('button', { name: '生成 / 重新核对' }));
    const dlg = await screen.findByRole('dialog', { name: '2026-09 直播提成月结' });
    expect(within(dlg).getByLabelText('退款依据').textContent).toContain('A1');
    expect(within(dlg).getByLabelText('结算明细').textContent).toContain('¥12.00');
    l.submitSettlement.mockResolvedValue({ runId: 1 });
    fireEvent.click(within(dlg).getByRole('button', { name: '提交审批' }));
    await waitFor(() => expect(l.submitSettlement).toHaveBeenCalledWith(5));
  });
});
