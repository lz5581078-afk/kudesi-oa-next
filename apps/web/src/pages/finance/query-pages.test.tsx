import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryPage } from './InventoryPage';
import { SettlementDetailPage, UnsettledReceiptsPage } from './SettlementPages';
import { financeApi } from './financeApi';
import { QueryTable } from './query/QueryKit';

const queryAuth = vi.hoisted(() => ({ allow: ['finance.history.view'], user:{companyId:1,id:1,permissions:{allow:[] as string[]}} }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({user:queryAuth.user, can: (key: string) => queryAuth.allow.includes(key) }) }));

vi.mock('./financeApi', () => ({ financeApi: { inventory: vi.fn(), inventoryLedger: vi.fn(), unsettledReceipts: vi.fn(), settlementDetail: vi.fn() } }));
vi.mock('./common', async (orig) => ({ ...(await orig<typeof import('./common')>()), SearchPick: () => <input aria-label="仓库" readOnly /> }));
const fa = vi.mocked(financeApi);
beforeEach(() => { vi.clearAllMocks(); queryAuth.user.companyId=1;queryAuth.allow = ['finance.history.view']; });
afterEach(cleanup);

const stock = (productId: number, warehouseId: number, name: string, wh: string, qty: number, amount: number | null) => ({ code: `C${productId}`, unit: 'KG', productId, warehouseId, productName: name, warehouseName: wh, qty, avgCostCents: amount === null ? null : Math.round(amount / (qty || 1)), amountCents: amount });

