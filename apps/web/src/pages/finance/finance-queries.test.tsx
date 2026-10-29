import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChecker } from '@kudesi/shared';
import { CashBankPage } from './CashBankPage';
import { DocumentsPage } from './DocumentsPage';
import { FinanceOverviewPage } from './FinanceOverviewPage';
import { InventoryPage } from './InventoryPage';
import { Shops } from './StoreWithdrawalPage';
import { financeApi } from './financeApi';
import { makeSessionApi } from './sessionApi';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: '测试员' }, loading: false, can: createChecker({ isCompanyAdmin: true, allow: [], deny: [] }) }),
}));
vi.mock('./financeApi', () => ({
  financeApi: { overview: vi.fn(), docs: vi.fn(), banks: vi.fn(), storeFunds: vi.fn(), keyAccounts: vi.fn(), setKeyAccount: vi.fn(), ledger: vi.fn(), inventory: vi.fn() },
}));
const fa = vi.mocked(financeApi);
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('财务经营', () => {
  const overview = (month: string) => ({
    month, trend: [{ date: month === 'all' ? '2026-03' : '2026-03-10', revenueCents: 10000, expenseCents: 0, profitCents: 5000 }], trendBy: month === 'all' ? 'month' as const : 'day' as const,
    stores: [{ storeId: 1, name: '甲店', licenseName: '主体甲公司', salesCents: 10000, adCostCents: 100, profitCents: 6000 }],
    ledger: [{ date: '2026-03-10', direction: 'out' as const, kind: 'expense', amountCents: 700, documentId: 3, docNo: 'FY1', docType: 'expense', storeName: '甲店', source: '流程自动记账' }],
    revenueCents: 10000, cogsCents: 4000, grossProfitCents: 6000, expenseCents: 700, otherIncomeCents: 0, netProfitCents: 5300, receivableCents: 0, payableCents: 0, advanceReceiptCents: 0, prepaymentCents: 0, bankCents: 1000, drafts: 0, issued: 0,
  });
  it('店铺利润有主体列，台账有店铺和来源列；勾选“全部时间”用 all 重新查，趋势改按月', async () => {
    fa.overview.mockImplementation(async (m) => overview(m ?? '2026-03'));
    render(<MemoryRouter><FinanceOverviewPage /></MemoryRouter>);
    expect(await screen.findByText('主体甲公司')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '主体' })).toBeTruthy();
    expect(screen.getAllByRole('columnheader', { name: '店铺' }).length).toBe(2); // 店铺利润表和台账各一列
    expect(screen.getByRole('columnheader', { name: '来源' })).toBeTruthy();
    expect(screen.getByText('流程自动记账')).toBeTruthy();
    expect(screen.getByText('利润趋势（按日）')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('全部时间'));
    await screen.findByText('利润趋势（按月）');
    expect(fa.overview).toHaveBeenLastCalledWith('all');
    expect(screen.queryByLabelText('月份')).toBeNull();
    expect(screen.getByText(/全部时间 经营情况/)).toBeTruthy();
  });
});

describe('经营历程', () => {
  it('有收支方向筛选、汇总条（数量/收入/支出/净额）和来源列', async () => {
    fa.docs.mockResolvedValue({ total: 2, amountCents: 0, paidCents: 0, incomeCents: 50000, expenseCents: 20000, page: 1, pageSize: 20, rows: [
      { id: 1, docNo: 'XS1', docType: 'sale', typeLabel: '普通销售单', status: 'posted', docDate: '2026-03-10', amountCents: 50000, paidCents: 0, bankName: null, handler: null, auditedAt: null, createdBy: 1, memo: null, reversesId: null, partyName: '老客户', createdByName: '老板', direction: 'in', source: '手工制单' },
      { id: 2, docNo: 'FY1', docType: 'expense', typeLabel: '费用单', status: 'posted', docDate: '2026-03-10', amountCents: 20000, paidCents: 0, bankName: null, handler: null, auditedAt: null, createdBy: 1, memo: null, reversesId: null, partyName: null, createdByName: '老板', direction: 'out', source: '流程自动记账' },
    ] });
    render(<MemoryRouter><DocumentsPage scope="history" /></MemoryRouter>);
    const bar = await screen.findByLabelText('汇总');
    expect(within(bar).getByText('2 条')).toBeTruthy();
    expect(within(bar).getByText('¥500.00')).toBeTruthy();
    expect(within(bar).getByText('¥200.00')).toBeTruthy();
    expect(within(bar).getByText('¥300.00')).toBeTruthy(); // 净额
    expect(screen.getByRole('columnheader', { name: '来源' })).toBeTruthy();
    expect(screen.getByText('流程自动记账')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('收支方向'), { target: { value: 'out' } });
    await waitFor(() => expect(fa.docs).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'history', direction: 'out' })));
  });
  it('草稿中心没有收支方向筛选和来源列', async () => {
    fa.docs.mockResolvedValue({ total: 0, amountCents: 0, paidCents: 0, page: 1, pageSize: 20, rows: [] });
    render(<MemoryRouter><DocumentsPage scope="drafts" /></MemoryRouter>);
    await screen.findByText('没有单据');
    expect(screen.queryByLabelText('收支方向')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: '来源' })).toBeNull();
  });
});

