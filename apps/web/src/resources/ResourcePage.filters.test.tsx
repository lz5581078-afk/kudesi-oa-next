import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./RecordForm', () => ({ RecordForm: () => <div>表单</div>, loadRefOptions: async () => [] }));
vi.mock('./CategoryTree', () => ({ CategoryTree: () => <div /> }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), users: vi.fn().mockResolvedValue([]) } };
});
import { ResourcePage } from './ResourcePage';

beforeEach(() => { vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('列表筛选：清除全部条件', () => {
  it('没有条件时空表只说还没有；搜过之后给出提示和“清除全部条件”，点了恢复无条件查询', async () => {
    render(<MemoryRouter><ResourcePage type="finance-suppliers" /></MemoryRouter>);
    await screen.findByText('还没有供应商档案');
    expect(screen.queryByRole('button', { name: '清除筛选' })).toBeNull();
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '不存在' } });
    await screen.findByText(/没有符合当前条件的供应商档案/);
    fireEvent.click(screen.getAllByRole('button', { name: /清除/ })[0]);
    await waitFor(() => expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe(''));
    await screen.findByText('还没有供应商档案');
  });
  it('表格单元格带列名，手机上按卡片显示', async () => {
    vi.mocked(resourceApi.list).mockResolvedValue({ items: [{ id: 1, type: 'finance-suppliers', title: '润农', status: 'active', statusReason: null, data: { name: '润农', code: 'GYS-001' }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' }], total: 1, page: 1, pageSize: 20 } as never);
    render(<MemoryRouter><ResourcePage type="finance-suppliers" /></MemoryRouter>);
    const cell = await screen.findByText('GYS-001');
    expect(cell.closest('td')?.getAttribute('data-label')).toBe('供应商编号');
    expect(cell.closest('table')?.className).toContain('cards-narrow');
  });
});
