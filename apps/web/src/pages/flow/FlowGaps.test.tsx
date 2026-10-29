import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StarterScope, StepDef } from '@kudesi/shared';
import { SKU_DUE_MINUTES, SKU_REMIND, getFlowTemplate } from '@kudesi/shared';
import { resourceApi } from '../../resources/api';
import { FlowValues } from './FlowFields';
import { NodeEditor } from './NodeEditor';
import { ReassignDialog } from './ReassignDialog';
import { SkuBatchPanel } from './SkuBatchPanel';
import { skuBatchApi, type BatchBoard } from './SkuApply';
import { StarterScopeEditor } from './StarterScopeEditor';
import { flowApi } from './flowApi';
import { MyTodosPage } from './TodosPage';

vi.mock('./flowApi', async (orig) => ({ ...(await orig<typeof import('./flowApi')>()), flowApi: { todos: vi.fn(), reassign: vi.fn(), run: vi.fn() } }));
vi.mock('./SkuApply', async (orig) => ({ ...(await orig<typeof import('./SkuApply')>()), skuBatchApi: { board: vi.fn(), act: vi.fn(), returnAll: vi.fn(), returnSpecs: vi.fn() } }));
vi.mock('../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../resources/api')>()), resourceApi: { fileUrl: vi.fn() } }));
vi.mock('../../resources/RecordForm', async (orig) => ({
  ...(await orig<typeof import('../../resources/RecordForm')>()),
  loadRefOptions: vi.fn().mockResolvedValue([{ value: 7, label: '小李' }, { value: 8, label: '小王' }]),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const lookups = { users: [{ value: 7, label: '小李' }], positions: [{ value: 3, label: '运营专员' }], depts: [{ value: 4, label: '运营部' }], groups: [{ value: 9, label: '值班组' }] };

describe('SKU 仓库/财务节点：时限和提前提醒可以逐节点修改', () => {
  const tpl = getFlowTemplate('sku-batch-apply')!;
  const warehouse = tpl.steps.find((s) => s.key === 'warehouse')!;
  const finance = tpl.steps.find((s) => s.key === 'review')!;
  it('默认是旧系统的 60 分钟，提前 20/10 分钟提醒，超时后每 5 分钟', () => {
    expect(SKU_DUE_MINUTES).toBe(60);
    expect(SKU_REMIND).toEqual({ beforeMinutes: [20, 10], overdueEveryMinutes: 5 });
    for (const s of [warehouse, finance]) { expect(s.dueMinutes).toBe(60); expect(s.remind).toEqual(SKU_REMIND); }
  });
  it('在节点面板里改时限与两次提前提醒、超时间隔，各自写回节点', () => {
    const onChange = vi.fn();
    render(<NodeEditor step={warehouse as StepDef} index={1} steps={tpl.steps as StepDef[]} tpl={tpl} custom={false} canEdit lookups={lookups} stepFields={[]} onChange={onChange} onFields={() => undefined} />);
    expect((screen.getByLabelText('时限（分钟）') as HTMLInputElement).value).toBe('60');
    fireEvent.change(screen.getByLabelText('时限（分钟）'), { target: { value: '90' } });
    expect(onChange).toHaveBeenLastCalledWith({ dueMinutes: 90 });
    fireEvent.change(screen.getByLabelText('首次提前'), { target: { value: '30' } });
    expect(onChange).toHaveBeenLastCalledWith({ remind: { beforeMinutes: [30, 10], overdueEveryMinutes: 5 } });
    fireEvent.change(screen.getByLabelText('再次提前'), { target: { value: '5' } });
    expect(onChange).toHaveBeenLastCalledWith({ remind: { beforeMinutes: [20, 5], overdueEveryMinutes: 5 } });
    fireEvent.change(screen.getByLabelText('超时提醒间隔'), { target: { value: '15' } });
    expect(onChange).toHaveBeenLastCalledWith({ remind: { beforeMinutes: [20, 10], overdueEveryMinutes: 15 } });
  });
  it('没有编辑权限时这些输入都不可改', () => {
    render(<NodeEditor step={finance as StepDef} index={2} steps={tpl.steps as StepDef[]} tpl={tpl} custom={false} canEdit={false} lookups={lookups} stepFields={[]} onChange={vi.fn()} onFields={() => undefined} />);
    expect((screen.getByLabelText('时限（分钟）') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('首次提前') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('发起人范围编辑器', () => {
  it('部门/岗位/角色/职责组/员工都能添加和移除；全部移除后变成“不限制”(null)', () => {
    const onChange = vi.fn();
    const { rerender } = render(<StarterScopeEditor scope={null} lookups={lookups} disabled={false} onChange={onChange} />);
    expect(screen.getByText(/现在不限制/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('添加部门'), { target: { value: '4' } });
    expect(onChange).toHaveBeenLastCalledWith({ departments: [4] });
    fireEvent.change(screen.getByLabelText('添加角色'), { target: { value: 'warehouse' } });
    expect(onChange).toHaveBeenLastCalledWith({ positionTypes: ['warehouse'] });
    fireEvent.change(screen.getByLabelText('添加职责组'), { target: { value: '9' } });
    expect(onChange).toHaveBeenLastCalledWith({ dutyGroups: [9] });
    const scope: StarterScope = { departments: [4], users: [7] };
    rerender(<StarterScopeEditor scope={scope} lookups={lookups} disabled={false} onChange={onChange} />);
    expect(screen.getByText(/命中任一项/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('移除部门 运营部'));
    expect(onChange).toHaveBeenLastCalledWith({ departments: [], users: [7] });
    rerender(<StarterScopeEditor scope={{ departments: [4] }} lookups={lookups} disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('移除部门 运营部'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
  it('没有配置权限时只读', () => {
    render(<StarterScopeEditor scope={{ users: [7] }} lookups={lookups} disabled onChange={vi.fn()} />);
    expect(screen.queryByLabelText('移除指定员工 小李')).toBeNull();
    expect(screen.getByText('小李')).toBeTruthy();
  });
});

describe('自建流程的附件字段', () => {
  it('详情页显示文件名和下载链接，而不是编号', async () => {
    vi.mocked(resourceApi.fileUrl).mockImplementation(async (id: number) => (id === 31 ? { url: 'https://x/a.pdf', name: '合同.pdf', mime: 'application/pdf' } : Promise.reject(new Error('无权'))));
    render(<FlowValues fields={[{ key: 'att', label: '附件', type: 'files' }] as never} values={{ att: [31, 32] }} />);
    const link = await screen.findByRole('link', { name: '合同.pdf' });
    expect(link.getAttribute('href')).toBe('https://x/a.pdf');
    expect(await screen.findByText(/文件 #32（无法打开/)).toBeTruthy();
    expect(screen.queryByText('31,32')).toBeNull();
  });
  it('空附件显示破折号', () => {
    render(<FlowValues fields={[{ key: 'att', label: '附件', type: 'files' }] as never} values={{ att: [] }} />);
    expect(screen.getByText('—')).toBeTruthy();
  });
});

const board = (over: Partial<BatchBoard> = {}): BatchBoard => ({
  ref: 'Bk1', batchKey: 'Bk1', batchName: '10 月新品', requesterName: '运营甲', total: 3, runCount: 3,
  counts: { running: 3, completed: 0, ended: 0, returned: 0, mine: 3 },
  me: { isRequester: false, holdStepKey: 'review', holdStepName: '财务审核', holdCount: 3, canReturnAll: true },
  items: [1, 2, 3].map((n) => ({ runId: n, specIndex: 0, specName: `规格${n}`, specCount: 1, runStatus: 'running', revision: 2, stepId: 10 + n, stepKey: 'review', stepName: '财务审核', enteredVia: 'normal', dueAt: null, overdue: false, recipients: ['财务'], mine: true, canResubmit: false, returnReason: null, returnedBy: null, returnedAt: null })),
  history: [], ...over,
});

describe('SKU 申请汇总面板', () => {
  beforeEach(() => { vi.mocked(skuBatchApi.board).mockResolvedValue(board()); });
  it('勾选规格批量退回：必须写原因，提交后显示成功/失败汇总', async () => {
    vi.mocked(skuBatchApi.act).mockResolvedValue({ ok: 1, failed: 1, results: [{ runId: 1, ok: true }, { runId: 2, ok: false, message: '这一步已经被处理过了' }] });
    render(<SkuBatchPanel batchKey="Bk1" onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText('规格1');
    fireEvent.click(screen.getByLabelText('选择 规格1'));
    fireEvent.click(screen.getByLabelText('选择 规格2'));
    fireEvent.click(screen.getByRole('button', { name: '批量退回' }));
    const dlg = within(screen.getByRole('dialog', { name: /批量退回 2 个规格/ }));
    fireEvent.click(dlg.getByRole('button', { name: '退回' }));
    expect(await dlg.findByText(/至少 2 个字/)).toBeTruthy();
    expect(skuBatchApi.act).not.toHaveBeenCalled();
    fireEvent.change(dlg.getByRole('textbox'), { target: { value: '赠品数量不对' } });
    fireEvent.click(dlg.getByRole('button', { name: '退回' }));
    await waitFor(() => expect(skuBatchApi.act).toHaveBeenCalledWith({ ref: 'Bk1', action: 'return', items: [{ runId: 1, revision: 2, stepId: 11 }, { runId: 2, revision: 2, stepId: 12 }], comment: '赠品数量不对' }));
    expect(await screen.findByText(/成功 1 个，失败 1 个/)).toBeTruthy();
    expect(screen.getByText(/规格2：这一步已经被处理过了/)).toBeTruthy();
  });
  it('整单退回：只在全部规格都是自己的待办时出现，带上全部规格的版本号', async () => {
    vi.mocked(skuBatchApi.returnAll).mockResolvedValue({ ok: true, count: 3 });
    render(<SkuBatchPanel batchKey="Bk1" onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /整单退回（全部 3 个）/ }));
    const dlg = within(screen.getByRole('dialog', { name: /整单退回/ }));
    fireEvent.change(dlg.getByRole('textbox'), { target: { value: '整单资料有误' } });
    fireEvent.click(dlg.getByRole('button', { name: '整单退回' }));
    await waitFor(() => expect(skuBatchApi.returnAll).toHaveBeenCalledWith({ ref: 'Bk1', items: [1, 2, 3].map((n) => ({ runId: n, revision: 2, stepId: 10 + n })), reason: '整单资料有误' }));
    expect(await screen.findByText(/整单退回：3 个规格已退回/)).toBeTruthy();
  });
  it('别人手里还有规格时没有整单退回按钮', async () => {
    vi.mocked(skuBatchApi.board).mockResolvedValue(board({ me: { isRequester: false, holdStepKey: 'review', holdStepName: '财务审核', holdCount: 2, canReturnAll: false } }));
    render(<SkuBatchPanel batchKey="Bk1" onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText('规格1');
    expect(screen.queryByRole('button', { name: /整单退回/ })).toBeNull();
  });
  it('财务批量通过要先勾选核对确认', async () => {
    vi.mocked(skuBatchApi.act).mockResolvedValue({ ok: 3, failed: 0, results: [] });
    render(<SkuBatchPanel batchKey="Bk1" onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText('规格1');
    fireEvent.click(screen.getByLabelText(/全选我名下的/));
    fireEvent.click(screen.getByRole('button', { name: '批量通过' }));
    const dlg = within(screen.getByRole('dialog', { name: '批量通过' }));
    expect((dlg.getByRole('button', { name: '确认通过' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dlg.getByLabelText(/我已核对/));
    fireEvent.click(dlg.getByRole('button', { name: '确认通过' }));
    await waitFor(() => expect(skuBatchApi.act).toHaveBeenCalledWith(expect.objectContaining({ action: 'pass', form: { confirmed: true } })));
  });
  it('申请人看到被退回的规格和原因，可以原样重新提交', async () => {
    vi.mocked(skuBatchApi.board).mockResolvedValue(board({
      me: { isRequester: true, holdStepKey: null, holdStepName: '', holdCount: 0, canReturnAll: false }, counts: { running: 3, completed: 0, ended: 0, returned: 1, mine: 0 },
      items: [{ ...board().items[0], mine: false, canResubmit: true, stepName: '运营申请', stepKey: 'apply', enteredVia: 'return', returnReason: '包装不对', returnedBy: '仓库' }],
    }));
    vi.mocked(skuBatchApi.act).mockResolvedValue({ ok: 1, failed: 0, results: [] });
    render(<SkuBatchPanel batchKey="Bk1" onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByText(/仓库：包装不对/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '修改并重新提交' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('选择 规格1'));
    fireEvent.click(screen.getByRole('button', { name: '原样重新提交' }));
    await waitFor(() => expect(skuBatchApi.act).toHaveBeenCalledWith({ ref: 'Bk1', action: 'resubmit', items: [{ runId: 1, revision: 2 }] }));
  });
});

describe('待办里的申请汇总行', () => {
  it('同一张申请单只占一行，显示规格数，点“批量办理”打开汇总面板', async () => {
    vi.mocked(flowApi.todos).mockResolvedValue({ total: 1, counts: { pending: 1, overdue: 0, returned: 0, cc: 0 }, rows: [{ id: 1, kind: 'flow', description: null, runId: 1, title: 't', stepName: '财务审核', enteredVia: 'normal', templateLabel: 'SKU 批量申请', runTitle: 'SKU 申请', requesterName: '运营甲', dueAt: null, createdAt: '2026-01-01T00:00:00Z', finishedAt: null, overdue: false, batchKey: 'Bk1', batchName: '10 月新品', batchCount: 3 }] } as never);
    vi.mocked(skuBatchApi.board).mockResolvedValue(board());
    render(<MemoryRouter><MyTodosPage /></MemoryRouter>);
    expect(await screen.findByText(/3 个规格待办理/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '批量办理' }));
    expect(await screen.findByRole('dialog', { name: '申请汇总' })).toBeTruthy();
  });
});

describe('管理员批量改派', () => {
  it('先预览数量，写原因后才能确认；请求带 dryRun 与不带 dryRun 各一次', async () => {
    vi.mocked(flowApi.reassign).mockImplementation(async (b) => (b.dryRun ? { count: 2, items: [{ runId: 5, title: '差旅费', stepName: '经理审批', templateLabel: '费用申请' }] } : { moved: 2, skipped: [] }));
    const onDone = vi.fn();
    render(<ReassignDialog templates={[]} onClose={vi.fn()} onDone={onDone} />);
    const [from, to] = await waitFor(() => { const s = screen.getAllByRole('combobox'); expect(s.length).toBeGreaterThan(2); return s; });
    await screen.findAllByText('小李');
    fireEvent.change(from, { target: { value: '7' } });
    fireEvent.change(to, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: '预览要改派的待办' }));
    expect(await screen.findByText('将改派 2 条')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认改派' }));
    expect(await screen.findByText(/至少 2 个字/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/张三离职/), { target: { value: '张三离职交接' } });
    fireEvent.click(screen.getByRole('button', { name: '确认改派' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('已改派 2 条'));
    expect(flowApi.reassign).toHaveBeenNthCalledWith(1, expect.objectContaining({ fromUserId: 7, toUserId: 8, dryRun: true }));
    expect(flowApi.reassign).toHaveBeenNthCalledWith(2, { fromUserId: 7, toUserId: 8, reason: '张三离职交接' });
  });
  it('原办理人和新办理人相同时不能预览', async () => {
    render(<ReassignDialog templates={[]} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findAllByText('小李');
    const [from, to] = screen.getAllByRole('combobox');
    fireEvent.change(from, { target: { value: '7' } });
    fireEvent.change(to, { target: { value: '7' } });
    expect((screen.getByRole('button', { name: '预览要改派的待办' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
