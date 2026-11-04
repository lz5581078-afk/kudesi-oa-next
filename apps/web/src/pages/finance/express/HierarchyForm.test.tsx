import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HierarchyForm } from './HierarchyForm';
import { resourceApi, type ResourceDto } from '../../../resources/api';
vi.mock('../../../resources/RecordDetail', () => ({ useResourceCan: () => () => true }));
vi.mock('../../../resources/api', () => ({ resourceApi: { create: vi.fn(), update: vi.fn(), get: vi.fn(), gridSave: vi.fn() } }));
const row = (type: string, data: Record<string, unknown>, status = 'normal'): ResourceDto => ({ id: 3, type, title: '合成', data, status, statusReason: null, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' });
const carriers = [{ id: 1, name: '合成快递', status: 'normal', defaultBranchId: null, note: '', branches: [] }];
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('快递层级资料原表单', () => {
  it('新网点使用所属公司原生选择、联系信息和状态，不出现当前版本维护字段', async () => {
    vi.mocked(resourceApi.create).mockResolvedValue(row('finance-express-branches', {}));
    render(<HierarchyForm carriers={carriers} state={{ kind: 'branch', id: null, carrierId: 1 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('所属快递公司').tagName).toBe('SELECT');
    expect(screen.queryByLabelText('当前价格版本')).toBeNull();
    fireEvent.change(screen.getByLabelText('经营网点名称'), { target: { value: ' 合成网点 ' } });
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'inactive' } });
    fireEvent.change(screen.getByLabelText('联系人'), { target: { value: ' 合成人员 ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存经营网点' }));
    await waitFor(() => expect(resourceApi.create).toHaveBeenCalledWith('finance-express-branches', expect.objectContaining({ name: '合成网点', carrierId: 1, contactName: '合成人员' }), 'inactive'));
  });
  it('版本表单只维护原六项，重量错误不提交，保存不覆写原合作状态与价格来源', async () => {
    vi.mocked(resourceApi.get).mockResolvedValue(row('finance-express-versions', { branchId: 2, versionName: '合成版本', effectiveStart: '2026-11-01', shippingWeightMin: 0, shippingWeightMax: 30, cooperationStatus: 'active', priceSource: 'ai', remark: '旧备注' }, 'active'));
    vi.mocked(resourceApi.update).mockResolvedValue(row('finance-express-versions', {}, 'active'));
    render(<HierarchyForm carriers={carriers} state={{ kind: 'version', id: 3, branchId: 2 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByDisplayValue('合成版本');
    expect(screen.queryByLabelText('合作状态')).toBeNull();
    expect(screen.queryByLabelText('最终价格依据')).toBeNull();
    fireEvent.change(screen.getByLabelText('最大可发货重量（kg）'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect((await screen.findByRole('alert')).textContent).toContain('上限必须大于下限');
    expect(resourceApi.update).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('最大可发货重量（kg）'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(resourceApi.update).toHaveBeenCalledWith('finance-express-versions', 3, { branchId: 2, versionName: '合成版本', effectiveStart: '2026-11-01', effectiveEnd: '', shippingWeightMin: 0, shippingWeightMax: null, remark: '旧备注' }));
  });
  it('公司编辑改状态与文字同一批保存，失败保留填写后可重试', async () => {
    vi.mocked(resourceApi.get).mockResolvedValue(row('finance-express-carriers', { name: '合成快递', defaultBranchId: 2, note: '' }));
    vi.mocked(resourceApi.gridSave).mockResolvedValueOnce({ results: [{ id: 3, ok: false, message: '合成冲突' }] } as never).mockResolvedValueOnce({ results: [{ id: 3, ok: true, row: row('finance-express-carriers', { name: '改名' }, 'inactive') }] } as never);
    render(<HierarchyForm carriers={carriers} state={{ kind: 'carrier', id: 3 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByDisplayValue('合成快递');
    expect(screen.queryByLabelText('默认网点')).toBeNull();
    fireEvent.change(screen.getByLabelText('快递公司名称'), { target: { value: '改名' } });
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'inactive' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect((await screen.findByRole('alert')).textContent).toBe('合成冲突');
    expect((screen.getByLabelText('快递公司名称') as HTMLInputElement).value).toBe('改名');
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(resourceApi.gridSave).toHaveBeenCalledTimes(2));
    expect(resourceApi.update).not.toHaveBeenCalled();
  });
});

it('网点原公司选择保持可操作，更换时明确反馈现有约束且不伪造保存成功', async () => {
  vi.mocked(resourceApi.get).mockResolvedValue(row('finance-express-branches', { carrierId: 1, name: '合成网点', contactName: '旧联系人' }));
  render(<HierarchyForm carriers={[...carriers, { ...carriers[0], id: 2, name: '另一合成快递' }]} state={{ kind: 'branch', id: 3, carrierId: 1 }} onClose={vi.fn()} onSaved={vi.fn()} />);
  await screen.findByDisplayValue('合成网点');
  expect((screen.getByLabelText('所属快递公司') as HTMLSelectElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('所属快递公司'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  expect((await screen.findByRole('alert')).textContent).toContain('已有网点不能更换所属快递公司');
  expect(resourceApi.update).not.toHaveBeenCalled();
});
