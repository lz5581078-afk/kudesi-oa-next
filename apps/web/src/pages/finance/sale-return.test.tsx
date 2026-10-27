import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocForm } from './DocForm';
import { financeApi, type DocDetailDto } from './financeApi';
import { resourceApi } from '../../resources/api';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: { name: '老板' } }) }));
vi.mock('./financeApi', async (orig) => ({ ...(await orig<typeof import('./financeApi')>()), financeApi: { docs: vi.fn(), doc: vi.fn(), openItems: vi.fn(), syncEmployees: vi.fn() } }));
vi.mock('../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../resources/api')>()), resourceApi: { list: vi.fn() } }));
beforeEach(() => {
  vi.mocked(resourceApi.list).mockResolvedValue({ items: [{ id: 7, title: '老客户', status: 'active', data: {}, type: 'finance-customers' }], total: 1, page: 1, pageSize: 15 } as never);
  vi.mocked(financeApi.docs).mockResolvedValue({ rows: [{ id: 11, docNo: 'XS20261001001', docDate: '2026-10-01', amountCents: 5000, partyName: '老客户' }, { id: 12, docNo: 'XS-别人', docDate: '2026-10-02', amountCents: 1, partyName: '别人' }] } as never);
  vi.mocked(financeApi.doc).mockResolvedValue({ lines: [{ productId: 3, productName: '苹果', qty: 10, unitPriceCents: 500 }, { productId: null, productName: '运费', qty: 1, unitPriceCents: 100 }] } as unknown as DocDetailDto);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('销售退货：选客户后只列出他的已过账销售单，带入原单商品明细', async () => {
  render(<DocForm type="sale-return" inline onSaved={vi.fn()} />);
  const party = screen.getByLabelText('客户');
  fireEvent.focus(party);
  fireEvent.click(await screen.findByRole('option', { name: '老客户' }));
  await waitFor(() => expect(financeApi.docs).toHaveBeenCalledWith(expect.objectContaining({ scope: 'sale', status: 'posted', keyword: '老客户' })));
  const sel = (await screen.findByLabelText('关联原销售单')) as HTMLSelectElement;
  await waitFor(() => expect(sel.options.length).toBe(2)); // 不关联 + 他自己的一张
  fireEvent.change(sel, { target: { value: '11' } });
  fireEvent.click(screen.getByRole('button', { name: '带入原单明细' }));
  await screen.findByText(/已带入 1 种商品/);
  expect(screen.getByDisplayValue('苹果')).toBeTruthy();
});

it('网店销售：选店铺后店铺只有一个收款账户就自动填；佣金率只估算', async () => {
  vi.mocked(resourceApi.list).mockImplementation((async (type: string) => ({ items: [{ id: type === 'bank-accounts' ? 21 : 7, title: type === 'bank-accounts' ? '拼多多店铺户' : '一号店', status: 'active', data: {}, type }], total: 1, page: 1, pageSize: 15 })) as never);
  render(<DocForm type="online-sale" inline onSaved={vi.fn()} />);
  fireEvent.focus(screen.getByLabelText('销售店铺'));
  fireEvent.click(await screen.findByRole('option', { name: '一号店' }));
  await waitFor(() => expect((screen.getByLabelText('收款账户') as HTMLInputElement).value).toBe('拼多多店铺户'));
  expect(screen.getByLabelText('平台佣金率')).toBeTruthy();
});
