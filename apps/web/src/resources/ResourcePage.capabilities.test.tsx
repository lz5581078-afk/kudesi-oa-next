import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef, type ResourceDef } from '@kudesi/shared';
import { resourceApi } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./RecordForm', () => ({ RecordForm: () => <div>表单</div>, loadRefOptions: async () => [{ value: 3, label: '小王' }] }));
vi.mock('./RecordDetail', () => ({ RecordDetail: ({ id }: { id: number }) => <div>详情{id}</div>, useResourceCan: () => () => true }));
vi.mock('./CategoryTree', () => ({ CategoryTree: () => null }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), users: vi.fn().mockResolvedValue([]), departments: vi.fn().mockResolvedValue([{ id: 4, name: '运营中心' }]), batchAction: vi.fn(), batchStatus: vi.fn() } };
});
import { ResourcePage } from './ResourcePage';

const def = getResourceDef('phones') as ResourceDef & Record<string, unknown>;
const orig = { computedFilters: def.computedFilters, quickTabs: def.quickTabs, derivedColumns: def.derivedColumns, batchActions: def.batchActions };
const row = (id: number, status = 'normal') => ({ id, type: 'phones', title: `1380013800${id}`, status, statusReason: null, archived: null, data: { number: `1380013800${id}`, usageType: 'company_kept', storeCount: id }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' });
const list = (items: unknown[], tabCounts: Record<string, number> = {}) => ({ items, total: items.length, page: 1, pageSize: 20, tabCounts }) as never;
const page = () => render(<MemoryRouter><ResourcePage type="phones" /></MemoryRouter>);

beforeEach(() => {
  localStorage.clear();
  def.quickTabs = [{ key: 'free', label: '空闲号', when: { field: 'usageType', op: 'eq', value: 'company_kept' } }];
  def.derivedColumns = [{ key: 'storeCount', label: '店铺数', kind: 'count', type: 'stores', field: 'phoneId' }];
  def.batchActions = [{ key: 'assign', label: '批量指派', pick: 'usageType', reasonRequired: true, reasonLabel: '指派原因' }];
  vi.mocked(resourceApi.list).mockResolvedValue(list([row(1), row(2, 'inactive')], { 'q:free': 5 }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); Object.assign(def, orig); });

describe('列表壳：配置驱动的能力入口', () => {
  it('快捷页签：和分类页签同一排，带数量，点击后以 q:<key> 查询', async () => {
    page();
    const tab = await screen.findByRole('tab', { name: /空闲号 5/ });
    fireEvent.click(tab);
    await waitFor(() => expect(vi.mocked(resourceApi.list).mock.calls.at(-1)?.[1]).toMatchObject({ tab: 'q:free' }));
  });

  it('派生列：显示数字列，可点表头排序（交服务端），导出带上这一列', async () => {
    vi.mocked(resourceApi).export = vi.fn().mockResolvedValue({ filename: 'x.csv', csv: 'a', count: 1 }) as never;
    page();
    const head = await screen.findByRole('columnheader', { name: /店铺数/ });
    fireEvent.click(head.querySelector('button')!);
    await waitFor(() => expect(vi.mocked(resourceApi.list).mock.calls.at(-1)?.[1]).toMatchObject({ sortBy: 'storeCount' }));
    fireEvent.click(await screen.findByRole('button', { name: /^导出/ }));
    await waitFor(() => expect(resourceApi.export).toHaveBeenCalled());
    expect(vi.mocked(resourceApi.export).mock.calls[0][2]).toMatchObject({ cols: ['storeCount'] });
  });

  it('带原因的批量动作：必须选值并填原因才能提交，提交后带 action/value/reason', async () => {
    vi.mocked(resourceApi.batchAction).mockResolvedValue({ done: 1, failed: [] });
    page();
    fireEvent.click(await screen.findByLabelText('勾选 13800138001'));
    fireEvent.click(screen.getByRole('button', { name: '批量指派' }));
    const dlg = await screen.findByRole('dialog', { name: /批量指派/ });
    fireEvent.click(within(dlg).getByRole('button', { name: '确定' }));
    expect(await within(dlg).findByText(/请选择使用类型/)).toBeTruthy();
    fireEvent.change(within(dlg).getByRole('combobox'), { target: { value: 'personal_used' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '确定' }));
    expect(await within(dlg).findByText(/请填写指派原因/)).toBeTruthy();
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: '新人接手' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '确定' }));
    await waitFor(() => expect(resourceApi.batchAction).toHaveBeenCalledWith('phones', [1], 'assign', 'personal_used', '新人接手'));
  });

  it('所有资料都有停用所选/启用所选：停用只算非停用的，启用只算已停用的，要填原因', async () => {
    vi.mocked(resourceApi.batchStatus).mockResolvedValue({ done: 1, failed: [] });
    page();
    fireEvent.click(await screen.findByLabelText('勾选 13800138001'));
    fireEvent.click(screen.getByLabelText('勾选 13800138002'));
    expect(screen.getByRole('button', { name: '停用所选（1）' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '启用所选（1）' }));
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: '恢复使用' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '确定' }));
    await waitFor(() => expect(resourceApi.batchStatus).toHaveBeenCalledWith('phones', [2], 'normal', '恢复使用'));
  });

  it('计算筛选的动态选项：部门下拉由服务端部门生成，选中后以值查询', async () => {
    def.computedFilters = [{ key: 'opDept', label: '运营部门', optionsFrom: 'departments', when: { viaUserDept: 'x', dept: '$value' } }];
    page();
    fireEvent.click(await screen.findByRole('button', { name: /^筛选/ }));
    const sel = await screen.findByLabelText('运营部门');
    await screen.findByRole('option', { name: '运营中心' });
    fireEvent.change(sel, { target: { value: '4' } });
    await waitFor(() => expect(vi.mocked(resourceApi.list).mock.calls.at(-1)?.[1]).toMatchObject({ filters: { opDept: '4' } }));
  });
});
