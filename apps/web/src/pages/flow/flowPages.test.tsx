import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flowApi } from './flowApi';
import { MyTodosPage } from './TodosPage';
import { RunsPage } from './RunsPage';
import { ApplyPage } from './ApplyPage';
import { RunDetail } from './RunDetail';
import { TasksPage } from './TasksPage';

vi.mock('./flowApi', async (orig) => {
  const mod = await orig<typeof import('./flowApi')>();
  return { ...mod, flowApi: { todos: vi.fn(), runs: vi.fn(), templates: vi.fn(), run: vi.fn(), start: vi.fn(), assigned: vi.fn(), cancelTask: vi.fn(), createTask: vi.fn(), completeTask: vi.fn(), routines: vi.fn() } };
});
vi.mock('../org/orgApi', async (orig) => ({ ...(await orig<typeof import('../org/orgApi')>()), orgApi: { departments: vi.fn().mockResolvedValue([{ id: 4, name: '运营部', children: [{ id: 5, name: '直播组', children: [] }] }]) } }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../../resources/RecordForm', async (orig) => ({ ...(await orig<typeof import('../../resources/RecordForm')>()), loadRefOptions: vi.fn().mockResolvedValue([{ value: 7, label: '小李' }]) }));
const f = vi.mocked(flowApi);

const todo = (over: Record<string, unknown> = {}) => ({ id: 1, kind: 'flow', description: null, runId: 5, title: 't', stepName: '经理审批', enteredVia: 'normal', templateLabel: '费用申请', runTitle: '差旅费报销', requesterName: '张三', dueAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), createdAt: '', finishedAt: null, overdue: true, ...over });
const todoList = (rows = [todo()]) => ({ total: rows.length, counts: { pending: rows.length, overdue: 1, returned: 0, cc: 2 }, rows });
const runRow = (over: Record<string, unknown> = {}) => ({ id: 5, templateKey: 'expense', templateLabel: '费用申请', title: '差旅费报销', status: 'running', requesterName: '张三', stepName: '经理审批', handlers: ['李四'], dueAt: null, createdAt: '2026-01-01T00:00:00Z', finishedAt: null, overdue: false, stepEnteredAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), ...over });
const runDetail = (over: Record<string, unknown> = {}) => ({
  id: 5, templateKey: 'expense', templateLabel: '费用申请', title: '差旅费报销', status: 'running', revision: 1, requesterId: 1, requesterName: '张三', createdAt: '2026-01-01T00:00:00Z', finishedAt: null, dueAt: null,
  payload: {}, refLabels: {}, fields: [], stepFields: {}, activeStep: { id: 12, key: 'mgr', name: '经理审批', type: 'approval', enteredVia: 'normal', dueAt: null, recipients: [{ id: 2, name: '李四' }] },
  steps: [
    { id: 11, seq: 1, key: 'submit', name: '发起', type: 'submit', status: 'done', action: 'submit', comment: null, form: null, formRefLabels: {}, enteredVia: 'normal', enteredAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z', dueAt: null, handledByName: '张三', recipients: ['张三'] },
    { id: 12, seq: 2, key: 'mgr', name: '经理审批', type: 'approval', status: 'active', action: null, comment: null, form: null, formRefLabels: {}, enteredVia: 'normal', enteredAt: new Date(Date.now() - 5 * 3_600_000).toISOString(), finishedAt: null, dueAt: null, handledByName: null, recipients: ['李四'] },
  ],
  events: [{ id: 1, action: 'submit', note: null, actorName: '张三', createdAt: '2026-01-01T00:00:00Z' }, { id: 2, action: 'transfer', note: '我出差', actorName: '管理员', createdAt: '2026-01-02T00:00:00Z' }],
  ccs: [], links: { docId: null, docNo: null, borrowRecordId: null },
  me: { canPass: false, canReturn: false, canCancel: false, canReject: false, returnBlockedReason: null, cancelBlockedReason: null, canResubmit: false, canWithdraw: false, canTransfer: false, stepFields: [] },
  ...over,
});
const wrap = (ui: JSX.Element, url = '/') => render(<MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>);

beforeEach(() => { window.localStorage.clear(); f.templates.mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('我的待办', () => {
  it('逾期的待办标红并说明超了多久，行尾有“去办理”', async () => {
    f.todos.mockResolvedValue(todoList());
    wrap(<MyTodosPage />);
    expect(await screen.findByText('已超时 3 小时')).toBeTruthy();
    expect(screen.getByText('去办理')).toBeTruthy();
    expect(screen.getByText('抄送我的 2 条')).toBeTruthy();
  });
  it('记住上次看的分类；换分类后重新进入仍停在那里', async () => {
    f.todos.mockResolvedValue(todoList());
    const first = wrap(<MyTodosPage />);
    await screen.findByText('差旅费报销');
    fireEvent.click(screen.getByRole('tab', { name: /已逾期/ }));
    await waitFor(() => expect(f.todos).toHaveBeenLastCalledWith(expect.objectContaining({ tab: 'overdue' })));
    first.unmount();
    wrap(<MyTodosPage />);
    await waitFor(() => expect(f.todos).toHaveBeenLastCalledWith(expect.objectContaining({ tab: 'overdue' })));
  });
  it('搜索走服务端；没有结果时给出清除搜索', async () => {
    f.todos.mockResolvedValue(todoList());
    wrap(<MyTodosPage />);
    await screen.findByText('差旅费报销');
    f.todos.mockResolvedValue({ total: 0, counts: { pending: 0, overdue: 0, returned: 0, cc: 0 }, rows: [] });
    fireEvent.change(screen.getByLabelText('搜索待办'), { target: { value: '不存在' } });
    await waitFor(() => expect(f.todos).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '不存在' })));
    expect(await screen.findByText('没有匹配的事项')).toBeTruthy();
    fireEvent.click(screen.getAllByText('清除搜索')[0]);
    expect((screen.getByLabelText('搜索待办') as HTMLInputElement).value).toBe('');
  });
  it('加载失败有重试', async () => {
    f.todos.mockRejectedValueOnce(new Error('x')).mockResolvedValue(todoList());
    wrap(<MyTodosPage />);
    fireEvent.click(await screen.findByText('重试'));
    expect(await screen.findByText('差旅费报销')).toBeTruthy();
  });
});

