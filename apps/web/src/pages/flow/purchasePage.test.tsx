import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PurchaseCenterPage } from './PurchaseCenterPage';
import { PurchasePanel } from './PurchasePanel';
import { PurchaseStepFields, toPayload } from './PurchaseStepForms';
import { flowApi } from './flowApi';
import { centsToYuan, purchaseApi, yuanToCents, type PurchaseViewDto } from './purchaseApi';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: { id: 7 } }) }));
vi.mock('./RunDetail', () => ({ RunDetail: ({ id }: { id: number }) => <div>流程详情 #{id}</div> }));
vi.mock('./flowApi', async (orig) => ({ ...(await orig<typeof import('./flowApi')>()), flowApi: { start: vi.fn(), runs: vi.fn() } }));
vi.mock('./purchaseApi', async (orig) => ({
  ...(await orig<typeof import('./purchaseApi')>()),
  purchaseApi: { products: vi.fn(), progress: vi.fn(), state: vi.fn(), options: vi.fn(), followup: vi.fn(), control: vi.fn(), upload: vi.fn(), fileUrl: vi.fn() },
}));
const pa = vi.mocked(purchaseApi);
const flow = vi.mocked(flowApi);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const products = { total: 2, page: 1, pageSize: 40, categories: [{ id: 1, name: '水果', parentId: null }], rows: [
  { id: 11, code: 'YL-1', name: '苹果', archiveType: 'raw', categoryId: 1, categoryName: '水果', unit: '斤', unitKey: 'J', aliases: ['红富士', '烟富3号'] },
  { id: 12, code: 'YL-2', name: '梨', archiveType: 'raw', categoryId: 1, categoryName: '水果', unit: '斤', unitKey: 'J', aliases: [] },
] };
const base: PurchaseViewDto = {
  id: 5, status: 'running', requesterId: 7, requestedArrivalAt: '2099-12-31', note: '', money: false, myStep: 'plan', supplierName: '果园', warehouseName: '采购仓', paymentMode: null, planReady: false, approved: false, paid: true, amendOpen: false,
  cancelRequested: false, cancelApproved: false, cancelledRemaining: false, cancelRequestComment: '',
  lines: [{ productId: 11, name: '苹果', code: 'YL-1', unit: '斤', aliasName: '红富士', qty: 10, received: 4, cancelled: 0, remaining: 6, toShip: 6 }],
  shipments: [], pendingShipments: [], batches: [], followups: [], amendments: [],
};

describe('金额换算', () => {
  it('元转分最多 4 位小数，分转元不丢精度', () => {
    expect(yuanToCents('2.501234')).toBe(250.1234);
    expect(yuanToCents('2.5012345')).toBeNull();
    expect(yuanToCents('abc')).toBeNull();
    expect(centsToYuan(250.1234)).toBe('2.501234');
    expect(toPayload('pay', { payments: [{ amountYuan: '30', bankAccountId: '3', reference: 'LS1', files: [9] }], claimYuan: '20' })).toMatchObject({ payments: [{ amountCents: 3000, bankAccountId: 3 }], claimCents: 2000 });
    expect(() => toPayload('plan', { prices: { 11: 'x' } })).toThrow(/单价/);
  });
});

describe('采购申请中心', () => {
  it('新建：选商品、原料必须选成品名、填数量和日期后确认提交；提交的清单只有商品、数量、成品名', async () => {
    pa.products.mockResolvedValue(products);
    pa.progress.mockResolvedValue({});
    flow.runs.mockResolvedValue({ total: 0, page: 1, pageSize: 20, rows: [] });
    flow.start.mockResolvedValue({ id: 99 } as never);
    render(<PurchaseCenterPage />);
    fireEvent.click(await screen.findByRole('tab', { name: '新建采购申请' }));
    fireEvent.click(await screen.findByRole('button', { name: /苹果/ }));
    expect((screen.getByRole('button', { name: '提交采购申请' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/还需要/).textContent).toContain('每个商品的数量');
    fireEvent.change(screen.getByLabelText('苹果成品名'), { target: { value: '红富士' } });
    fireEvent.change(screen.getByLabelText('苹果数量'), { target: { value: '10.5' } });
    fireEvent.change(screen.getByLabelText('要求到货日期'), { target: { value: '2099-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: '提交采购申请' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认提交' }));
    await waitFor(() => expect(flow.start).toHaveBeenCalled());
    expect(flow.start.mock.calls[0][1]).toEqual({ lines: [{ productId: 11, qty: 10.5, aliasName: '红富士' }], requestedArrivalAt: '2099-12-31' });
    expect(await screen.findByText('流程详情 #99')).toBeTruthy();
  });

  it('列表：显示停在哪一步和到货进度，异常有标记', async () => {
    flow.runs.mockResolvedValue({ total: 1, page: 1, pageSize: 20, rows: [{ id: 5, templateKey: 'purchase-request', templateLabel: '采购申请', title: '采购申请 · 红富士', status: 'running', requesterName: '小运', stepName: '质检', handlers: ['小仓'], dueAt: null, createdAt: '2026-10-01T00:00:00Z', finishedAt: null, overdue: false }] });
    pa.progress.mockResolvedValue({ 5: { supplierName: '果园', requestedArrivalAt: '2099-12-31', batches: 2, total: 10, received: 4, items: 1, abnormal: true, refunding: false } });
    render(<PurchaseCenterPage />);
    expect(await screen.findByText('采购申请 · 红富士')).toBeTruthy();
    expect(await screen.findByText('异常')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');
    expect(screen.getByText(/停在「质检」/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /采购申请 · 红富士/ }));
    expect(await screen.findByText('流程详情 #5')).toBeTruthy();
  });
});

describe('采购办理表单', () => {
  it('方案：单价按元填、转成分交给流程；单价格式不对时给出提示且不提交数据', async () => {
    pa.state.mockResolvedValue({ ...base, money: true });
    pa.options.mockResolvedValue({ step: 'plan', suppliers: [{ id: 3, name: '果园' }], warehouses: [{ id: 4, name: '采购仓' }] });
    const onChange = vi.fn();
    render(<PurchaseStepFields runId={5} stepKey="plan" refreshKey={1} onChange={onChange} />);
    fireEvent.change(await screen.findByLabelText('苹果单价'), { target: { value: '2.501234' } });
    fireEvent.change(screen.getByLabelText('供应商'), { target: { value: '3' } });
    const last = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(last[0]).toBe('data');
    expect(last[1]).toMatchObject({ supplierId: 3, prices: { 11: 250.1234 } });
    fireEvent.change(screen.getByLabelText('苹果单价'), { target: { value: '2.5012345' } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/单价格式不对/);
    expect(onChange.mock.calls[onChange.mock.calls.length - 1][1]).toBeUndefined();
  });

  it('发货：只列还没发的数量；登记承诺发货日走跟进接口', async () => {
    pa.state.mockResolvedValue(base);
    pa.options.mockResolvedValue({ step: 'dispatch' });
    pa.followup.mockResolvedValue({ ok: true });
    const onChange = vi.fn();
    render(<PurchaseStepFields runId={5} stepKey="dispatch" refreshKey={1} onChange={onChange} />);
    fireEvent.change(await screen.findByLabelText('苹果本批发货数量'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('物流单号'), { target: { value: 'SF1' } });
    expect(onChange.mock.calls[onChange.mock.calls.length - 1][1]).toMatchObject({ lines: [{ productId: 11, qty: 6 }], logisticsNo: 'SF1' });
    fireEvent.change(screen.getByLabelText('承诺发货日期'), { target: { value: '2099-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: '登记跟进' }));
    await waitFor(() => expect(pa.followup).toHaveBeenCalledWith(5, { promisedShipAt: '2099-01-01', comment: undefined }));
  });

  it('凭证：选文件上传后加入列表，可以移除', async () => {
    pa.state.mockResolvedValue({ ...base, batches: [{ id: 'b1', logisticsNo: 'SF1', expectedArrivalAt: '2099-11-01', shipmentId: 's1' } as never] });
    pa.options.mockResolvedValue({ step: 'arrival' });
    pa.upload.mockResolvedValue({ id: 21, name: '到货.png' });
    const onChange = vi.fn();
    render(<PurchaseStepFields runId={5} stepKey="arrival" refreshKey={1} onChange={onChange} />);
    const input = await screen.findByLabelText('到货凭证');
    fireEvent.change(input, { target: { files: [new File(['x'], '到货.png', { type: 'image/png' })] } });
    expect(await screen.findByText(/到货\.png/)).toBeTruthy();
    expect(pa.upload).toHaveBeenCalledWith(5, expect.any(File));
    expect(onChange.mock.calls[onChange.mock.calls.length - 1][1]).toEqual({ files: [21] });
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    expect(onChange.mock.calls[onChange.mock.calls.length - 1][1]).toEqual({ files: [] });
  });
});

describe('采购进度面板', () => {
  it('没有金额权限时不显示单价和付款；申请人付款后可以申请变更，必须写原因', async () => {
    pa.state.mockResolvedValue({ ...base, money: false, prepayReviewed: true });
    pa.control.mockResolvedValue({});
    const changed = vi.fn();
    render(<PurchasePanel runId={5} refreshKey={1} onChanged={changed} />);
    expect(await screen.findByText('采购进度')).toBeTruthy();
    expect(screen.queryByText('单价（元）')).toBeNull();
    expect(screen.queryByText('批准金额')).toBeNull();
    // 申请人没有金额权限也能申请变更：是否已付款由服务端单独告知，不暴露金额
    fireEvent.click(screen.getByRole('button', { name: '申请变更采购内容' }));
    const submit = screen.getByRole('button', { name: '提交变更申请' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '少买两斤' } });
    fireEvent.click(submit);
    await waitFor(() => expect(pa.control).toHaveBeenCalledWith(5, { mode: 'amend', comment: '少买两斤' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it('有金额权限：显示单价、付款；申请人能申请终止未到货部分并退款', async () => {
    pa.state.mockResolvedValue({ ...base, money: true, approvedCents: 5000, payments: [{ docId: 1, docNo: 'YF001', amountCents: 3000, bankAccountId: 1, reference: 'LS1', files: [], payeeName: '果园', payeeAccount: '1' }], prepay: { paidCents: 3000, claimedCents: 2000, offsetCents: 0, refundedCents: 0, unusedCents: 5000 }, lines: [{ ...base.lines[0], unitPriceCents: 250.1234 }] });
    pa.control.mockResolvedValue({});
    const changed = vi.fn();
    render(<PurchasePanel runId={5} refreshKey={1} onChanged={changed} />);
    expect(await screen.findByText('单价（元）')).toBeTruthy();
    expect(screen.getByText('2.501234')).toBeTruthy();
    expect(screen.getByText('YF001')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '申请终止未到货部分并退款' }));
    const submit = screen.getByRole('button', { name: '提交终止申请' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '供应商缺货' } });
    fireEvent.click(submit);
    await waitFor(() => expect(pa.control).toHaveBeenCalledWith(5, { mode: 'cancel_remaining', comment: '供应商缺货' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });
});
