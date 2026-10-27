import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChecker } from '@kudesi/shared';
import { DocForm } from './DocForm';
import { DocumentsPage } from './DocumentsPage';
import { FinanceOverviewPage } from './FinanceOverviewPage';
import { InlineCred, ShopDrawer } from './ShopInline';
import { financeApi } from './financeApi';
import type { SessionClient, ShopRow } from './sessionApi';
import { resourceApi } from '../../resources/api';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: '测试员' }, loading: false, can: createChecker({ isCompanyAdmin: true, allow: [], deny: [] }) }),
}));
vi.mock('./financeApi', () => ({
  financeApi: { overview: vi.fn(), docs: vi.fn(), banks: vi.fn(), doc: vi.fn(), openItems: vi.fn(), syncEmployees: vi.fn(), create: vi.fn(), issue: vi.fn(), post: vi.fn(), update: vi.fn() },
}));
vi.mock('../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../resources/api')>()), resourceApi: { list: vi.fn(), get: vi.fn() } }));
const fa = vi.mocked(financeApi);
beforeEach(() => { vi.clearAllMocks(); window.localStorage.clear(); fa.banks.mockResolvedValue([]); vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 15 } as never); });
afterEach(cleanup);

describe('金额类单据：多行明细', () => {
  it('收款单可以加多行，合计是各行之和，提交的是整数分明细', async () => {
    fa.create.mockResolvedValue({ id: 1, docNo: 'SK1' } as never);
    render(<DocForm type="receipt" inline onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('第1行金额'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText(/^第1行(?!金额|备注)/), { target: { value: '货款' } });
    fireEvent.click(screen.getByRole('button', { name: '+ 加一行' }));
    fireEvent.change(screen.getByLabelText('第2行金额'), { target: { value: '7.5' } });
    fireEvent.change(screen.getByLabelText(/^第2行(?!金额|备注)/), { target: { value: '运费' } });
    expect(document.querySelector('.slip-foot-total')!.textContent).toContain('¥20.00');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(fa.create).toHaveBeenCalled());
    const body = fa.create.mock.calls[0][0] as { lines: { itemName: string; unitPriceCents: number }[] };
    expect(body.lines.map((l) => [l.itemName, l.unitPriceCents])).toEqual([['货款', 1250], ['运费', 750]]);
  });
});

describe('开单明细单位', () => {
  it('商品行有单位列，可手填', () => {
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('第1行单位'), { target: { value: '箱' } });
    expect((screen.getByLabelText('第1行单位') as HTMLInputElement).value).toBe('箱');
  });
});

describe('财务经营：任意起止日期', () => {
  it('填起止日期后按日期区间查询', async () => {
    fa.overview.mockResolvedValue({ month: '2026-10', from: '2026-10-01', to: '2026-10-27', trendBy: 'day', trend: [], stores: [], ledger: [], revenueCents: 0, cogsCents: null, grossProfitCents: null, expenseCents: 0, otherIncomeCents: 0, netProfitCents: null, receivableCents: 0, payableCents: 0, advanceReceiptCents: 0, prepaymentCents: 0, bankCents: null, drafts: 0, issued: 0 } as never);
    render(<MemoryRouter><FinanceOverviewPage /></MemoryRouter>);
    await waitFor(() => expect(fa.overview).toHaveBeenCalled());
    fireEvent.change(await screen.findByLabelText('开始日期'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-09-20' } });
    await waitFor(() => expect(fa.overview).toHaveBeenLastCalledWith(undefined, { from: '2026-09-01', to: '2026-09-20' }));
  });
});

describe('草稿中心', () => {
  it('显示后端统计的今日新增草稿', async () => {
    fa.docs.mockResolvedValue({ total: 30, amountCents: 0, paidCents: 0, page: 1, pageSize: 20, rows: [], todayCount: 4 } as never);
    render(<MemoryRouter><DocumentsPage scope="drafts" /></MemoryRouter>);
    expect(await screen.findByText('今日新增草稿')).toBeTruthy();
    expect(await screen.findByText('4 张')).toBeTruthy();
  });
});

const shop = { id: 3, storeId: 9, storeName: '一号店', platform: 'pdd', deviceId: null, deviceName: '', deviceStatus: 'none', loginAccount: 'a1', hasPassword: true, autoLogin: false, loginState: 'none', lastVerifiedAt: null, activeRequest: null } as ShopRow;
const client = () => ({ updateShop: vi.fn().mockResolvedValue({}), reveal: vi.fn().mockResolvedValue({ account: 'a1', password: 'p@ss' }), history: vi.fn().mockResolvedValue([]) }) as unknown as SessionClient & { updateShop: ReturnType<typeof vi.fn>; reveal: ReturnType<typeof vi.fn> };

describe('店铺提现：行内账号密码与详情', () => {
  it('改账号失去焦点即保存；输入新密码回车保存；密码默认不显示，点查看才取明文', async () => {
    const c = client(); const changed = vi.fn();
    render(<InlineCred client={c} shop={shop} onChanged={changed} onError={vi.fn()} />);
    expect(screen.queryByText('p@ss')).toBeNull();
    const acc = screen.getByLabelText('一号店 登录账号');
    fireEvent.change(acc, { target: { value: 'a2' } }); fireEvent.blur(acc);
    await waitFor(() => expect(c.updateShop).toHaveBeenCalledWith(3, { loginAccount: 'a2' }));
    const pw = screen.getByLabelText('一号店 登录密码') as HTMLInputElement;
    expect(pw.value).toBe('');
    fireEvent.change(pw, { target: { value: 'newpw' } }); fireEvent.keyDown(pw, { key: 'Enter' });
    await waitFor(() => expect(c.updateShop).toHaveBeenCalledWith(3, { loginPassword: 'newpw' }));
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(await screen.findByText('p@ss')).toBeTruthy();
    expect(c.reveal).toHaveBeenCalledWith(3);
  });
  it('店铺详情抽屉：显示信息和登录记录，记录多时可加载更多', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, kind: 'first', status: 'succeeded', createdAt: '2026-10-01T00:00:00Z', deviceName: '电脑A', requestedByName: '小王', errorText: null }));
    const c = client(); (c.history as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    render(<ShopDrawer client={c} shop={shop} canManage onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByText('一号店 · 店铺详情')).toBeTruthy();
    await screen.findByRole('button', { name: /加载更多/ });
    expect(screen.getAllByText('小王').length).toBe(10);
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    await waitFor(() => expect(screen.getAllByText('小王').length).toBe(12));
  });
});