describe('我发起的 / 流程总览', () => {
  it('流程总览有进行中、已超时统计，点统计即筛选', async () => {
    f.runs.mockImplementation(async (p) => (p.pageSize === 1 ? { total: p.overdue ? 2 : 9, page: 1, pageSize: 1, rows: [] } : { total: 1, page: 1, pageSize: 20, rows: [runRow()] }));
    wrap(<RunsPage view="all" />);
    const tile = await screen.findByRole('button', { name: /已超时/ });
    await waitFor(() => expect(within(tile).getByText('2')).toBeTruthy());
    expect(screen.getByText(/已停留 2 小时/)).toBeTruthy();
    fireEvent.click(tile);
    await waitFor(() => expect(f.runs).toHaveBeenCalledWith(expect.objectContaining({ view: 'all', overdue: true })));
  });
  it('没有数据时我发起的引导去申请中心；有筛选时能一键清除', async () => {
    f.runs.mockResolvedValue({ total: 0, page: 1, pageSize: 20, rows: [] });
    wrap(<RunsPage view="started" />);
    expect(await screen.findByText('去申请中心发起')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索标题'), { target: { value: '报销' } });
    fireEvent.click(await screen.findByText('清除筛选，查看全部'));
    expect((screen.getByLabelText('搜索标题') as HTMLInputElement).value).toBe('');
  });
});

describe('流程总览筛选', () => {
  it('可按发起部门、当前办理人筛选，也能点“退回待补充”', async () => {
    f.runs.mockImplementation(async (p) => ({ total: p.pageSize === 1 ? 3 : 1, page: 1, pageSize: p.pageSize ?? 20, rows: p.pageSize === 1 ? [] : [runRow()] }));
    wrap(<RunsPage view="all" />);
    await screen.findByText('差旅费报销');
    fireEvent.change(await screen.findByLabelText('发起部门'), { target: { value: '5' } });
    await waitFor(() => expect(f.runs).toHaveBeenCalledWith(expect.objectContaining({ view: 'all', departmentId: 5 })));
    fireEvent.change(screen.getByLabelText('当前办理人'), { target: { value: '李' } });
    await waitFor(() => expect(f.runs).toHaveBeenCalledWith(expect.objectContaining({ handler: '李' })));
    fireEvent.click(screen.getByRole('button', { name: /退回待补充/ }));
    await waitFor(() => expect(f.runs).toHaveBeenCalledWith(expect.objectContaining({ returned: true })));
  });
  it('我发起的没有部门和办理人筛选', async () => {
    f.runs.mockResolvedValue({ total: 0, page: 1, pageSize: 20, rows: [] });
    wrap(<RunsPage view="started" />);
    await screen.findByText('没有流程');
    expect(screen.queryByLabelText('发起部门')).toBeNull();
  });
});

describe('申请中心', () => {
  const tpl = (key: string, label: string, active = true) => ({ key, label, description: `${label}说明`, fields: [{ key: 'reason', label: '事由', type: 'text' }], stepFields: {}, active, version: 1, steps: [{ name: '提交', type: 'submit' }, { name: '经理审批', type: 'approval' }, { name: '结束', type: 'end' }] });
  it('可搜索，已启用的排前，未启用的说明原因', async () => {
    f.templates.mockResolvedValue([tpl('a', '借用营业执照', false), tpl('b', '费用申请')] as never);
    wrap(<ApplyPage />);
    await screen.findByText('费用申请');
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles[0]).toContain('费用申请');
    expect(screen.getByText('管理员还没有配置并启用')).toBeTruthy();
    expect(screen.getAllByText('查看流程环节（3 步）').length).toBe(2);
    fireEvent.change(screen.getByLabelText('搜索流程'), { target: { value: '借用' } });
    expect(screen.queryByText('费用申请')).toBeNull();
  });
  it('填了内容关闭表单要确认；提交成功提示编号并记为最近用过', async () => {
    f.templates.mockResolvedValue([tpl('b', '费用申请')] as never);
    f.start.mockResolvedValue(runDetail() as never);
    f.run.mockResolvedValue(runDetail() as never);
    wrap(<ApplyPage />);
    fireEvent.click(await screen.findByText('发起申请'));
    const dialog = await screen.findByRole('dialog', { name: '发起费用申请' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '出差' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(within(dialog).getByText('取消'));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '发起费用申请' })).toBeTruthy();
    fireEvent.click(within(dialog).getByText('提交申请'));
    expect(await screen.findByText(/已提交，编号 #5/)).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('kudesi.apply.recent') ?? '[]')).toEqual(['b']);
    confirm.mockRestore();
  });
});

describe('流程详情', () => {
  it('显示办理进度、停留时间、全部操作记录，没有可办理操作时说明原因', async () => {
    f.run.mockResolvedValue(runDetail() as never);
    render(<RunDetail id={5} onClose={() => undefined} onChanged={() => undefined} />);
    expect(await screen.findByText(/编号 #5/)).toBeTruthy();
    const progress = screen.getByRole('list', { name: '办理进度' });
    expect(within(progress).getAllByRole('listitem').map((x) => x.textContent)).toEqual(['发起', '经理审批']);
    expect(screen.getByText(/已停留 5 小时/)).toBeTruthy();
    expect(screen.getByText(/没有可办理的操作/)).toBeTruthy();
    expect(screen.getByText('全部操作记录（2）')).toBeTruthy();
    expect(screen.getByText(/我出差/)).toBeTruthy();
  });
  it('复制链接；Esc 关闭；办结的流程有结果横幅', async () => {
    f.run.mockResolvedValue(runDetail({ status: 'completed', activeStep: null, finishedAt: '2026-01-03T00:00:00Z' }) as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const onClose = vi.fn();
    render(<RunDetail id={5} onClose={onClose} onChanged={() => undefined} />);
    await screen.findByText(/流程已完成/);
    fireEvent.click(screen.getByText('复制链接'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('?run=5')));
    expect(await screen.findByText(/链接已复制/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('任务中心', () => {
  it('取消任务前要确认；创建成功提示去向', async () => {
    f.assigned.mockResolvedValue({ total: 1, page: 1, pageSize: 20, rows: [{ id: 3, title: '盘点样品', description: null, status: 'open', dueAt: null, createdAt: '', finishedAt: null, doneNote: null, assigneeName: '小李', overdue: false }] });
    f.cancelTask.mockResolvedValue({ ok: true });
    f.createTask.mockResolvedValue({ id: 9 });
    wrap(<TasksPage />);
    fireEvent.click(await screen.findByText('取消'));
    expect(f.cancelTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('确认取消'));
    await waitFor(() => expect(f.cancelTask).toHaveBeenCalledWith(3));
    expect(await screen.findByText('任务已取消')).toBeTruthy();
    fireEvent.click(screen.getByText('新建任务'));
    const dlg = await screen.findByRole('dialog', { name: '新建任务' });
    fireEvent.click(within(dlg).getByText('创建'));
    expect(await within(dlg).findByText('请填写任务标题')).toBeTruthy();
    fireEvent.change(within(dlg).getAllByRole('textbox')[0], { target: { value: '补货' } });
    fireEvent.change(within(dlg).getByRole('combobox'), { target: { value: '7' } });
    fireEvent.click(within(dlg).getByText('创建'));
    expect(await screen.findByText(/已分派给 小李/)).toBeTruthy();
  });
});
