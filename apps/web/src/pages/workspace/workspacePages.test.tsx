import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChecker } from '@kudesi/shared';
import { flowApi } from '../flow/flowApi';
import { workspaceApi } from './workspaceApi';
import { HomePage } from './HomePage';
import { BossPage } from './BossPage';
import { DeskPage } from './DeskPage';
import { PersonalPage } from './PersonalPage';

vi.mock('./workspaceApi', () => ({ workspaceApi: { catalog: vi.fn(), desk: vi.fn(), tasks: vi.fn(), startTask: vi.fn(), submitTask: vi.fn(), reviewTask: vi.fn(), boss: vi.fn(), daily: vi.fn() } }));
vi.mock('../flow/flowApi', async (orig) => {
  const mod = await orig<typeof import('../flow/flowApi')>();
  return { ...mod, flowApi: { todos: vi.fn(), runs: vi.fn(), completeTask: vi.fn() } };
});
let allow: string[] = ['*'];
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: (p: string) => createChecker({ isCompanyAdmin: false, allow, deny: [] })(p), user: { name: '小王', positionName: '会计' } }) }));
const w = vi.mocked(workspaceApi);
const f = vi.mocked(flowApi);

const Where = () => <div data-testid="where">{useLocation().pathname}{useLocation().search}</div>;
const wrap = (ui: JSX.Element, url = '/') => render(<MemoryRouter initialEntries={[url]}><Routes><Route path="*" element={<>{ui}<Where /></>} /></Routes></MemoryRouter>);

const taskList = (rows: unknown[] = [], over: Record<string, unknown> = {}) => ({ view: 'new', page: 1, pageSize: 8, total: rows.length, counts: { new: rows.length, processing: 2, review: 1, done: 5, overdue: 0 }, rows, ...over });
const task = (o: Record<string, unknown> = {}) => ({ id: 1, title: '盘点库存', description: '按仓库盘', status: 'open', stage: 'new', dueAt: null, overdue: false, assigneeId: 2, assigneeName: '小王', creatorId: 3, creatorName: '主管', doneNote: null, reviewNote: null, startedAt: null, submittedAt: null, finishedAt: null, can: { start: true, complete: true, submit: true, review: false }, ...o });
const emptyFlow = () => { f.todos.mockResolvedValue({ total: 0, counts: { pending: 3, overdue: 1, returned: 0, cc: 0 }, rows: [] }); f.runs.mockResolvedValue({ total: 0, page: 1, pageSize: 8, rows: [] }); };