describe('库存查询（统一查询页版式）', () => {
  it('原页面只在查询后读取，七列带原表格交互；重置不重查并保留结果',async()=>{
    fa.inventory.mockResolvedValue([stock(1,1,'苹果','一号仓',10,5000),stock(2,1,'梨','一号仓',0,0),stock(1,2,'苹果','二号仓',5,2500)]);
    render(<MemoryRouter><InventoryPage/></MemoryRouter>);expect(fa.inventory).not.toHaveBeenCalled();expect(screen.getByText('请先输入查询条件')).toBeTruthy();
    expect(screen.queryByLabelText('截止日期')).toBeNull();expect(screen.queryByRole('button',{name:'导出CSV'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'查询'}));const table=await screen.findByRole('table',{name:'已过账库存'});
    expect(within(table).getAllByRole('columnheader')).toHaveLength(7);expect(screen.queryByLabelText('汇总')).toBeNull();expect(screen.queryByRole('button',{name:'按仓库'})).toBeNull();
    fireEvent.change(screen.getByLabelText('商品'),{target:{value:'苹果 KG'}});fireEvent.click(screen.getByRole('button',{name:'查询'}));
    await waitFor(()=>expect(fa.inventory).toHaveBeenLastCalledWith(expect.objectContaining({keyword:'苹果 KG'})));await screen.findByRole('table',{name:'已过账库存'});
    const calls=fa.inventory.mock.calls.length;fireEvent.click(screen.getByRole('button',{name:'重置'}));expect(fa.inventory).toHaveBeenCalledTimes(calls);expect(screen.getAllByText('一号仓')).toHaveLength(2);expect(screen.getByLabelText('商品')).toHaveProperty('value','');
  });
  it('服务端没给成本（无权限）时没有成本列和成本卡', async () => {
    fa.inventory.mockResolvedValue([stock(1, 1, '苹果', '一号仓', 10, null)]);
    render(<MemoryRouter><InventoryPage /></MemoryRouter>);
    expect(fa.inventory).not.toHaveBeenCalled();
    expect(screen.getByText('请先输入查询条件')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByText('苹果');
    expect(screen.queryByRole('columnheader', { name: '库存成本' })).toBeNull();
    expect(screen.queryByText('库存成本合计')).toBeNull();
  });
  it('原表格支持列表搜索和字段选择，不添加流水操作列；精确报价显示不预先舍入',async()=>{
    fa.inventory.mockResolvedValue([{...stock(1,1,'苹果','一号仓',10,5000),avgCostCents:110.0099}]);render(<InventoryPage/>);
    fireEvent.click(screen.getByRole('button',{name:'查询'}));await screen.findByText('苹果');expect(screen.getByText('¥1.100099')).toBeTruthy();expect(screen.queryByRole('button',{name:'流水'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'显示字段'}));expect(screen.getByRole('checkbox',{name:'平均单位成本'})).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox',{name:'已过账库存搜索'}),{target:{value:'不存在的商品'}});expect(screen.queryByText('苹果')).toBeNull();expect(fa.inventoryLedger).not.toHaveBeenCalled();
  });
  it('仓库为文字包含筛选，查询前不发请求，空查询结果与初始提示不同', async () => {
    fa.inventory.mockResolvedValue([]);
    render(<MemoryRouter><InventoryPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('仓库'), { target: { value: '一号' } });
    fireEvent.change(screen.getByLabelText('商品'), { target: { value: '苹果' } });
    fireEvent.change(screen.getByLabelText('库存状态'), { target: { value: 'out' } });
    expect(fa.inventory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByText('暂无库存快照');
    expect(fa.inventory).toHaveBeenCalledWith({ keyword: '苹果', warehouse: '一号', stockStatus: 'out' });
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    expect(screen.getByText('请先输入查询条件')).toBeTruthy();
    expect((screen.getByLabelText('仓库') as HTMLInputElement).value).toBe('');
    expect(fa.inventory).toHaveBeenCalledTimes(1);
  });
  it('重置取消尚未完成的查询，旧结果不能覆盖后一次查询', async () => {
    let resolve!: (rows: ReturnType<typeof stock>[]) => void;
    fa.inventory.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    fa.inventory.mockResolvedValueOnce([stock(2, 2, '合成新库存', '二号仓', 1, null)]);
    render(<MemoryRouter><InventoryPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    fireEvent.change(screen.getByLabelText('商品'), { target: { value: '新库存' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByText('合成新库存');
    await act(async () => resolve([stock(1, 1, '合成旧库存', '一号仓', 1, null)]));
    expect(screen.queryByText('合成旧库存')).toBeNull();
    expect(screen.getByText('合成新库存')).toBeTruthy();
  });
  it('查询失败保留上次已完成的结果，不把旧数据清成空快照', async () => {
    fa.inventory.mockResolvedValueOnce([stock(1, 1, '合成保留库存', '一号仓', 1, null)]);
    render(<MemoryRouter><InventoryPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByText('合成保留库存');
    fa.inventory.mockRejectedValueOnce(new Error('合成错误'));
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByText('合成错误');
    expect(screen.getByText('合成保留库存')).toBeTruthy();
  });
  it('换公司清空条件和旧结果，迟到响应不能显示在新公司',async()=>{
    let done!:(rows:ReturnType<typeof stock>[])=>void;fa.inventory.mockReturnValueOnce(new Promise(resolve=>{done=resolve;}));
    const view=render(<InventoryPage/>);fireEvent.change(screen.getByLabelText('商品'),{target:{value:'甲公司条件'}});fireEvent.click(screen.getByRole('button',{name:'查询'}));
    queryAuth.user.companyId=2;view.rerender(<InventoryPage/>);expect(screen.getByLabelText('商品')).toHaveProperty('value','');expect(screen.getByText('请先输入查询条件')).toBeTruthy();
    await act(async()=>done([stock(1,1,'甲公司私有库存','甲公司仓',1,100)]));expect(screen.queryByText('甲公司私有库存')).toBeNull();
    fa.inventory.mockResolvedValueOnce([stock(2,2,'乙公司库存','乙公司仓',1,200)]);fireEvent.click(screen.getByRole('button',{name:'查询'}));await screen.findByText('乙公司库存');
  });

});

describe('收付款两张查询表', () => {
  const pages = [{ name: '未完全结算', Page: UnsettledReceiptsPage, api: 'unsettledReceipts' as const }, { name: '结算明细', Page: SettlementDetailPage, api: 'settlementDetail' as const }];
  const queryRow = (id: number, docNo: string) => ({ id, docId: id, docNo, typeLabel: '收款单', docDate: '2026-03-01', partyName: '合成客户', settleByLabel: '按金额结算', sourceDocId: id + 100, sourceDocNo: `SOURCE-${id}`, sourceTypeLabel: '普通销售单', productName: '合成商品', amountCents: 1, totalCents: 2, allocatedCents: 1, unallocatedCents: 1 });
  it.each(pages)('$name只显示已授权单据类型，不提供无权的付款选项', async ({ Page, api }) => {
    queryAuth.allow = ['finance.doc-receipt.view'];
    fa[api].mockResolvedValue([]);
    render(<MemoryRouter><Page /></MemoryRouter>);
    await waitFor(() => expect(fa[api]).toHaveBeenCalled());
    const select = screen.getByLabelText('单据类型') as HTMLSelectElement;
    expect([...select.options].map(option => option.text)).toEqual(['收款单']);
  });
  it.each(pages)('$name重置后的新结果不被旧查询覆盖', async ({ Page, api }) => {
    let resolve!: (rows: ReturnType<typeof queryRow>[]) => void;
    fa[api].mockReset().mockReturnValueOnce(new Promise<ReturnType<typeof queryRow>[]>(done => { resolve = done; })).mockResolvedValueOnce([queryRow(2, 'SYNTHETIC-NEW')]);
    render(<MemoryRouter><Page /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await screen.findByText('SYNTHETIC-NEW');
    await act(async () => resolve([queryRow(1, 'SYNTHETIC-OLD')]));
    expect(screen.queryByText('SYNTHETIC-OLD')).toBeNull();
    expect(screen.getByText('SYNTHETIC-NEW')).toBeTruthy();
  });
  it('失败保留上次已完成的结算数据和汇总，不清成零', async () => {
    fa.unsettledReceipts.mockResolvedValueOnce([queryRow(3, 'SYNTHETIC-KEPT')]);
    render(<MemoryRouter><UnsettledReceiptsPage /></MemoryRouter>);
    await screen.findByText('SYNTHETIC-KEPT');
    fa.unsettledReceipts.mockRejectedValueOnce(new Error('合成读取失败'));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByText('加载失败');
    expect(screen.getByText('SYNTHETIC-KEPT')).toBeTruthy();
  });
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
