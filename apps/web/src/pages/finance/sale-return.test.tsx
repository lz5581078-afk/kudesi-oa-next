import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocForm } from './DocForm';
import { financeApi, type DocDetailDto } from './financeApi';
import { resourceApi } from '../../resources/api';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: { name: '老板' } }) }));
vi.mock('./financeApi', async (orig) => ({ ...(await orig<typeof import('./financeApi')>()), financeApi: { docs: vi.fn(), doc: vi.fn(), openItems: vi.fn(), syncEmployees: vi.fn(), banks: vi.fn().mockResolvedValue([]) } }));
vi.mock('../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../resources/api')>()), resourceApi: { list: vi.fn() } }));
beforeEach(() => {
  vi.mocked(resourceApi.list).mockResolvedValue({ items: [{ id: 7, title: '老客户', status: 'active', data: {}, type: 'finance-customers' }], total: 1, page: 1, pageSize: 15 } as never);
  vi.mocked(financeApi.docs).mockResolvedValue({ rows: [{ id: 11, docNo: 'XS20261001001', docDate: '2026-10-01', amountCents: 5000, partyName: '老客户' }, { id: 12, docNo: 'XS-别人', docDate: '2026-10-02', amountCents: 1, partyName: '别人' }] } as never);
  vi.mocked(financeApi.doc).mockResolvedValue({docType:'sale',status:'posted',partyKind:'customer',partyId:7, lines: [{ productId: 3, productName: '苹果', qty: 10, unitPriceCents: 500 }, { productId: null, productName: '运费', qty: 1, unitPriceCents: 100 }] } as unknown as DocDetailDto);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('销售退货：选客户后只列出他的已过账销售单，带入原单商品明细', async () => {
  render(<DocForm type="sale-return" onSaved={vi.fn()} />);
  const party = screen.getByLabelText('客户');
  fireEvent.click(party);
  fireEvent.click(await screen.findByRole('option', { name: '老客户' }));
  await waitFor(() => expect(financeApi.docs).toHaveBeenCalledWith(expect.objectContaining({ scope: 'sale', status: 'posted', keyword: '老客户' })));
  const sel = (await screen.findByLabelText('关联原销售单')) as HTMLSelectElement;
  await waitFor(() => expect(sel.options.length).toBe(2)); // 不关联 + 他自己的一张
  fireEvent.change(sel, { target: { value: '11' } });
  fireEvent.click(screen.getByRole('button', { name: '带入原单明细' }));
  await screen.findByText(/已带入 1 种商品/);
  expect(screen.getByLabelText('第1行商品').textContent).toContain('苹果');
});

it('网店销售沿原版手工选择收款账户，不因只有一个关联账户擅自代选；不新增佣金估算', async () => {
  vi.mocked(resourceApi.list).mockImplementation((async (type: string) => ({ items: [{ id: type === 'bank-accounts' ? 21 : 7, title: type === 'bank-accounts' ? '拼多多店铺户' : '一号店', status: 'active', data: {}, type }], total: 1, page: 1, pageSize: 15 })) as never);
  render(<DocForm type="online-sale" inline onSaved={vi.fn()} />);
  fireEvent.click(screen.getByLabelText('销售店铺'));
  fireEvent.click(await screen.findByRole('option', { name: '一号店' }));
  expect(screen.getByLabelText('收款账户').textContent).not.toContain('拼多多店铺户');
  expect(vi.mocked(resourceApi.list).mock.calls.some(([type])=>type==='bank-accounts')).toBe(false);
  fireEvent.click(screen.getByLabelText('收款账户'));
  fireEvent.click(await screen.findByRole('option',{name:'拼多多店铺户'}));
  expect(screen.getByLabelText('收款账户').textContent).toContain('拼多多店铺户');
  expect(screen.queryByLabelText('平台佣金率')).toBeNull();
});

it('带入原单等待期间改选客户，迟到的原商品不填入新客户的退货行',async()=>{
  let resolve!:(value:DocDetailDto)=>void;vi.mocked(financeApi.doc).mockReturnValue(new Promise(done=>{resolve=done;}));
  vi.mocked(resourceApi.list).mockResolvedValue({items:[{id:7,title:'老客户',status:'active',data:{}},{id:8,title:'新客户',status:'active',data:{}}],total:2,page:1,pageSize:200} as never);
  render(<DocForm type="sale-return" onSaved={vi.fn()}/>);fireEvent.click(screen.getByLabelText('客户'));fireEvent.click(await screen.findByRole('option',{name:'老客户'}));
  await waitFor(()=>expect((screen.getByLabelText('关联原销售单') as HTMLSelectElement).options).toHaveLength(2));fireEvent.change(screen.getByLabelText('关联原销售单'),{target:{value:'11'}});fireEvent.click(screen.getByRole('button',{name:'带入原单明细'}));
  fireEvent.click(screen.getByLabelText('客户'));fireEvent.click(await screen.findByRole('option',{name:'新客户'}));
  await act(async()=>{resolve({docType:'sale',status:'posted',partyKind:'customer',partyId:7,lines:[{productId:3,productName:'旧客户商品',qty:10,unitPriceCents:500,unit:'箱'}]} as unknown as DocDetailDto);});
  expect(screen.getByLabelText('第1行商品').textContent).not.toContain('旧客户商品');expect(screen.queryByText(/已带入/)).toBeNull();expect((screen.getByLabelText('第1行数量') as HTMLInputElement).value).toBe('');
});
it('同名不同客户或未过账原单不能带入，避免只按显示名称错误关联',async()=>{
  vi.mocked(financeApi.doc).mockResolvedValue({docType:'sale',status:'posted',partyKind:'customer',partyId:8,lines:[{productId:3,productName:'同名另一客户商品',qty:10,unitPriceCents:500}]} as unknown as DocDetailDto);
  render(<DocForm type="sale-return" onSaved={vi.fn()}/>);fireEvent.click(screen.getByLabelText('客户'));fireEvent.click(await screen.findByRole('option',{name:'老客户'}));
  await waitFor(()=>expect((screen.getByLabelText('关联原销售单') as HTMLSelectElement).options).toHaveLength(2));fireEvent.change(screen.getByLabelText('关联原销售单'),{target:{value:'11'}});fireEvent.click(screen.getByRole('button',{name:'带入原单明细'}));await screen.findByText(/原单不属于当前往来对象/);expect(screen.getByLabelText('第1行商品').textContent).not.toContain('同名另一客户商品');
});
