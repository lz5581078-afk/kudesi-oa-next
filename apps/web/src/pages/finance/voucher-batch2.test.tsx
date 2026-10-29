import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIRM_TRANSFER_PERMISSION } from '@kudesi/shared';
import { DocForm } from './DocForm';
import { DocDetail } from './DocDetail';
import { financeApi, type DocDetailDto } from './financeApi';
import { resourceApi } from '../../resources/api';

let allowed: string[] | 'all' = 'all';
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: (k: string) => allowed === 'all' || allowed.includes(k), user: { id: 1, name: '老板' } }) }));
vi.mock('./financeApi', async (orig) => ({
  ...(await orig<typeof import('./financeApi')>()),
  financeApi: { docs: vi.fn(), doc: vi.fn(), openItems: vi.fn(), syncEmployees: vi.fn(), banks: vi.fn(), create: vi.fn(), update: vi.fn(), issue: vi.fn(), post: vi.fn(), partyBalance: vi.fn(), lineHints: vi.fn(), confirmTransfer: vi.fn() },
}));
vi.mock('../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../resources/api')>()), resourceApi: { list: vi.fn(), get: vi.fn(), users: vi.fn() } }));
const fa = vi.mocked(financeApi);
const item = (id: number, title: string) => ({ id, title, status: 'active', data: {} });
const BANKS = [item(5, '甲户'), item(6, '乙户')];
beforeEach(() => {
  allowed = 'all';
  vi.mocked(resourceApi.list).mockImplementation((async (type: string) => ({ items: type === 'bank-accounts' ? BANKS : type === 'finance-products' ? [item(3, '小油菜')] : type === 'finance-warehouses' ? [item(9, '总仓')] : [item(7, '老客户')], total: 1, page: 1, pageSize: 15 })) as never);
  vi.mocked(resourceApi.get).mockResolvedValue({ data: {} } as never);
  vi.mocked(resourceApi.users).mockResolvedValue([{ id: 1, name: '老板', active: true }, { id: 2, name: '员工小王', active: true }, { id: 3, name: '离职小李', active: false }]);
  fa.banks.mockResolvedValue([{ id: 5, title: '甲户', balanceCents: 100000 }, { id: 6, title: '乙户', balanceCents: 50000 }] as never);
  fa.partyBalance.mockResolvedValue({ partyId: 7, partyKind: 'customer', name: '老客户', receivableCents: 0, payableCents: 0, advanceReceiptCents: 0, prepaymentCents: 0, creditLimitCents: null, overLimit: false });
  fa.lineHints.mockResolvedValue([]);
  fa.docs.mockResolvedValue({ total: 0, rows: [], amountCents: 0, paidCents: 0, page: 1, pageSize: 20 } as never);
  fa.create.mockResolvedValue({ id: 1, docNo: 'X1' } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const pickParty = async (label: string) => { fireEvent.focus(screen.getByLabelText(label)); fireEvent.click(await screen.findByRole('option', { name: '老客户' })); };
const addAccount = async (label: string, name: string) => { fireEvent.focus(screen.getByLabelText(label)); fireEvent.click(await screen.findByRole('option', { name })); };
const lastCreated = () => fa.create.mock.calls[0][0] as unknown as Record<string, unknown> & { accounts: Array<{ role: string; bankAccountId: number; amountCents: number }> };

describe('收款单/付款单优惠金额', () => {
  it('收款单：优惠金额随单据提交，并显示“本次冲减应收 = 到账 + 优惠”', async () => {
    render(<DocForm type="receipt" inline onSaved={vi.fn()} />);
    await pickParty('客户');
    fireEvent.change(screen.getByLabelText('第1行收款来源'), { target: { value: '客户回款' } });
    fireEvent.change(screen.getByLabelText('第1行金额'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('优惠金额'), { target: { value: '10' } });
    expect(within(screen.getByLabelText('本次冲减往来')).getByText('本次冲减应收').nextSibling!.textContent).toBe('¥100.00');
    await addAccount('收款账户', '甲户');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(fa.create).toHaveBeenCalled());
    expect(lastCreated().discountCents).toBe(1000);
  });
  it('付款单：说明是对方给的折扣；不填优惠时提交 0', async () => {
    render(<DocForm type="payment" inline onSaved={vi.fn()} />);
    expect(screen.getByText(/对方给的折扣/)).toBeTruthy();
    expect(within(screen.getByLabelText('本次冲减往来')).getByText('本次冲减应付')).toBeTruthy();
    await pickParty('收款方').catch(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(fa.create).toHaveBeenCalled());
    expect(lastCreated().discountCents).toBe(0);
  });
});

describe('多账户收付款', () => {
  it('销售单：分两个账户收款，实收等于各账户之和，提交 accounts 且主账户是第一个', async () => {
    render(<DocForm type="sale" inline onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '分多个账户收款' }));
    await addAccount('添加收款账户', '甲户');
    await addAccount('添加收款账户', '乙户');
    fireEvent.change(screen.getByLabelText('甲户收款金额'), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('乙户收款金额'), { target: { value: '30' } });
    expect((screen.getByLabelText('收到金额') as HTMLInputElement).value).toBe('70.00');
    expect(screen.getByLabelText('分账户合计').textContent).toContain('¥70.00');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(fa.create).toHaveBeenCalled());
    const b = lastCreated();
    expect(b.paidCents).toBe(7000);
    expect(b.bankAccountId).toBe(5);
    expect(b.accounts).toEqual([{ role: 'in', bankAccountId: 5, amountCents: 4000 }, { role: 'in', bankAccountId: 6, amountCents: 3000 }]);
  });
  it('付款单：各账户合计必须等于单据金额，不等就提示并给“差额填入”；改回单个账户后恢复原写法', async () => {
    render(<DocForm type="payment" inline onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('第1行付款用途'), { target: { value: '货款' } });
    fireEvent.change(screen.getByLabelText('第1行金额'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '分多个账户付款' }));
    await addAccount('添加付款账户', '甲户');
    await addAccount('添加付款账户', '乙户');
    fireEvent.change(screen.getByLabelText('甲户付款金额'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('乙户付款金额'), { target: { value: '30' } });
    expect(screen.getByLabelText('分账户合计').textContent).toContain('必须相等');
    fireEvent.click(screen.getByRole('button', { name: /填入最后一行/ }));
    expect((screen.getByLabelText('乙户付款金额') as HTMLInputElement).value).toBe('40.00');
    expect(screen.getByLabelText('分账户合计').textContent).toContain('一致');
    fireEvent.click(screen.getByRole('button', { name: '改回单个账户' }));
    expect(screen.getByLabelText('付款账户')).toBeTruthy();
    expect((screen.getByLabelText('付款账户') as HTMLInputElement).value).toBe('甲户');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(fa.create).toHaveBeenCalled());
    expect(lastCreated().accounts).toBeNull();
    expect(lastCreated().bankAccountId).toBe(5);
  });
  it('合计对不上时，开立被前端校验拦住且不请求服务器', async () => {
    render(<DocForm type="receipt" inline onSaved={vi.fn()} />);
    await pickParty('客户');
    fireEvent.change(screen.getByLabelText('第1行收款来源'), { target: { value: '回款' } });
    fireEvent.change(screen.getByLabelText('第1行金额'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '分多个账户收款' }));
    await addAccount('添加收款账户', '甲户');
    fireEvent.change(screen.getByLabelText('甲户收款金额'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并开立' }));
    expect((await screen.findByRole('alert')).textContent).toContain('各账户金额合计');
    expect(fa.create).not.toHaveBeenCalled();
  });
  it('老单据（分账户）打开编辑时还原每个账户；没有分账户的收款单没有分账户面板', async () => {
    const doc = { id: 9, docNo: 'XS9', docType: 'sale', status: 'draft', docDate: '2026-10-29', partyId: 7, partyName: '老客户', partyKind: 'customer', warehouseId: 9, warehouseName: '总仓', bankAccountId: 5, bankName: '甲户', amountCents: 10000, paidCents: 7000, offsetCents: 0, accounts: [{ id: 1, role: 'in', bankAccountId: 5, bankName: '甲户', amountCents: 4000 }, { id: 2, role: 'in', bankAccountId: 6, bankName: '乙户', amountCents: 3000 }], lines: [{ id: 1, lineNo: 1, productId: 3, productName: '小油菜', qty: 10, unitPriceCents: 1000, feeItemName: '' }], entries: [], events: [] } as unknown as DocDetailDto;
    render(<DocForm type="sale" doc={doc} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByLabelText('甲户收款金额') as HTMLInputElement).value).toBe('40.00');
    expect((screen.getByLabelText('乙户收款金额') as HTMLInputElement).value).toBe('30.00');
    cleanup();
    render(<DocForm type="sale" doc={{ ...doc, accounts: [] }} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByLabelText('分账户收款')).toBeNull();
    expect(screen.getByRole('button', { name: '分多个账户收款' })).toBeTruthy();
  });
});

