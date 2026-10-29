import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChecker } from '@kudesi/shared';
import { DocForm } from './DocForm';
import { DocumentsPage } from './DocumentsPage';
import { FinanceOverviewPage } from './FinanceOverviewPage';
import { CopyButton, DATE_PRESETS, activePreset } from './fin-ui';
import { financeApi } from './financeApi';
import { resourceApi } from '../../resources/api';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: '测试员' }, loading: false, can: createChecker({ isCompanyAdmin: true, allow: [], deny: [] }) }),
}));
vi.mock('./financeApi', () => ({
  financeApi: { overview: vi.fn(), docs: vi.fn(), banks: vi.fn(), doc: vi.fn(), openItems: vi.fn(), syncEmployees: vi.fn(), create: vi.fn(), issue: vi.fn(), post: vi.fn(), update: vi.fn() },
}));
vi.mock('../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../resources/api')>()), resourceApi: { list: vi.fn(), get: vi.fn() } }));
const fa = vi.mocked(financeApi);
beforeEach(() => { vi.clearAllMocks(); window.localStorage.clear(); });
afterEach(cleanup);

const emptyList = { total: 0, amountCents: 0, paidCents: 0, page: 1, pageSize: 20, rows: [] };

describe('日期快捷区间', () => {
  it('今天/近7天/本月/上月/全部 都能被识别回来', () => {
    for (const p of DATE_PRESETS) { const [a, b] = p.range(); expect(activePreset(a, b)).toBe(p.key); }
  });
});

describe('复制按钮', () => {
  it('点一下把文字写进剪贴板并显示已复制', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    render(<CopyButton text="XS20260101001" label="单号" />);
    fireEvent.click(screen.getByRole('button', { name: '复制单号' }));
    await screen.findByText('已复制');
    expect(write).toHaveBeenCalledWith('XS20260101001');
  });
});

describe('经营历程 / 草稿中心筛选', () => {
  it('日期快捷按钮会带着日期重新查询，并记住筛选，下次打开还在', async () => {
    fa.docs.mockResolvedValue(emptyList);
    const { unmount } = render(<MemoryRouter><DocumentsPage scope="history" /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '本月' }));
    const [from] = DATE_PRESETS.find((p) => p.key === 'month')!.range();
    await waitFor(() => expect(fa.docs).toHaveBeenLastCalledWith(expect.objectContaining({ from })));
    unmount();
    render(<MemoryRouter><DocumentsPage scope="history" /></MemoryRouter>);
    expect((screen.getByLabelText('开始日期') as HTMLInputElement).value).toBe(from);
    expect(screen.getByRole('button', { name: '本月' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('点收入合计只看收入；有筛选时空结果提示放宽条件，重置后恢复', async () => {
    fa.docs.mockResolvedValue({ ...emptyList, incomeCents: 100, expenseCents: 50 });
    render(<MemoryRouter><DocumentsPage scope="history" /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /收入合计/ }));
    await waitFor(() => expect(fa.docs).toHaveBeenLastCalledWith(expect.objectContaining({ direction: 'in' })));
    await screen.findByText(/当前条件下没有单据/);
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    await waitFor(() => expect(fa.docs).toHaveBeenLastCalledWith(expect.objectContaining({ direction: undefined })));
  });
  it('单号旁有复制按钮', async () => {
    fa.docs.mockResolvedValue({ ...emptyList, total: 1, rows: [{ id: 1, docNo: 'FK1', docType: 'payment', typeLabel: '付款单', status: 'draft', docDate: '2026-03-10', amountCents: 100, paidCents: 0, bankName: null, handler: null, auditedAt: null, createdBy: 1, memo: null, reversesId: null, partyName: null, createdByName: '老板' }] as never });
    render(<MemoryRouter><DocumentsPage scope="drafts" /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: '复制单号 FK1' })).toBeTruthy();
  });
});

