import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const formProps = vi.fn();
vi.mock('./RecordForm', () => ({ RecordForm: (p: { initial?: Record<string, unknown> }) => { formProps(p.initial); return <div>表单</div>; }, loadRefOptions: async () => [] }));
vi.mock('./CategoryTree', () => ({ CategoryTree: ({ tab }: { tab: string }) => <div data-testid="tree">{tab}</div> }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), users: vi.fn().mockResolvedValue([]) } };
});
import { ResourcePage } from './ResourcePage';

beforeEach(() => {
  vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, tabCounts: { raw: 4, original_purchase: 3, supplier_oem: 2 } } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('商品档案页签：外购成品拆成两个入口', () => {
  it('页签是 原装采购成品档案 / 供应商 OEM 成品档案，没有合并的外购成品，数量取各自的统计', async () => {
    render(<MemoryRouter><ResourcePage type="finance-products" /></MemoryRouter>);
    await screen.findByRole('tab', { name: /原装采购成品档案/ });
    await waitFor(() => expect(screen.getByRole('tab', { name: /原装采购成品档案/ }).textContent).toContain('3'));
    expect(screen.getByRole('tab', { name: /供应商 OEM 成品档案/ }).textContent).toContain('2');
    expect(screen.queryByRole('tab', { name: /^外购成品档案/ })).toBeNull();
  });

  it('点 OEM 页签：按页签值查询、分类目录跟着换；在页签下新建会预填档案类型和采购方式', async () => {
    render(<MemoryRouter><ResourcePage type="finance-products" /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('tab', { name: /供应商 OEM 成品档案/ }));
    await waitFor(() => expect(vi.mocked(resourceApi.list).mock.calls.some((c) => c[1]?.tab === 'supplier_oem')).toBe(true));
    expect((await screen.findByTestId('tree')).textContent).toBe('supplier_oem');
    fireEvent.click(screen.getByText('＋ 新增'));
    await screen.findByText('表单');
    expect(formProps).toHaveBeenLastCalledWith({ archiveType: 'purchased', supplyMode: 'supplier_oem' });
  });

  it('采购方式不再是列表上的下拉筛选', async () => {
    render(<MemoryRouter><ResourcePage type="finance-products" /></MemoryRouter>);
    await screen.findByRole('tab', { name: /原装采购成品档案/ });
    expect(screen.queryByRole('combobox', { name: '采购方式' })).toBeNull();
  });
});