describe('转款手续费与在途', () => {
  it('填手续费并选承担方、勾选先登记在途，随单据提交', async () => {
    render(<DocForm type="transfer" inline onSaved={vi.fn()} />);
    await addAccount('添加转出账户', '甲户');
    await addAccount('添加转入账户', '乙户');
    fireEvent.change(screen.getByLabelText('转出账户甲户金额'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('转入账户乙户金额'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('转款手续费'), { target: { value: '0.3' } });
    fireEvent.change(screen.getByLabelText('手续费承担方'), { target: { value: 'in' } });
    fireEvent.click(screen.getByLabelText('先登记为在途'));
    expect(screen.getByText(/由转入账户/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('第1行转款用途'), { target: { value: '资金调拨' } });
    fireEvent.change(screen.getByLabelText('第1行金额'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(fa.create).toHaveBeenCalled());
    const b = lastCreated();
    expect(b.feeCents).toBe(30);
    expect(b.feeBearer).toBe('in');
    expect(b.inTransit).toBe(true);
  });
  it('不填手续费时不提交承担方；不是转款单没有这一栏', () => {
    render(<DocForm type="transfer" inline onSaved={vi.fn()} />);
    expect((screen.getByLabelText('手续费承担方') as HTMLSelectElement).disabled).toBe(true);
    cleanup();
    render(<DocForm type="receipt" inline onSaved={vi.fn()} />);
    expect(screen.queryByLabelText('转款手续费')).toBeNull();
  });
});

describe('经手人员工选择器', () => {
  it('默认当前登录员工，可以改选其他在职员工，提交员工 id', async () => {
    render(<DocForm type="receipt" inline onSaved={vi.fn()} />);
    const sel = screen.getByLabelText('经办人') as HTMLSelectElement;
    expect(sel.value).toBe('1');
    await waitFor(() => expect(within(sel).getByRole('option', { name: '员工小王' })).toBeTruthy());
    expect(within(sel).queryByRole('option', { name: /离职小李/ })).toBeNull();
    fireEvent.change(sel, { target: { value: '2' } });
    await pickParty('客户');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(fa.create).toHaveBeenCalled());
    expect(lastCreated().handlerId).toBe(2);
    expect(lastCreated().handler).toBeNull();
  });
  it('老数据里的文字经手人保持显示（原文字选项），保存时仍是文字、不丢', async () => {
    const doc = { id: 9, docNo: 'SK9', docType: 'receipt', status: 'draft', docDate: '2026-10-29', partyId: 7, partyName: '老客户', partyKind: 'customer', handler: '老张（外聘）', handlerId: null, bankAccountId: 5, bankName: '甲户', amountCents: 1000, paidCents: 0, offsetCents: 0, accounts: [], lines: [{ id: 1, lineNo: 1, itemName: '回款', qty: 1, unitPriceCents: 1000, productName: '', feeItemName: '' }], entries: [], events: [] } as unknown as DocDetailDto;
    fa.update.mockResolvedValue(doc as never);
    render(<DocForm type="receipt" doc={doc} onSaved={vi.fn()} onClose={vi.fn()} />);
    const sel = screen.getByLabelText('经办人') as HTMLSelectElement;
    expect(sel.value).toBe('');
    expect(within(sel).getByRole('option', { name: '老张（外聘）（原文字）' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '存为草稿' }));
    await waitFor(() => expect(fa.update).toHaveBeenCalled());
    const b = fa.update.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(b.handler).toBe('老张（外聘）');
    expect(b.handlerId).toBeNull();
  });
  it('取不到员工名单时不影响开单，仍能用默认经手人', async () => {
    vi.mocked(resourceApi.users).mockRejectedValue(new Error('没权限'));
    render(<DocForm type="receipt" inline onSaved={vi.fn()} />);
    expect((screen.getByLabelText('经办人') as HTMLSelectElement).value).toBe('1');
  });
});

describe('转款单详情：确认入账', () => {
  const transfer = { id: 20, docNo: 'ZK20', docType: 'transfer', typeLabel: '转款单', status: 'posted', docDate: '2026-10-20', partyId: null, partyName: '', storeName: '', refNo: null, warehouseName: '', bankName: '甲户', toBankName: '乙户', amountCents: 5000, paidCents: 0, offsetCents: 0, feeCents: 30, feeBearer: 'in', transitStatus: 'pending', reversesId: null, reversedById: null, auditedAt: null, createdByName: '老板', handler: '老板', handlerId: 1, department: null, memo: null, accounts: [{ id: 1, role: 'out', bankAccountId: 5, bankName: '甲户', amountCents: 5000 }, { id: 2, role: 'in', bankAccountId: 6, bankName: '乙户', amountCents: 5000 }], lines: [], entries: [], events: [] } as unknown as DocDetailDto;
  beforeEach(() => { fa.doc.mockResolvedValue(transfer); });
  it('在途转款：有确认权限才出现“确认入账”，确认时可填到账日期和备注，调用确认接口后变为已确认', async () => {
    allowed = ['finance.docs.post'];
    const first = render(<DocDetail id={20} onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText('ZK20');
    expect(screen.getByText(/在途待确认/)).toBeTruthy();
    expect(screen.getByText(/手续费/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认入账' })).toBeNull();
    first.unmount();
    allowed = [CONFIRM_TRANSFER_PERMISSION];
    const changed = vi.fn();
    fa.confirmTransfer.mockResolvedValue({ ...transfer, transitStatus: 'confirmed', confirmedByName: '出纳' });
    render(<DocDetail id={20} onClose={vi.fn()} onChanged={changed} />);
    fireEvent.click((await screen.findAllByRole('button', { name: '确认入账' }))[0]);
    const dlg = screen.getByRole('dialog', { name: '确认入账' });
    expect(dlg.textContent).toContain('乙户');
    fireEvent.change(within(dlg).getByLabelText('确认备注'), { target: { value: '回单已核对' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '确认入账' }));
    await waitFor(() => expect(fa.confirmTransfer).toHaveBeenCalledWith(20, expect.objectContaining({ note: '回单已核对', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })));
    await waitFor(() => expect(screen.getByText(/已确认入账/)).toBeTruthy());
    expect(changed).toHaveBeenCalled();
  });
  it('确认失败显示服务器的原因，对话框保留', async () => {
    allowed = [CONFIRM_TRANSFER_PERMISSION];
    const { ApiError } = await import('../../api/client');
    fa.confirmTransfer.mockRejectedValue(new ApiError(409, '这张转款单已经确认入账了'));
    render(<DocDetail id={20} onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click((await screen.findAllByRole('button', { name: '确认入账' }))[0]);
    fireEvent.click(within(screen.getByRole('dialog', { name: '确认入账' })).getByRole('button', { name: '确认入账' }));
    expect((await screen.findAllByRole('alert'))[0].textContent).toContain('已经确认入账');
  });
  it('已确认的和普通转款不出现确认入账按钮', async () => {
    allowed = [CONFIRM_TRANSFER_PERMISSION];
    fa.doc.mockResolvedValue({ ...transfer, transitStatus: 'confirmed' } as DocDetailDto);
    render(<DocDetail id={20} onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText('ZK20');
    expect(screen.queryByRole('button', { name: '确认入账' })).toBeNull();
    cleanup();
    fa.doc.mockResolvedValue({ ...transfer, transitStatus: null } as DocDetailDto);
    render(<DocDetail id={20} onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText('ZK20');
    expect(screen.queryByRole('button', { name: '确认入账' })).toBeNull();
  });
});