describe('财务经营', () => {
  it('点销售收入：把当前月份和“收入”写进经营历程筛选并跳转', async () => {
    fa.overview.mockResolvedValue({ month: '2026-03', trend: [], stores: [{ storeId: 1, name: '甲店', salesCents: 10000, adCostCents: 0, profitCents: 2500 }], ledger: [], revenueCents: 10000, cogsCents: 4000, grossProfitCents: 6000, expenseCents: 700, otherIncomeCents: 0, netProfitCents: 5300, receivableCents: 0, payableCents: 0, advanceReceiptCents: 0, prepaymentCents: 0, bankCents: 1000, drafts: 0, issued: 0 } as never);
    render(<MemoryRouter initialEntries={['/finance/overview']}><Routes><Route path="/finance/overview" element={<FinanceOverviewPage />} /><Route path="/finance/history" element={<div>历程页</div>} /></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /销售收入/ }));
    await screen.findByText('历程页');
    const saved = JSON.parse(window.localStorage.getItem('oa.finance.history.filters.v1')!);
    expect(saved.direction).toBe('in');
    expect(saved.from).toMatch(/-01$/);
    expect(screen.queryByText('25.0%')).toBeNull();
  });
  it('店铺利润有利润率列', async () => {
    fa.overview.mockResolvedValue({ month: '2026-03', trend: [], stores: [{ storeId: 1, name: '甲店', salesCents: 10000, adCostCents: 0, profitCents: 2500 }], ledger: [], revenueCents: 10000, cogsCents: 4000, grossProfitCents: 6000, expenseCents: 700, otherIncomeCents: 0, netProfitCents: 5300, receivableCents: 0, payableCents: 0, advanceReceiptCents: 0, prepaymentCents: 0, bankCents: 1000, drafts: 0, issued: 0 } as never);
    render(<MemoryRouter><FinanceOverviewPage /></MemoryRouter>);
    expect(await screen.findByText('25.0%')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '利润率' })).toBeTruthy();
  });
});

describe('开单页细节', () => {
  const stock = (type: string) => ({ items: [{ id: 7, title: type === 'bank-accounts' ? '现金户' : '老客户', status: 'active', data: {}, type }], total: 1, page: 1, pageSize: 15 });
  beforeEach(() => {
    vi.mocked(resourceApi.list).mockImplementation((async (type: string) => stock(type)) as never);
    fa.banks.mockResolvedValue([{ id: 7, title: '现金户', kind: 'cashier_account', status: 'normal', openingCents: 0, movementCents: 0, balanceCents: 1000, entries: 0 }]);
  });
  it('付款单：选了付款账户后显示账户余额和付后余额；余额为负时过账前确认并可取消', async () => {
    fa.create.mockResolvedValue({ id: 1, docNo: 'FK1' } as never);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DocForm type="payment" inline onSaved={vi.fn()} />);
    fireEvent.focus(screen.getByLabelText('付款账户'));
    fireEvent.click(await screen.findByRole('option', { name: '现金户' }));
    fireEvent.change(screen.getByLabelText('第1行金额'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/^第1行(?!金额|备注)/), { target: { value: '货款' } });
    const hint = await screen.findByLabelText('账户余额预览');
    expect(hint.textContent).toContain('¥10.00');
    expect(hint.textContent).toContain('¥-40.00');
    fireEvent.focus(screen.getByLabelText('收款方'));
    fireEvent.click(await screen.findByRole('option', { name: '老客户' }));
    fireEvent.click(screen.getByRole('button', { name: '保存并开立' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(String(confirm.mock.calls[0][0])).toContain('余额不足');
    expect(fa.create).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
  it('商品明细：最后一行按回车自动加一行；只剩一行时删除变成清空', async () => {
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    const before = screen.getAllByLabelText(/行单价$/).length;
    fireEvent.keyDown(screen.getAllByLabelText(/行备注$/)[before - 1], { key: 'Enter' });
    await waitFor(() => expect(screen.getAllByLabelText(/行单价$/).length).toBe(before + 1));
    expect(screen.getByText(/共 0 种商品/)).toBeTruthy();
    cleanup();
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getAllByRole('button', { name: /^删除第1行$/ })[0]);
    expect(screen.getAllByLabelText(/行单价$/).length).toBe(1);
    expect(screen.getByRole('button', { name: '删除第1行' }).textContent).toBe('清空');
  });
  it('收款金额比单据少时提示还差多少未结清；底部一直显示本单合计', async () => {
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('第1行数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('第1行单价'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '收了部分款' }));
    fireEvent.change(screen.getByLabelText('收到金额', { selector: 'input' }), { target: { value: '5' } });
    expect((await screen.findByText(/本单还差 ¥15.00 未结清/)).textContent).toContain('挂应收');
    expect(document.querySelector('.slip-foot-total')!.textContent).toContain('¥20.00');
  });
  it('转款单：能互换转出/转入账户', async () => {
    render(<DocForm type="transfer" inline onSaved={vi.fn()} />);
    fireEvent.focus(screen.getByLabelText('添加转出账户'));
    fireEvent.click(await screen.findByRole('option', { name: '现金户' }));
    expect(screen.getByText('还没有选转入账户')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /互换转出\/转入/ }));
    expect(screen.getByText('还没有选转出账户')).toBeTruthy();
  });
});