describe('库存查询', () => {
  it('库存状态可选“缺货”，按 out 重新查询', async () => {
    fa.inventory.mockResolvedValue([]);
    render(<MemoryRouter><InventoryPage /></MemoryRouter>);
    await waitFor(() => expect(fa.inventory).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('库存状态'), { target: { value: 'out' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' })); // 改条件后点“查询”才发请求（对齐旧版）
    await waitFor(() => expect(fa.inventory).toHaveBeenLastCalledWith(expect.objectContaining({ stockStatus: 'out' })));
    expect(screen.getByText('没有符合条件的库存，请调整条件后重新查询')).toBeTruthy();
  });
});

describe('现金银行查询', () => {
  const recent = new Date(Date.now() - 3600_000).toISOString(), old = new Date(Date.now() - 40 * 86400_000).toISOString();
  const acct = (id: number, title: string, kind: string, extra = {}) => ({ id, title, kind, status: 'normal', openingCents: 0, movementCents: 0, balanceCents: 10000 * id, entries: 0, bank: '测试银行', updatedAt: recent, storeIds: [], storeNames: [], ...extra });
  beforeEach(() => {
    fa.banks.mockResolvedValue([acct(1, '招行主户', 'company_public'), acct(2, '拼店收款户', 'store_public', { storeIds: [11], storeNames: ['拼店'], updatedAt: old })]);
    fa.storeFunds.mockResolvedValue([
      { storeId: 11, name: '拼店', storeNo: 'S1', platform: 'pdd', platformLabel: '拼多多', snapshotDate: '2026-03-10', updatedAt: recent, withdrawableCents: 5000, depositCents: 0, frozenCents: 0, promotionCents: 0 },
      { storeId: 12, name: '淘店', storeNo: 'S2', platform: 'taobao', platformLabel: '淘宝', snapshotDate: '', updatedAt: null, withdrawableCents: 700, depositCents: 0, frozenCents: 0, promotionCents: 0 },
    ]);
    fa.keyAccounts.mockResolvedValue([1]);
    fa.setKeyAccount.mockImplementation(async (id, on) => (on ? [1, id] : [1].filter((x) => x !== id)));
  });
  it('重点账户单独一栏；设为重点/取消重点会保存；平台分页签筛店铺；查看账户能看到关联账户；更新时间按新旧着色', async () => {
    render(<MemoryRouter><CashBankPage /></MemoryRouter>);
    expect(await screen.findByText('招行主户')).toBeTruthy(); // 重点账户里
    expect(screen.getByText('重点账户', { selector: 'h2' })).toBeTruthy();
    // 展开店铺公户，设为重点
    fireEvent.click(screen.getAllByRole('button', { name: /展开 1 个账户/ })[0]); // 第一个是店铺收款账户
    const row = (await screen.findByText('拼店收款户')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: '查看店铺' }));
    expect(within(await screen.findByRole('dialog')).getByText('拼店')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    const stale = within(row).getByTitle('超过 30 天没更新');
    expect(stale.className).toContain('bad');
    fireEvent.click(within(row).getByRole('button', { name: '设为重点' }));
    await waitFor(() => expect(fa.setKeyAccount).toHaveBeenCalledWith(2, true));
    // 店铺资金：平台页签
    fireEvent.click(screen.getByRole('button', { name: /展开 2 个店铺/ }));
    expect(screen.getByText(/拼多多 \/ 拼店/)).toBeTruthy();
    expect(screen.getByText(/淘宝 \/ 淘店/)).toBeTruthy();
    expect(screen.getByText('未记录')).toBeTruthy(); // 淘店没有更新记录
    fireEvent.click(screen.getByRole('tab', { name: /^淘宝/ }));
    expect(screen.queryByText(/拼多多 \/ 拼店/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^全部店铺/ }));
    const storeRow = screen.getByText(/拼多多 \/ 拼店/).closest('tr')!;
    fireEvent.click(within(storeRow).getByRole('button', { name: '查看账户' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('拼店收款户')).toBeTruthy();
    expect(within(dlg).queryByText('招行主户')).toBeNull();
  });
});

describe('店铺提现的店铺列表', () => {
  const shop = (id: number, over = {}) => ({ id, storeId: id, storeName: `店${id}`, platform: 'pdd', platformLabel: '拼多多', storeNo: `S${id}`, platformStoreId: `PID${id}`, operatorName: '小王', deviceId: 7, deviceName: '财务电脑', deviceStatus: 'online' as const, loginAccount: 'a', hasPassword: true, autoLogin: true, loginState: 'valid' as const, lastVerifiedAt: null, lastOpenedAt: '2026-03-10T02:00:00.000Z', activeRequest: null, request: { id: 1, kind: 'now', status: 'succeeded', percent: 100, step: '已打开店铺', errorText: null, at: '2026-03-10T02:00:00.000Z' }, ...over });
  it('列出平台店铺ID、当前运营、最近打开、进度；搜索/筛选/排序/翻页都把条件交给服务器', async () => {
    const overview = vi.fn().mockResolvedValue({ canManage: true, total: 120, page: 1, pageSize: 50, pageCount: 3, shops: [shop(1), shop(2, { request: { id: 2, kind: 'first', status: 'claimed', percent: 60, step: '助手正在打开店铺', errorText: null, at: '2026-03-10T02:00:00.000Z' }, activeRequest: { id: 2, kind: 'first', status: 'claimed' } })] });
    const client = { ...makeSessionApi('/session'), overview, devices: vi.fn().mockResolvedValue([{ id: 7, name: '财务电脑', deviceNo: 'X', os: null, agentVersion: '1.0.0', status: 'active', online: true, lastSeenAt: null, shopCount: 2 }]) };
    render(<MemoryRouter><Shops client={client} /></MemoryRouter>);
    expect(await screen.findByText('PID1')).toBeTruthy();
    for (const h of ['平台店铺ID', '当前运营', '最近打开', '进度']) expect(screen.getByRole('columnheader', { name: new RegExp(h) })).toBeTruthy();
    expect(screen.getAllByText('小王').length).toBe(2);
    expect(screen.getByText('已打开店铺')).toBeTruthy();
    expect(screen.getByText('60%')).toBeTruthy();
    expect(screen.getByText(/已加入 120 家店铺/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('登录状态'), { target: { value: 'expired' } });
    await waitFor(() => expect(overview).toHaveBeenLastCalledWith(expect.objectContaining({ loginState: 'expired', page: 1 })));
    fireEvent.change(screen.getByLabelText('负责电脑'), { target: { value: 'none' } });
    await waitFor(() => expect(overview).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: 'none' })));
    fireEvent.click(screen.getByRole('button', { name: /平台/ }));
    await waitFor(() => expect(overview).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'platform_asc' })));
    fireEvent.click(screen.getByRole('button', { name: /当前运营/ }));
    await waitFor(() => expect(overview).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'operator_asc' })));
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(overview).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
    fireEvent.change(screen.getByLabelText('搜索店铺'), { target: { value: 'PID9' } });
    await waitFor(() => expect(overview).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: 'PID9', page: 1 })), { timeout: 2000 });
  });
});
