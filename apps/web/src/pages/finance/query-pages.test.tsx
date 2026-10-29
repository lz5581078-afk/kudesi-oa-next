import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryPage } from './InventoryPage';
import { SettlementDetailPage, UnsettledReceiptsPage } from './SettlementPages';
import { financeApi } from './financeApi';
import { QueryTable } from './query/QueryKit';

vi.mock('./financeApi', () => ({ financeApi: { inventory: vi.fn(), inventoryLedger: vi.fn(), unsettledReceipts: vi.fn(), settlementDetail: vi.fn() } }));
vi.mock('./common', async (orig) => ({ ...(await orig<typeof import('./common')>()), SearchPick: () => <input aria-label="仓库" readOnly /> }));
const fa = vi.mocked(financeApi);
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const stock = (productId: number, warehouseId: number, name: string, wh: string, qty: number, amount: number | null) => ({ code: `C${productId}`, unit: 'KG', productId, warehouseId, productName: name, warehouseName: wh, qty, avgCostCents: amount === null ? null : Math.round(amount / (qty || 1)), amountCents: amount });

describe('库存查询（统一查询页版式）', () => {
  it('汇总卡、按仓库分组带小计、重置会清空条件重新查询', async () => {
    fa.inventory.mockResolvedValue([stock(1, 1, '苹果', '一号仓', 10, 5000), stock(2, 1, '梨', '一号仓', 0, 0), stock(1, 2, '苹果', '二号仓', 5, 2500)]);
    render(<MemoryRouter><InventoryPage /></MemoryRouter>);
    const cards = await screen.findByLabelText('汇总');
    expect(within(cards).getByText('库存成本合计')).toBeTruthy();
    expect(within(cards).getByText('¥75.00')).toBeTruthy();
    expect(within(cards).getByText('缺货行数').nextSibling?.textContent).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: '按仓库' }));
    expect(screen.getByText('一号仓', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('2 个商品')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('商品'), { target: { value: '苹果 KG' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await waitFor(() => expect(fa.inventory).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '苹果 KG' })));
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() => expect(fa.inventory).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: undefined })));
    expect((screen.getByLabelText('商品') as HTMLInputElement).value).toBe('');
  });
  it('服务端没给成本（无权限）时没有成本列和成本卡', async () => {
    fa.inventory.mockResolvedValue([stock(1, 1, '苹果', '一号仓', 10, null)]);
    render(<MemoryRouter><InventoryPage /></MemoryRouter>);
    await screen.findByText('苹果');
    expect(screen.queryByRole('columnheader', { name: '库存成本' })).toBeNull();
    expect(screen.queryByText('库存成本合计')).toBeNull();
  });
  it('点“流水”按商品+仓库取流水，并能点单号打开原单据', async () => {
    fa.inventory.mockResolvedValue([stock(1, 1, '苹果', '一号仓', 10, 5000)]);
    fa.inventoryLedger.mockResolvedValue({ rows: [{ id: 1, entryDate: '2026-10-20', documentId: 9, docNo: 'CG001', typeLabel: '采购入库单', partyName: '果园', memo: null, qty: 10, balanceQty: 10, amountCents: 5000, balanceAmountCents: 5000 }], inQty: 10, outQty: 0, closingQty: 10, closingAmountCents: 5000 });
    render(<MemoryRouter><InventoryPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '流水' }));
    expect(await screen.findByText('CG001')).toBeTruthy();
    expect(fa.inventoryLedger).toHaveBeenCalledWith({ productId: 1, warehouseId: 1, asOf: undefined });
    expect(screen.getByText('累计入库')).toBeTruthy();
  });
});

describe('收付款两张查询表', () => {
  it('未完全结算：汇总卡、关键词本地筛选、按往来对象分组、重置', async () => {
    fa.unsettledReceipts.mockResolvedValue([
      { id: 1, docNo: 'SK1', typeLabel: '收款单', docDate: '2026-10-27', partyName: '甲客户', settleByLabel: '按金额', totalCents: 30000, allocatedCents: 0, unallocatedCents: 30000 },
      { id: 2, docNo: 'FK2', typeLabel: '付款单', docDate: '2026-10-28', partyName: '乙供应商', settleByLabel: '按单据', totalCents: 27000, allocatedCents: 20000, unallocatedCents: 7000 },
    ]);
    render(<MemoryRouter><UnsettledReceiptsPage /></MemoryRouter>);
    const cards = await screen.findByLabelText('汇总');
    expect(within(cards).getByText('¥370.00')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '乙供应商' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await waitFor(() => expect(screen.queryByText('SK1')).toBeNull());
    expect(screen.getByText('FK2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await screen.findByText('SK1');
    fireEvent.click(screen.getByRole('button', { name: '按往来对象' }));
    expect(screen.getByText('甲客户', { selector: 'strong' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('单据类型'), { target: { value: 'receipt' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await waitFor(() => expect(fa.unsettledReceipts).toHaveBeenLastCalledWith(expect.objectContaining({ docType: 'receipt' })));
  });
  it('结算明细：合计与空状态', async () => {
    fa.settlementDetail.mockResolvedValue([{ id: 1, docId: 1, docNo: 'SK1', typeLabel: '收款单', docDate: '2026-10-28', partyName: '甲', settleByLabel: '按单据', sourceDocId: 2, sourceDocNo: 'XS1', sourceTypeLabel: '销售单', productName: '苹果', amountCents: 40000 }]);
    render(<MemoryRouter><SettlementDetailPage /></MemoryRouter>);
    const cards = await screen.findByLabelText('汇总');
    expect(within(cards).getByText('¥400.00')).toBeTruthy();
    fa.settlementDetail.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText('这段时间没有按单据/按商品结算的收付款单')).toBeTruthy();
  });
});

describe('QueryTable 手机宽度', () => {
  it('窄屏换成卡片列表，操作列放卡片底部', () => {
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as never;
    render(<QueryTable rows={[{ id: 1, n: 'A', v: 5 }]} rowKey={(r) => r.id} empty="空" cols={[{ key: 'n', head: '名称', primary: true, cell: (r) => r.n }, { key: 'v', head: '数值', num: true, cell: (r) => r.v, sum: () => '5' }, { key: 'op', head: '操作', action: true, cell: () => <button type="button">办理</button> }]} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByText('数值').length).toBe(2);
    expect(screen.getByRole('button', { name: '办理' })).toBeTruthy();
    expect(screen.getByText('合计（1 行）')).toBeTruthy();
  });
});
