import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTimeoutPolicy } from '@kudesi/shared';
import { designerApi, type LedgerRow } from './designerApi';
import { NodeCenterPage } from './NodeCenterPage';
import { TimeoutsPage } from './TimeoutsPage';

vi.mock('./designerApi', async (orig) => ({
  ...(await orig<typeof import('./designerApi')>()),
  designerApi: { nodeCenter: vi.fn(), saveNode: vi.fn(), deleteNode: vi.fn(), policy: vi.fn(), savePolicy: vi.fn(), ledger: vi.fn(), decide: vi.fn(), directory: vi.fn() },
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));

const node = (o: object) => ({ key: 'n1', name: '主管审批', description: '直属主管审批', category: '通用节点', type: 'approval', dueMinutes: 240, fields: [{ key: 'opinion', label: '审批意见', type: 'text', group: '审批' }], builtin: true, revision: 0, ...o });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('节点中心', () => {
  beforeEach(() => {
    vi.mocked(designerApi.nodeCenter).mockResolvedValue({ canManage: true, categories: ['通用节点', '财务与费用'], business: [{ key: 'b1', name: '归还确认', flowLabel: '借用执照', type: 'confirm', dueMinutes: null, fields: [] }],
      templates: [node({}), node({ key: 'mine1', name: '我的付款节点', category: '财务与费用', builtin: false, revision: 3, description: '付款' })] as never });
  });
  it('按分类和搜索筛选，内置模板只读，可复制为自己的', async () => {
    render(<NodeCenterPage />);
    expect(await screen.findByText('主管审批')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '财务与费用' }));
    expect(screen.queryByText('主管审批')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    fireEvent.change(screen.getByLabelText('搜索节点模板'), { target: { value: '没有的' } });
    expect(screen.getByText('没有匹配的节点模板')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索节点模板'), { target: { value: '' } });
    fireEvent.click(screen.getByText('主管审批'));
    expect(screen.queryByText('编辑')).toBeNull();
    expect(screen.getByText('审批意见')).toBeTruthy();
    vi.mocked(designerApi.saveNode).mockResolvedValue({ key: 'mine2', revision: 1 });
    fireEvent.click(screen.getByText('复制为我的模板'));
    expect((screen.getAllByLabelText('名称')[0] as HTMLInputElement).value).toBe('主管审批（我的）');
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(designerApi.saveNode).toHaveBeenCalledWith(expect.objectContaining({ key: null, sourceKey: 'n1', name: '主管审批（我的）' })));
  });
  it('编辑自己的模板带版本号，冲突时显示提示；可删除', async () => {
    const { ApiError } = await import('../../api/client');
    render(<NodeCenterPage />);
    fireEvent.click(await screen.findByText('我的付款节点'));
    fireEvent.click(screen.getByText('编辑'));
    vi.mocked(designerApi.saveNode).mockRejectedValue(new ApiError(409, '这个模板已被别人修改，请刷新后再改'));
    fireEvent.click(screen.getByText('保存'));
    expect(await screen.findByText(/已被别人修改/)).toBeTruthy();
    expect(designerApi.saveNode).toHaveBeenCalledWith(expect.objectContaining({ key: 'mine1', revision: 3 }));
    fireEvent.click(screen.getByText('取消'));
    vi.mocked(designerApi.deleteNode).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByText('删除'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('删除'));
    await waitFor(() => expect(designerApi.deleteNode).toHaveBeenCalledWith('mine1'));
  });
});

describe('超时与处罚', () => {
  const ledgerRow = (o: Partial<LedgerRow>): LedgerRow => ({ id: 1, runId: 9, templateKey: 'k', templateLabel: '费用申请', stepKey: 'pay', assigneeId: 2, assigneeName: '出纳', soleOwner: true, title: '差旅费', dueAt: '2026-01-01T00:00:00Z', endedAt: null, overdueMinutes: 35, status: 'open', penaltyId: 5, calculatedCents: 800, confirmedCents: null, penaltyStatus: 'pending', penaltyReason: null, penaltyRevision: 1, notifications: [], ...o });
  beforeEach(() => {
    const eff = { policy: defaultTimeoutPolicy(), sources: { notifications: '公司默认', penalties: '公司默认' } };
    vi.mocked(designerApi.policy).mockResolvedValue({ policy: {}, effective: eff, inherited: eff, revision: 0, overrides: [], canManage: true });
    vi.mocked(designerApi.directory).mockResolvedValue({ canManage: true, templates: [] });
    vi.mocked(designerApi.ledger).mockResolvedValue({ total: 2, page: 1, pageSize: 20, canDecide: true, rows: [ledgerRow({}), ledgerRow({ id: 2, soleOwner: false, penaltyId: null, calculatedCents: null, penaltyStatus: null, assigneeName: '仓库' })] });
  });
  it('台账：共享收件不计处罚；确认处罚必须写原因，金额不得超过计算值', async () => {
    render(<TimeoutsPage />);
    fireEvent.click(screen.getByRole('tab', { name: '超时与处罚台账' }));
    expect((await screen.findAllByText('差旅费')).length).toBe(2);
    expect(screen.getByText('共享收件，不计处罚')).toBeTruthy();
    fireEvent.click(screen.getByText('确认/免除'));
    const dlg = screen.getByRole('dialog', { name: '处理处罚' });
    const submit = within(dlg).getByText('提交') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText(/原因/), { target: { value: '确属延误' } });
    fireEvent.change(within(dlg).getByLabelText(/实际金额/), { target: { value: '9' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText(/实际金额/), { target: { value: '5' } });
    expect(submit.disabled).toBe(false);
    vi.mocked(designerApi.decide).mockResolvedValue({ ok: true });
    fireEvent.click(submit);
    await waitFor(() => expect(designerApi.decide).toHaveBeenCalledWith(5, { status: 'confirmed', amountCents: 500, reason: '确属延误', revision: 1 }));
    expect((await screen.findByRole('status')).textContent).toBe('处罚已确认');
  });
});
