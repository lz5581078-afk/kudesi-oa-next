import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { resourceApi } from './api';

const auth = { user: { companyName: '某公司', permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const pageProps = vi.fn();
vi.mock('./ResourcePage', () => ({ ResourcePage: (p: { hier?: { title: string; onBack: () => void }; lockedTab?: string }) => { pageProps(p); return <div><span>列表页</span><button onClick={p.hier?.onBack}>返回上一级</button></div>; } }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), categoryTree: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() } };
});
import { HierarchyPage } from './HierarchyPage';

const Where = () => <i data-testid="where">{useLocation().search}</i>;
const node = (id: number, title: string, count: number, sort = id * 10) => ({ id, title, status: 'active', parentId: 0, sort, count });
beforeEach(() => {
  vi.mocked(resourceApi.categoryTree).mockResolvedValue({ field: 'categoryIds', total: 5, uncategorized: 0, nodes: [node(1, '种子供应商', 3), node(2, '包装配套供应商', 2), { ...node(3, '蔬菜种子', 3), parentId: 1 }] } as never);
  vi.mocked(resourceApi.list).mockImplementation((async (type: string) => type === 'finance-supplier-categories'
    ? { items: [{ id: 1, title: '种子供应商', data: { subtitle: '种子相关供应商。' } }, { id: 2, title: '包装配套供应商', data: {} }], total: 2, page: 1, pageSize: 200 }
    : { items: [], total: 5, page: 1, pageSize: 1, tabCounts: { raw: 4, self_made: 2, original_purchase: 1 } }) as never);
  vi.mocked(resourceApi.get).mockResolvedValue({ id: 1, title: '种子供应商', data: { subtitle: '种子相关供应商。' } } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('四个财务档案共用的分级布局配置', () => {
  it('商品、供应商、客户、费用档案都配了 hierarchy，且分类树可就地管理', () => {
    for (const k of ['finance-products', 'finance-suppliers', 'finance-customers', 'finance-fee-items']) {
      const def = getResourceDef(k)!;
      expect(def.hierarchy, k).toBeTruthy();
      expect(def.treeManage?.length, k).toBeGreaterThan(0);
    }
    expect(getResourceDef('finance-products')!.hierarchy!.kind).toBe('tab');
    expect(getResourceDef('finance-suppliers')!.hierarchy!.categoryType).toBe('finance-supplier-categories');
  });
});

describe('供应商档案：顶级分类卡片 → 进入 → 返回上一级', () => {
  it('卡片只列顶级分类，带数量和说明；点进去把顶级分类 id 交给列表页，地址记下 g；返回后回到卡片', async () => {
    render(<MemoryRouter initialEntries={['/finance/finance-suppliers']}><HierarchyPage type="finance-suppliers" /><Where /></MemoryRouter>);
    const card = (await screen.findByText('种子供应商')).closest('.hier-card') as HTMLElement;
    expect(card.textContent).toContain('3');
    expect(card.textContent).toContain('种子相关供应商。');
    expect(screen.queryByText('蔬菜种子')).toBeNull(); // 下级不上卡片
    fireEvent.click(card);
    await screen.findByText('列表页');
    expect(screen.getByTestId('where').textContent).toBe('?g=1');
    expect(pageProps.mock.calls.at(-1)![0].hier).toMatchObject({ rootId: 1, title: '种子供应商', subtitle: '种子相关供应商。' });
    fireEvent.click(screen.getByText('返回上一级'));
    await screen.findByText('管理顶级分类');
    expect(screen.getByTestId('where').textContent).toBe('');
  });

  it('刷新时地址里只有 g：补查顶级分类名称再进入', async () => {
    render(<MemoryRouter initialEntries={['/finance/finance-suppliers?g=1']}><HierarchyPage type="finance-suppliers" /></MemoryRouter>);
    await screen.findByText('列表页');
    expect(resourceApi.get).toHaveBeenCalledWith('finance-supplier-categories', 1);
    expect(pageProps.mock.calls.at(-1)![0].hier).toMatchObject({ rootId: 1, title: '种子供应商' });
  });

  it('管理顶级分类：新增、改名、排序、删除都在卡片上；新增走分类资料的创建接口', async () => {
    vi.mocked(resourceApi.create).mockResolvedValue({ id: 9 } as never);
    render(<MemoryRouter initialEntries={['/finance/finance-suppliers']}><HierarchyPage type="finance-suppliers" /></MemoryRouter>);
    await screen.findByText('种子供应商');
    expect(screen.queryByRole('button', { name: /^编辑$/ })).toBeNull(); // 平时看不到分类维护按钮
    fireEvent.click(screen.getByRole('button', { name: '管理顶级分类' }));
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增顶级分类' }));
    fireEvent.change(screen.getByLabelText('分类名称'), { target: { value: '同行调货' } });
    fireEvent.click(screen.getByRole('button', { name: '保存分类' }));
    await waitFor(() => expect(resourceApi.create).toHaveBeenCalledWith('finance-supplier-categories', { name: '同行调货', subtitle: '' }));
    expect(screen.getAllByRole('button', { name: /^编辑$/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^删除$/ })).toHaveLength(2);
    expect((screen.getByRole('button', { name: '前移：种子供应商' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('商品档案：顶级是档案类型', () => {
  it('卡片取各档案类型的数量；外购成品拆成原装采购/供应商 OEM 两张；进入后锁定页签', async () => {
    render(<MemoryRouter initialEntries={['/finance/finance-products']}><HierarchyPage type="finance-products" /></MemoryRouter>);
    const raw = (await screen.findByText('原料档案')).closest('.hier-card') as HTMLElement;
    expect(raw.textContent).toContain('4');
    expect(screen.getByText('原装采购成品档案')).toBeTruthy();
    expect(screen.getByText(/供应商 OEM 成品档案/)).toBeTruthy();
    expect(screen.queryByText('外购成品档案')).toBeNull();
    fireEvent.click(raw);
    await screen.findByText('列表页');
    expect(pageProps.mock.calls.at(-1)![0].lockedTab).toBe('raw');
  });
});
