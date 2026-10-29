import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocForm } from './DocForm';
import { VoucherPage } from './VoucherPage';
import { financeApi, type DocDetailDto } from './financeApi';
import { resourceApi } from '../../resources/api';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: { id: 1, name: '老板' } }) }));
vi.mock('./financeApi', async (orig) => ({
  ...(await orig<typeof import('./financeApi')>()),
  financeApi: { docs: vi.fn(), doc: vi.fn(), openItems: vi.fn(), syncEmployees: vi.fn(), banks: vi.fn(), create: vi.fn(), update: vi.fn(), issue: vi.fn(), post: vi.fn(), partyBalance: vi.fn(), lineHints: vi.fn() },
}));
vi.mock('../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../resources/api')>()), resourceApi: { list: vi.fn(), get: vi.fn() } }));
const fa = vi.mocked(financeApi);
const item = (id: number, title: string, type: string) => ({ id, title, status: 'active', data: {}, type });
beforeEach(() => {
  vi.mocked(resourceApi.list).mockImplementation((async (type: string) => ({ items: [item(type === 'finance-products' ? 3 : type === 'bank-accounts' ? 5 : type === 'finance-warehouses' ? 9 : 7, type === 'finance-products' ? '小油菜' : type === 'bank-accounts' ? '现金户' : type === 'finance-warehouses' ? '总仓' : '老客户', type)], total: 1, page: 1, pageSize: 15 })) as never);
  vi.mocked(resourceApi.get).mockResolvedValue({ data: {} } as never);
  fa.banks.mockResolvedValue([]);
  fa.docs.mockResolvedValue({ total: 0, rows: [], amountCents: 0, paidCents: 0, page: 1, pageSize: 20 } as never);
  fa.partyBalance.mockResolvedValue({ partyId: 7, partyKind: 'customer', name: '老客户', receivableCents: 50000, payableCents: 0, advanceReceiptCents: 20000, prepaymentCents: 0, creditLimitCents: 60000, overLimit: false });
  fa.lineHints.mockResolvedValue([{ productId: 3, stockQty: 5, lastPurchaseCents: 1200, lastSaleCents: 2500 }]);
  fa.create.mockResolvedValue({ id: 1, docNo: 'XS1' } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const pickProduct = async (row = 1) => {
  fireEvent.focus(screen.getByLabelText(`第${row}行商品`));
  fireEvent.click(await screen.findByRole('option', { name: '小油菜' }));
};

describe('明细网格键盘录入', () => {
  it('回车在同一行逐格前进，最后一格回车加一行并停在新行；Shift+Delete 删当前行', async () => {
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    const qty = screen.getByLabelText('第1行数量');
    qty.focus();
    fireEvent.keyDown(qty, { key: 'Enter' });
    expect(document.activeElement).toBe(screen.getByLabelText('第1行单价'));
    const rows = screen.getAllByLabelText(/行备注$/).length;
    const lastMemo = screen.getAllByLabelText(/行备注$/)[rows - 1];
    lastMemo.focus();
    fireEvent.keyDown(lastMemo, { key: 'Enter' });
    await waitFor(() => expect(screen.getAllByLabelText(/行备注$/).length).toBe(rows + 1));
    fireEvent.keyDown(screen.getByLabelText('第2行数量'), { key: 'Delete', shiftKey: true });
    await waitFor(() => expect(screen.getAllByLabelText(/行备注$/).length).toBe(rows));
  });
  it('上下方向键在同一列换行', () => {
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    const q1 = screen.getByLabelText('第1行数量');
    q1.focus();
    fireEvent.keyDown(q1, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByLabelText('第2行数量'));
  });
});

describe('赠品与整单优惠', () => {
  it('勾选赠品后单价锁成 0、金额为 0；优惠金额进合计并随单据提交', async () => {
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    await pickProduct(1);
    fireEvent.change(screen.getByLabelText('第1行数量'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('第1行单价'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('优惠金额'), { target: { value: '3' } });
    expect(document.querySelector('.slip-foot-total')!.textContent).toContain('¥97.00');
    fireEvent.click(screen.getByLabelText('第2行赠品'));
    expect((screen.getByLabelText('第2行单价') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(fa.create).toHaveBeenCalled());
    const b = fa.create.mock.calls[0][0] as { discountCents: number; lines: Array<{ unitPriceCents: number }> };
    expect(b.discountCents).toBe(300);
    expect(b.lines[0].unitPriceCents).toBe(1000);
  });
  it('退货等商品类单据都有优惠金额，金额类单据没有', () => {
    render(<DocForm type="purchase-in" inline onSaved={vi.fn()} />);
    expect(screen.getByLabelText('优惠金额')).toBeTruthy();
    cleanup();
    render(<DocForm type="receipt" inline onSaved={vi.fn()} />);
    expect(screen.queryByLabelText('优惠金额')).toBeNull();
  });
});

describe('往来余额与行提示', () => {
  it('选了客户显示应收、预收和赊销额度；挂账后超额给提醒', async () => {
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    fireEvent.focus(screen.getByLabelText('客户'));
    fireEvent.click(await screen.findByRole('option', { name: '老客户' }));
    const bar = await screen.findByLabelText('往来余额');
    expect(bar.textContent).toContain('应收');
    expect(bar.textContent).toContain('¥500.00');
    expect(bar.textContent).toContain('预收款');
    expect(bar.textContent).toContain('赊销额度');
    await pickProduct(1);
    fireEvent.change(screen.getByLabelText('第1行单价'), { target: { value: '200' } });
    expect((await screen.findByRole('alert')).textContent).toContain('超过赊销额度');
  });
  it('商品行显示账面库存，销售数量超过库存标红；采购行显示上次进价对比', async () => {
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    await pickProduct(1);
    fireEvent.change(screen.getByLabelText('第1行数量'), { target: { value: '8' } });
    expect(await screen.findByText(/库存 5（不够出/)).toBeTruthy();
    cleanup();
    render(<DocForm type="purchase-in" inline onSaved={vi.fn()} />);
    await pickProduct(1);
    fireEvent.change(screen.getByLabelText('第1行单价'), { target: { value: '15' } });
    expect(await screen.findByText(/上次进价 ¥12.00，本次偏高/)).toBeTruthy();
  });
  it('取不到余额或提示（接口报错）也不影响开单', async () => {
    fa.partyBalance.mockRejectedValue(new Error('x'));
    fa.lineHints.mockRejectedValue(new Error('x'));
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    await pickProduct(1);
    expect(screen.getByLabelText('第1行数量')).toBeTruthy();
  });
});

describe('费用单与退货单的旧版结算方式', () => {
  it('费用单有“用预付款结算”和冲抵预付款', () => {
    render(<DocForm type="expense" inline onSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: '用预付款结算' })).toBeTruthy();
    expect(screen.getByLabelText('冲抵金额')).toBeTruthy();
  });
  it('采购退货单可以关联原采购入库单', async () => {
    render(<DocForm type="purchase-return" inline onSaved={vi.fn()} />);
    fireEvent.focus(screen.getByLabelText('供应商'));
    fireEvent.click(await screen.findByRole('option', { name: '老客户' }));
    await waitFor(() => expect(fa.docs).toHaveBeenCalledWith(expect.objectContaining({ scope: 'purchase-in', status: 'posted' })));
    expect(await screen.findByLabelText('关联原采购入库单')).toBeTruthy();
  });
});

describe('快捷键、调入草稿', () => {
  it('Ctrl+G 保存草稿；F8 过账（先确认）', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'g', ctrlKey: true });
    await waitFor(() => expect(fa.create).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: 'F8' });
    await screen.findByText(/请选择客户/);
    confirm.mockRestore();
  });
  it('调入草稿：列出这种单据的草稿，点一张把单号交给页面去装入', async () => {
    fa.docs.mockResolvedValue({ total: 1, amountCents: 0, paidCents: 0, page: 1, pageSize: 20, rows: [{ id: 42, docNo: 'XS-草稿1', partyName: '老客户', amountCents: 12300, docDate: '2026-10-28' }] } as never);
    const pick = vi.fn();
    render(<DocForm type="sale" inline onSaved={vi.fn()} onPickDraft={pick} />);
    fireEvent.click(screen.getByRole('button', { name: '调入草稿' }));
    const dlg = await screen.findByRole('dialog', { name: '调入草稿' });
    expect(fa.docs).toHaveBeenCalledWith(expect.objectContaining({ scope: 'sale', status: 'draft' }));
    fireEvent.click(await within(dlg).findByText('XS-草稿1'));
    expect(pick).toHaveBeenCalledWith(42);
  });
  it('制单页：调入草稿后进入编辑，保存走更新接口，之后回到空白新单', async () => {
    const d = { id: 42, docNo: 'XS-草稿1', docType: 'sale', status: 'draft', docDate: '2026-10-28', partyId: 7, partyName: '老客户', partyKind: 'customer', warehouseId: 9, warehouseName: '总仓', bankAccountId: null, bankName: '', toBankAccountId: null, toBankName: '', storeId: null, storeName: '', refNo: null, amountCents: 9700, offsetCents: 0, paidCents: 0, discountCents: 300, handler: '老板', department: null, memo: null, settleBy: null, accounts: [], lines: [{ id: 1, productId: 3, productName: '小油菜', feeItemId: null, feeItemName: '', qty: 10, unitPriceCents: 1000, unit: '斤', lineNo: 1, relatedNode: null, relatedId: null, relatedName: null }], entries: [], events: [] } as unknown as DocDetailDto;
    fa.docs.mockResolvedValue({ total: 1, amountCents: 0, paidCents: 0, page: 1, pageSize: 20, rows: [{ id: 42, docNo: 'XS-草稿1', partyName: '老客户', amountCents: 9700, docDate: '2026-10-28', typeLabel: '普通销售单', status: 'draft', paidCents: 0 }] } as never);
    fa.doc.mockResolvedValue(d);
    fa.update.mockResolvedValue(d);
    render(<VoucherPage type="sale" />);
    fireEvent.click(screen.getAllByRole('button', { name: '调入草稿' })[0]);
    const dlg = await screen.findByRole('dialog', { name: '调入草稿' });
    fireEvent.click(await within(dlg).findByText('XS-草稿1'));
    expect(await screen.findByText(/正在编辑草稿 XS-草稿1/)).toBeTruthy();
    expect((screen.getByLabelText('优惠金额') as HTMLInputElement).value).toBe('3.00');
    expect(document.querySelector('.slip-foot-total')!.textContent).toContain('¥97.00');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(fa.update).toHaveBeenCalledWith(42, expect.objectContaining({ discountCents: 300 })));
    await waitFor(() => expect(screen.queryByText(/正在编辑草稿/)).toBeNull());
  });
});
