import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { AppbarContext } from '../layout/AppbarSlot';

const auth = { user: { companyName: '某公司', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), categoryTree: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() } };
});
import { ArchiveHome } from './ArchiveHome';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('基础资料首页使用24号标题与卡片结构', () => {
  it('有顶栏时不重复渲染内容区大标题，保留说明和卡片', async () => {
    vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 3, page: 1, pageSize: 1, tabCounts: { raw: 2, self_made: 1 } } as never);
    const setBare = vi.fn();
    render(
      <MemoryRouter>
        <AppbarContext.Provider value={{ slot: document.createElement('div'), setBare }}><ArchiveHome type="finance-products" onEnter={() => undefined} /></AppbarContext.Provider>
      </MemoryRouter>,
    );
    await screen.findByText('原料档案');
    expect(screen.queryByRole('heading', { level: 1, name: '商品档案' })).toBeNull();
    expect(screen.getByText(/按原料、自产品/)).toBeTruthy();
    expect(setBare).toHaveBeenCalledWith(true);
  });

  it('卡片按名称、数量、说明、标识依次排列', async () => {
    vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 3, page: 1, pageSize: 1, tabCounts: { raw: 2 } } as never);
    render(<MemoryRouter><ArchiveHome type="finance-products" onEnter={() => undefined} /></MemoryRouter>);
    const card = (await screen.findByText('原料档案')).closest('.hier-card') as HTMLElement;
    await waitFor(() => expect(card.querySelector('.hier-card-count')?.textContent).toContain('2'));
    expect(card.querySelector('em')?.textContent).toBe('标识 YL');
  });
});
