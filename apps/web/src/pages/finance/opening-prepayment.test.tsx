import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OPENING_PREPAYMENT_PERMISSION } from '@kudesi/shared';
import { OpeningPrepaymentDialog } from './OpeningPrepaymentDialog';
import { DocDetail } from './DocDetail';
import { financeApi, type DocDetailDto } from './financeApi';

let allowed: string[] = [];
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: (key: string) => allowed.includes(key) }) }));
vi.mock('./financeApi', () => ({ financeApi: { doc: vi.fn(), uploadOpeningVoucher: vi.fn(), registerOpeningPrepayment: vi.fn(), openingVoucherUrl: vi.fn() } }));
const doc = { id: 5, docNo: 'YF20261026001', docType: 'prepayment', typeLabel: '预付款单', status: 'issued', sourceKey: null, partyKind: 'supplier', partyName: '测试供应商', amountCents: 10000, paidCents: 0, offsetCents: 0, accounts: [], lines: [], entries: [], events: [] } as unknown as DocDetailDto;
beforeEach(() => { vi.clearAllMocks(); allowed = []; vi.mocked(financeApi.doc).mockResolvedValue(doc); });
afterEach(cleanup);

it('只有有独立权限的已开立手工供应商预付款显示入口', async () => {
  allowed = ['finance.docs.post'];
  const first = render(<DocDetail id={5} onClose={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText(doc.docNo);
  expect(screen.queryByRole('button', { name: '登记已有预付款余额' })).toBeNull();
  first.unmount();
  allowed = [OPENING_PREPAYMENT_PERMISSION];
  render(<DocDetail id={5} onClose={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '登记已有预付款余额' }));
  expect(screen.getByRole('dialog', { name: '登记已有预付款余额' })).toBeTruthy();
});

it.each([{ status: 'draft' }, { status: 'posted' }, { sourceKey: 'flow:1' }, { docType: 'payment' }, { amountCents: 0 }, { partyKind: 'customer' }])('不适用的单据隐藏入口 %j', async (patch) => {
  allowed = [OPENING_PREPAYMENT_PERMISSION];
  vi.mocked(financeApi.doc).mockResolvedValue({ ...doc, ...patch } as DocDetailDto);
  render(<DocDetail id={5} onClose={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText(doc.docNo);
  expect(screen.queryByRole('button', { name: '登记已有预付款余额' })).toBeNull();
});

it('核对说明、凭证和确认均满足后才可登记，并提交真实上传的文件ID', async () => {
  const saved = vi.fn();
  vi.mocked(financeApi.uploadOpeningVoucher).mockResolvedValue({ id: 7, name: '回单.pdf', mime: 'application/pdf', size: 100 });
  vi.mocked(financeApi.registerOpeningPrepayment).mockResolvedValue({ ...doc, status: 'posted' });
  render(<OpeningPrepaymentDialog doc={doc} onClose={vi.fn()} onSaved={saved} />);
  const submit = screen.getByRole('button', { name: '确认登记' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('核对说明（必填）'), { target: { value: '核对回单' } });
  fireEvent.click(screen.getByRole('checkbox'));
  expect(submit.disabled).toBe(true);
  const file = new File(['%PDF-1.4'], '回单.pdf', { type: 'application/pdf' });
  fireEvent.change(screen.getByLabelText(/凭证附件/), { target: { files: [file] } });
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(saved).toHaveBeenCalledWith(expect.objectContaining({ status: 'posted' })));
  expect(financeApi.uploadOpeningVoucher).toHaveBeenCalledWith(5, file);
  expect(financeApi.registerOpeningPrepayment).toHaveBeenCalledWith(5, { reason: '核对回单', fileIds: [7], confirmed: true });
});

it('上传失败保留错误且不能登记', async () => {
  vi.mocked(financeApi.uploadOpeningVoucher).mockRejectedValue(new Error('还没有配置七牛云存储'));
  render(<OpeningPrepaymentDialog doc={doc} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/凭证附件/), { target: { files: [new File(['bad'], '回单.pdf')] } });
  expect((await screen.findByRole('alert')).textContent).toContain('七牛');
  expect((screen.getByRole('button', { name: '确认登记' }) as HTMLButtonElement).disabled).toBe(true);
  expect(financeApi.registerOpeningPrepayment).not.toHaveBeenCalled();
});

it('服务端拒绝后保留说明和附件，允许核对后重试', async () => {
  vi.mocked(financeApi.uploadOpeningVoucher).mockResolvedValue({ id: 7, name: '回单.pdf', mime: 'application/pdf', size: 100 });
  vi.mocked(financeApi.registerOpeningPrepayment).mockRejectedValue(new Error('单据已入账'));
  render(<OpeningPrepaymentDialog doc={doc} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('核对说明（必填）'), { target: { value: '核对回单' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText(/凭证附件/), { target: { files: [new File(['%PDF-1.4'], '回单.pdf')] } });
  await waitFor(() => expect((screen.getByRole('button', { name: '确认登记' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
  expect((await screen.findByRole('alert')).textContent).toContain('单据已入账');
  expect((screen.getByLabelText('核对说明（必填）') as HTMLTextAreaElement).value).toBe('核对回单');
  expect(screen.getByText('回单.pdf')).toBeTruthy();
});
