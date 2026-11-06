import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { resourceApi, type ResourceDto } from './api';
import { ResourcePage } from './ResourcePage';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, companyId: 1, permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }),
}));
vi.mock('./api', async original => {
  const actual = await original<typeof import('./api')>();
  return { ...actual, resourceApi: { ...actual.resourceApi, list: vi.fn(), categoryTree: vi.fn() } };
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('切换原装采购成品分类时，商品数量变化不会重载或替换目录', async () => {
  const product = (id: number, name: string): ResourceDto => ({
    id, title: name, type: 'finance-products', status: 'active', statusReason: null,
    data: { archiveType: 'purchased', supplyMode: 'original_purchase', name, basicInfoFullName: name },
    refLabels: {}, files: {}, secretConfigured: {}, createdAt: '', updatedAt: '',
  });
  vi.mocked(resourceApi.categoryTree).mockResolvedValue({
    field: 'categoryId', total: 30, uncategorized: 0,
    nodes: [
      { id: 1, title: '目录顶部', parentId: 0, status: 'active', sort: 1, count: 26 },
      { id: 2, title: '糯玉米种子', parentId: 0, status: 'active', sort: 2, count: 4 },
    ],
  });
  vi.mocked(resourceApi.list).mockImplementation(async (type, query) => {
    if (type !== 'finance-products') return { items: [], total: 0, page: 1, pageSize: 30 };
    const filtered = query?.filters?.categoryId === '2';
    return {
      items: [filtered ? product(2, '筛选后的成品') : product(1, '筛选前的成品')],
      total: filtered ? 4 : 30, page: 1, pageSize: 30,
    };
  });
  render(<MemoryRouter><ResourcePage type="finance-products" lockedTab="original_purchase" hier={{ title: '原装采购成品', subtitle: '', onBack: vi.fn() }} /></MemoryRouter>);

  await screen.findByText('筛选前的成品');
  const directory = screen.getByRole('complementary', { name: '分类目录' });
  const bottom = await within(directory).findByRole('button', { name: '糯玉米种子' });
  const directoryRequests = vi.mocked(resourceApi.categoryTree).mock.calls.length;

  fireEvent.click(bottom);
  expect(within(directory).getByRole('button', { name: '糯玉米种子' })).toBe(bottom);
  await screen.findByText('筛选后的成品');
  expect(within(directory).getByRole('button', { name: '糯玉米种子' })).toBe(bottom);
  expect(resourceApi.categoryTree).toHaveBeenCalledTimes(directoryRequests);
});
