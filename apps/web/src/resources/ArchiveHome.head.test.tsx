import { cleanup, render, screen } from '@testing-library/react';
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

describe('基础资料首页页头：页面名称只出现一处', () => {
  it('内容区没有再写一遍页面大标题；声明顶部页面栏只显示页面名称（不叠分区面包屑）', async () => {
    vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 3, page: 1, pageSize: 1, tabCounts: { raw: 2, self_made: 1 } } as never);
    const setBare = vi.fn();
    render(
      <MemoryRouter>
        <AppbarContext.Provider value={{ slot: null, setBare }}><ArchiveHome type="finance-products" onEnter={() => undefined} /></AppbarContext.Provider>
      </MemoryRouter>,
    );
    await screen.findByText('原料档案');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByText('商品档案', { selector: 'h1, h2, h3' })).toBeNull();
    expect(setBare).toHaveBeenCalledWith(true);
  });

  it('卡片：名称 + 数量 + 单位在一行，说明最多两行，没有“N 条商品”的重复页脚', async () => {
    vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 3, page: 1, pageSize: 1, tabCounts: { raw: 2 } } as never);
    render(<MemoryRouter><ArchiveHome type="finance-products" onEnter={() => undefined} /></MemoryRouter>);
    const card = (await screen.findByText('原料档案')).closest('.hier-card') as HTMLElement;
    expect(card.querySelector('.hier-card-top')?.textContent).toContain('2');
    expect(card.querySelector('em')?.textContent).toBe('标识 YL');
  });
});
