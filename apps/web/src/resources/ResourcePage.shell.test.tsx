import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./RecordForm', () => ({ RecordForm: () => <div>表单</div>, loadRefOptions: async () => [] }));
vi.mock('./RecordDetail', () => ({ RecordDetail: ({ id }: { id: number }) => <div>详情{id}</div>, useResourceCan: () => () => true }));
vi.mock('./CategoryTree', () => ({ CategoryTree: () => null }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), users: vi.fn().mockResolvedValue([]), export: vi.fn().mockResolvedValue({ filename: 'x.csv', csv: 'a', count: 1 }) } };
});
import { ResourcePage } from './ResourcePage';

const row = { id: 7, type: 'phones', title: '13800138000', status: 'normal', statusReason: null, data: { number: '13800138000', carrier: '移动', usageType: 'company_kept' }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' };
const list = (items: unknown[], total = items.length) => ({ items, total, page: 1, pageSize: 20, tabCounts: {} }) as never;
const page = () => render(<MemoryRouter><ResourcePage type="phones" /></MemoryRouter>);

beforeEach(() => {
  localStorage.clear();
  vi.mocked(resourceApi.list).mockResolvedValue(list([row]));
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('资料列表通用壳', () => {
  it('号码列有复制按钮：点复制写剪贴板，不会打开详情；点行才打开详情', async () => {
    page();
    const btn = await screen.findByRole('button', { name: '复制号码' });
    fireEvent.click(btn);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('13800138000'));
    expect(screen.queryByText('详情7')).toBeNull();
    fireEvent.click(screen.getByText('移动'));
    expect(await screen.findByText('详情7')).toBeTruthy();
  });

  it('搜索框有清空按钮；有筛选时出现“找到 N 条”结果条，点“清除搜索和筛选”恢复', async () => {
    page();
    await screen.findByRole('button', { name: '复制号码' });
    expect(screen.queryByText(/找到/)).toBeNull();
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '138' } });
    expect(await screen.findByText(/找到 1 条符合条件的/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'zzz' } });
    vi.mocked(resourceApi.list).mockResolvedValue(list([]));
    expect((await screen.findAllByText(/没有符合条件的手机号/, {}, { timeout: 2000 })).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: '清除搜索和筛选' })[0]);
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('');
  });

  it('没有任何资料时的空状态提示新增，不是“没有匹配”', async () => {
    vi.mocked(resourceApi.list).mockResolvedValue(list([]));
    page();
    expect(await screen.findByText(/还没有手机号/)).toBeTruthy();
  });

  it('每页条数、状态筛选记住：重新打开页面还是上次的选择', async () => {
    const first = page();
    await screen.findByRole('button', { name: '复制号码' });
    fireEvent.change(screen.getByLabelText('每页条数'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /^筛选/ }));
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'normal' } });
    first.unmount();
    page();
    await screen.findByRole('button', { name: '复制号码' });
    expect((screen.getByLabelText('每页条数') as HTMLSelectElement).value).toBe('50');
    fireEvent.click(screen.getByRole('button', { name: /^筛选/ }));
    expect((screen.getByLabelText('状态') as HTMLSelectElement).value).toBe('normal');
  });

  it('所有资料页都能勾选行并“导出所选”（不再只限批量配置的资料）', async () => {
    page();
    fireEvent.click(await screen.findByRole('checkbox', { name: /勾选 13800138000/ }));
    fireEvent.click(screen.getAllByRole('button', { name: /导出所选/ })[0]);
    await waitFor(() => expect(resourceApi.export).toHaveBeenCalled());
    expect(vi.mocked(resourceApi.export).mock.calls[0][2]).toEqual({ ids: [7], cols: [] });
  });

  it('表头第一次点是升序，再点降序，再点取消；手机上有排序下拉', async () => {
    page();
    await screen.findByRole('button', { name: '复制号码' });
    fireEvent.click(screen.getByRole('button', { name: '运营商' }));
    await waitFor(() => expect(vi.mocked(resourceApi.list).mock.calls.some((c) => c[1]?.sortBy === 'carrier' && c[1]?.sortDir === 'asc')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /运营商/ }));
    await waitFor(() => expect(vi.mocked(resourceApi.list).mock.calls.some((c) => c[1]?.sortDir === 'desc')).toBe(true));
    // 手机上排序下拉收进筛选面板
    cleanup();
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
    try {
      page();
      await screen.findByRole('button', { name: /^筛选/ });
      fireEvent.click(screen.getByRole('button', { name: /^筛选/ }));
      expect(screen.getByLabelText('排序方式')).toBeTruthy();
    } finally { window.matchMedia = mm; }
  });

  it('显示列菜单有“全部显示 / 恢复默认”', async () => {
    page();
    await screen.findByRole('button', { name: '复制号码' });
    fireEvent.click(screen.getByRole('button', { name: '显示列' }));
    fireEvent.click(screen.getByRole('button', { name: '全部显示' }));
    expect(screen.getAllByRole('checkbox', { name: /绑定店铺|运营商/ }).every((c) => (c as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(JSON.parse(localStorage.getItem('kudesi.cols.phones') ?? '[]').length).toBeGreaterThan(0);
  });
});