beforeEach(() => { window.localStorage.clear(); allow = ['*']; emptyFlow(); w.tasks.mockResolvedValue(taskList() as never); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('功能首页', () => {
  it('按权限列出功能，只含有权限的；自己不在列表里；搜索命中并可清除', async () => {
    allow = ['workbench.home.view', 'workbench.todos.view', 'finance.cost-table.view'];
    wrap(<HomePage />);
    expect(screen.getByText('我的待办')).toBeTruthy();
    expect(screen.getByText('成本表')).toBeTruthy();
    expect(screen.queryByText('流程配置')).toBeNull();
    expect(screen.getByLabelText('搜索功能').getAttribute('placeholder')).toContain('搜索 2 个功能');
    fireEvent.change(screen.getByLabelText('搜索功能'), { target: { value: '成本' } });
    expect(screen.getByRole('status').textContent).toContain('找到 1 个功能');
    expect(screen.queryByText('我的待办')).toBeNull();
    fireEvent.change(screen.getByLabelText('搜索功能'), { target: { value: '不存在的功能' } });
    expect(screen.getByText(/没有找到/)).toBeTruthy();
    fireEvent.click(screen.getByText('清除搜索'));
    expect(screen.getByText('我的待办')).toBeTruthy();
  });
  it('点开的功能进“最近使用”，并记在本机', () => {
    allow = ['workbench.todos.view', 'finance.cost-table.view'];
    wrap(<HomePage />);
    expect(screen.queryByLabelText('最近使用')).toBeNull();
    fireEvent.click(screen.getByText('成本表'));
    expect(screen.getByTestId('where').textContent).toBe('/finance/cost-table');
    expect(JSON.parse(window.localStorage.getItem('kudesi.features.recent')!)).toEqual(['/finance/cost-table']);
    cleanup();
    wrap(<HomePage />);
    expect(within(screen.getByLabelText('最近使用')).getByText('成本表')).toBeTruthy();
  });
  it('一个功能都没有时给出引导', () => {
    allow = [];
    wrap(<HomePage />);
    expect(screen.getByText('暂无可用功能')).toBeTruthy();
  });
});

describe('老板总控台', () => {
  const boss = (over: Record<string, unknown> = {}) => ({
    asOf: '2026-10-27T03:00:00Z', modules: { supervision: false, 'after-sales': false, live: false },
    attention: [
      { key: 'exceptions', label: '开放异常', value: null, hint: '暂无该模块', module: 'supervision' },
      { key: 'overdue-items', label: '已超时待办', value: 4, tone: 'bad', hint: '未完成 9 项', page: 'flow.overview' },
    ],
    today: { salesCents: 100000, profitCents: 35000, hasData: true },
    exceptions: { available: false, total: 0, rows: [] },
    people: [{ userId: 1, name: '小李', position: '运营', pending: 5, overdue: 2, exceptions: 0 }],
    stores: [{ storeId: 1, name: '一号店', platform: 'TB', salesCents: 100000, profitCents: 35000 }],
    trend: [{ date: '2026-10-27', salesCents: 100000, profitCents: 35000 }], ...over,
  });
  it('先显示需要处理的事；缺的模块标“暂无该模块”；超时数字可点去流程总览', async () => {
    w.boss.mockResolvedValue(boss() as never);
    wrap(<BossPage />);
    expect(await screen.findByText('已超时待办')).toBeTruthy();
    expect(screen.getAllByText('暂无该模块').length).toBeGreaterThan(0);
    expect(screen.getByText(/部分汇总还没有接入/)).toBeTruthy();
    expect(screen.getByText('小李')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('已超时待办4，点击查看'));
    expect(screen.getByTestId('where').textContent).toBe('/flow/overview');
  });
  it('没有成本权限时利润显示“—”并说明原因；今日没数据有提示；失败可重试', async () => {
    w.boss.mockRejectedValueOnce(new Error('x'));
    wrap(<BossPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    w.boss.mockResolvedValue(boss({ today: { salesCents: 0, profitCents: null, hasData: false }, stores: [{ storeId: 1, name: '一号店', platform: '', salesCents: 5, profitCents: null }] }) as never);
    fireEvent.click(screen.getByText('重试'));
    expect(await screen.findByText(/今日暂无店铺经营数据/)).toBeTruthy();
    expect(screen.getByText('没有查看成本的权限')).toBeTruthy();
    expect(screen.queryByText('利润')).toBeNull();
  });
});

describe('岗位工作台', () => {
  const pos = (o: Record<string, unknown>) => ({ id: 1, name: '会计', workspaceType: 'finance', level: 'staff', departmentId: 1, departmentPath: '总部 / 财务部', assigned: true, isPrimary: true, ...o });
  it('按部门分组选岗位；默认进主岗位；常用业务只显示有权限的页面；切换岗位重新取数', async () => {
    allow = ['workbench.desk.view', 'finance.cost-table.view', 'finance.history.view'];
    w.catalog.mockResolvedValue({ canBrowse: true, defaultPositionId: 1, positions: [pos({}), pos({ id: 2, name: '运营', workspaceType: 'operations', departmentPath: '总部', isPrimary: false, assigned: false })] } as never);
    w.desk.mockImplementation(async (id: number) => ({ position: pos({ id }), title: id === 1 ? '会计工作台' : '运营工作台', focus: '', pending: [], cards: [{ key: 'drafts', label: '草稿单据', value: 7 }] }) as never);
    wrap(<DeskPage />);
    expect(await screen.findByRole('heading', { name: '会计工作台' })).toBeTruthy();
    const links = within(screen.getByLabelText('岗位常用业务'));
    expect(links.getByText('成本表')).toBeTruthy();
    expect(links.queryByText('快递价格表')).toBeNull();
    expect(screen.getByText('草稿单据')).toBeTruthy();
    const select = screen.getByLabelText('选择岗位工作台') as HTMLSelectElement;
    expect(within(select).getAllByRole('group').map((g) => g.getAttribute('label'))).toEqual(['总部 / 财务部', '总部']);
    fireEvent.change(select, { target: { value: '2' } });
    expect(await screen.findByRole('heading', { name: '运营工作台' })).toBeTruthy();
    expect(w.desk).toHaveBeenCalledWith(2);
  });
  it('没有岗位时给引导；缺模块的卡片显示“—”', async () => {
    w.catalog.mockResolvedValue({ canBrowse: false, defaultPositionId: null, positions: [] } as never);
    wrap(<DeskPage />);
    expect(await screen.findByText('你还没有分配岗位')).toBeTruthy();
    cleanup();
    w.catalog.mockResolvedValue({ canBrowse: false, defaultPositionId: 5, positions: [pos({ id: 5, name: '客服', workspaceType: 'support' })] } as never);
    w.desk.mockResolvedValue({ position: pos({ id: 5 }), title: '客服工作台', focus: '', pending: ['采购到货汇总'], cards: [{ key: 'm', label: '售后', value: null, hint: '暂无该模块', module: 'after-sales' }] } as never);
    wrap(<DeskPage />);
    expect(await screen.findByText('暂无该模块')).toBeTruthy();
    expect(screen.getByText(/待接入业务：采购到货汇总/)).toBeTruthy();
    expect(screen.getByText('只显示你在岗的岗位')).toBeTruthy();
  });
});

describe('运营每日经营', () => {
  it('运营岗位显示每日经营：默认昨天、可切换日期、提示当天没数据的店铺；没有权限的人看不到', async () => {
    const pos = { id: 1, name: '运营', workspaceType: 'operations', level: 'staff', departmentId: 1, departmentPath: '运营部', assigned: true, isPrimary: true };
    w.catalog.mockResolvedValue({ canBrowse: false, defaultPositionId: 1, positions: [pos] } as never);
    w.desk.mockResolvedValue({ position: pos, title: '运营运营工作台', focus: '', pending: [], cards: [] } as never);
    w.daily.mockImplementation(async (date?: string) => ({ date: date ?? '', stores: [{ storeId: 1, name: '一号店', platform: 'TB', salesCents: 20000, adCostCents: 5000, profitCents: 10000, marginPpm: 50000000 }], totals: { salesCents: 20000, adCostCents: 5000, profitCents: 10000, marginPpm: 50000000 }, missing: [{ storeId: 2, name: '二号店' }] }) as never);
    wrap(<DeskPage />);
    const panel = within(await screen.findByLabelText('每日经营'));
    expect(await panel.findByText('一号店')).toBeTruthy();
    expect(panel.getAllByText('50.00%').length).toBeGreaterThan(0);
    fireEvent.click(panel.getByText('1 家店铺当天没有数据'));
    expect(panel.getByText(/二号店/)).toBeTruthy();
    const first = w.daily.mock.calls[0][0];
    fireEvent.click(panel.getByLabelText('前一天'));
    await waitFor(() => expect(w.daily.mock.calls.at(-1)![0]).not.toBe(first));
    cleanup();
    w.daily.mockClear();
    allow = ['workbench.desk.view'];
    wrap(<DeskPage />);
    await screen.findByRole('heading', { name: '运营运营工作台' });
    expect(screen.queryByLabelText('每日经营')).toBeNull();
    expect(w.daily).not.toHaveBeenCalled();
  });
});

describe('个人工作台与个人任务', () => {
  it('概览数字来自流程待办；四个分类都带数量；空状态有引导', async () => {
    wrap(<PersonalPage />);
    expect(await screen.findByText('暂无待我处理的事项，歇一会儿')).toBeTruthy();
    const tabs = within(screen.getByRole('tablist', { name: '个人任务分类' }));
    await waitFor(() => expect(tabs.getByRole('tab', { name: /进行中/ }).textContent).toContain('2'));
    expect(tabs.getByRole('tab', { name: /待我复核/ }).textContent).toContain('1');
    expect(tabs.getByRole('tab', { name: /已完成/ }).textContent).toContain('5');
    expect(screen.getByText('暂无新任务')).toBeTruthy();
    expect(screen.getByLabelText('今日待办概览').textContent).toContain('3');
  });
  it('新任务：开始处理 → 变成进行中；点分类按分类取数', async () => {
    w.tasks.mockImplementation(async ({ view }) => (view === 'new' ? taskList([task()]) : taskList([], { view })) as never);
    w.startTask.mockResolvedValue({ ok: true });
    wrap(<PersonalPage />);
    fireEvent.click(await screen.findByText('盘点库存'));
    const dlg = within(screen.getByRole('dialog', { name: '任务详情' }));
    expect(dlg.getByText('按仓库盘')).toBeTruthy();
    fireEvent.click(dlg.getByText('开始处理'));
    await waitFor(() => expect(w.startTask).toHaveBeenCalledWith(1));
    expect(await screen.findByText(/已开始处理/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /进行中/ }));
    await waitFor(() => expect(w.tasks).toHaveBeenCalledWith(expect.objectContaining({ view: 'processing' })));
  });
  it('提交复核带说明；待我复核里退回必须写原因，通过直接办', async () => {
    w.tasks.mockImplementation(async ({ view }) => (view === 'new' ? taskList([task()]) : view === 'review' ? taskList([task({ id: 9, title: '对账', stage: 'submitted', assigneeName: '小李', can: { start: false, complete: false, submit: false, review: true }, doneNote: '做完了' })], { view }) : taskList([], { view })) as never);
    w.submitTask.mockResolvedValue({ ok: true }); w.reviewTask.mockResolvedValue({ ok: true });
    wrap(<PersonalPage />);
    fireEvent.click(await screen.findByText('盘点库存'));
    fireEvent.click(screen.getByText('提交复核'));
    fireEvent.change(screen.getByLabelText(/处理说明/), { target: { value: '盘完了' } });
    fireEvent.click(screen.getByText('确认'));
    await waitFor(() => expect(w.submitTask).toHaveBeenCalledWith(1, '盘完了'));
    fireEvent.click(screen.getByRole('tab', { name: /待我复核/ }));
    fireEvent.click(await screen.findByText('对账'));
    expect(screen.getByText('做完了')).toBeTruthy();
    fireEvent.click(screen.getByText('退回'));
    fireEvent.click(screen.getByText('确认'));
    expect(screen.getByRole('alert').textContent).toContain('写明原因');
    expect(w.reviewTask).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/退回原因/), { target: { value: '少盘二楼' } });
    fireEvent.click(screen.getByText('确认'));
    await waitFor(() => expect(w.reviewTask).toHaveBeenCalledWith(9, false, '少盘二楼'));
  });
  it('流程列表：逾期行有“已超时”，点击去办理页；搜索走服务端', async () => {
    f.todos.mockResolvedValue({ total: 1, counts: { pending: 1, overdue: 1, returned: 0, cc: 0 }, rows: [{ id: 1, kind: 'flow', description: null, runId: 5, title: 't', stepName: '经理审批', enteredVia: 'normal', templateLabel: '费用申请', runTitle: '差旅费报销', requesterName: '张三', dueAt: new Date(Date.now() - 3_600_000).toISOString(), createdAt: '', finishedAt: null, overdue: true }] } as never);
    wrap(<PersonalPage />);
    fireEvent.click(await screen.findByText('差旅费报销'));
    expect(screen.getByTestId('where').textContent).toBe('/workbench/todos?run=5');
    fireEvent.change(screen.getByLabelText('搜索流程与待办'), { target: { value: '差旅' } });
    await waitFor(() => expect(f.todos).toHaveBeenCalledWith(expect.objectContaining({ keyword: '差旅' })));
  });
});
