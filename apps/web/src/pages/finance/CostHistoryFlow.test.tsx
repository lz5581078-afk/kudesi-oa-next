import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CostHistoryPage } from './DataToolPages';
import { SkuHistoryDialog } from './CostDialogs';
import { financeApi, type CostRow, type CostSnapshotRow } from './financeApi';
const identity = vi.hoisted(() => ({user:{companyId:1,id:1,permissions:{isCompanyAdmin:false,allow:['product.cost.view'],deny:[] as string[]}}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>identity}));
vi.mock('./financeApi', async orig => ({ ...await orig<typeof import('./financeApi')>(), financeApi: { costHistory: vi.fn(), pricingHistory: vi.fn(), marginHistory: vi.fn(), skuCostHistory: vi.fn() } }));
afterEach(() => { identity.user={companyId:1,id:1,permissions:{isCompanyAdmin:false,allow:['product.cost.view'],deny:[]}}; cleanup(); vi.clearAllMocks(); });
const costRow: CostSnapshotRow = { id: 1, bundleId: 7, code: 'SYNTHETIC-001', name: '合成历史SKU', revision: 1, reason: '', actorName: '合成人员', createdAt: '2026-10-24T00:00:00Z', preShipCostCents: 100, weightG: 1000, freightCents: null, marginPercent: null, minPriceCents: null, changes: [] };
describe('成本历史读取与翻页', () => {
  it('搜索修改原因时发出关键词，新查询结果不被旧请求覆盖', async () => {
    let finishOld!: (r: { rows: CostSnapshotRow[]; total: number; page: number; pageSize: number }) => void;
    vi.mocked(financeApi.costHistory).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValue({ rows: [{ ...costRow, name: '新查询记录' }], total: 1, page: 1, pageSize: 20 });
    render(<CostHistoryPage />);
    await waitFor(() => expect(financeApi.costHistory).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索成本历史' }), { target: { value: '修改原因' } });
    await screen.findByText('新查询记录');
    expect(financeApi.costHistory).toHaveBeenLastCalledWith({ keyword: '修改原因', page: 1 });
    finishOld({ rows: [{ ...costRow, name: '过期记录' }], total: 50, page: 1, pageSize: 20 });
    await waitFor(() => expect(screen.queryByText('过期记录')).toBeNull());
    expect(screen.getByText('新查询记录')).toBeTruthy();
  });
  it('公司切换重建历史，上一身份的迟到记录不能出现', async () => {
    let finish!: (value:{rows:CostSnapshotRow[];total:number;page:number;pageSize:number}) => void;
    vi.mocked(financeApi.costHistory).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({rows:[{...costRow,name:'新公司历史'}],total:1,page:1,pageSize:20});
    const view=render(<CostHistoryPage/>);await waitFor(()=>expect(finish).toBeTruthy());
    identity.user={...identity.user,companyId:2};view.rerender(<CostHistoryPage/>);
    await screen.findByText('新公司历史');
    finish({rows:[{...costRow,name:'旧公司成本'}],total:1,page:1,pageSize:20});
    await waitFor(()=>expect(screen.queryByText('旧公司成本')).toBeNull());
  });

  it('SKU内层历史可读第二页，刷新保留页码', async () => {
    vi.mocked(financeApi.skuCostHistory).mockResolvedValue({ changes: { rows: [costRow], total: 21 }, pricing: { rows: [], total: 0 } });
    render(<SkuHistoryDialog row={{ bundleId: 7, name: '合成组合', code: 'SYNTHETIC' } as CostRow} onClose={() => {}} />);
    await screen.findByText('合成历史SKU');
    fireEvent.click(screen.getByRole('button', { name: '历史下一页' }));
    await waitFor(() => expect(financeApi.skuCostHistory).toHaveBeenLastCalledWith(7, 2, undefined));
    await screen.findByText('合成历史SKU');
    fireEvent.click(screen.getByRole('button', { name: '刷新历史' }));
    await waitFor(() => expect(financeApi.skuCostHistory).toHaveBeenCalledTimes(3));
    expect(financeApi.skuCostHistory).toHaveBeenLastCalledWith(7, 2, undefined);
  });
  it('SKU内层搜索按真实ID和关键词读取，迟到结果不覆盖搜索', async () => {
    let finish!: (value: Awaited<ReturnType<typeof financeApi.skuCostHistory>>) => void;
    vi.mocked(financeApi.skuCostHistory).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({changes:{rows:[{...costRow,name:'新搜索SKU'}],total:1},pricing:{rows:[],total:0}});
    render(<SkuHistoryDialog row={{bundleId:7,name:'合成组合',code:'SYNTHETIC'} as CostRow} onClose={()=>{}}/>);
    await waitFor(()=>expect(finish).toBeTruthy());
    fireEvent.change(screen.getByLabelText('搜索成本历史'),{target:{value:'核对原因'}});
    await screen.findByText('新搜索SKU');
    expect(financeApi.skuCostHistory).toHaveBeenLastCalledWith(7,1,'核对原因');
    finish({changes:{rows:[{...costRow,name:'旧搜索SKU'}],total:1},pricing:{rows:[],total:0}});
    await waitFor(()=>expect(screen.queryByText('旧搜索SKU')).toBeNull());
    expect(screen.queryByRole('tab',{name:/售价维护/})).toBeNull();
  });

  it('SKU历史读取失败后能在原窗口刷新重试', async () => {
    vi.mocked(financeApi.skuCostHistory).mockRejectedValueOnce(new Error('合成读取失败')).mockResolvedValue({ changes: { rows: [costRow], total: 1 }, pricing: { rows: [], total: 0 } });
    render(<SkuHistoryDialog row={{ bundleId: 7, name: '合成组合', code: 'SYNTHETIC' } as CostRow} onClose={() => {}} />);
    await screen.findByRole('alert');
    const retry = screen.getByRole('button', { name: '刷新历史' });
    expect(retry.hasAttribute('disabled')).toBe(false);
    fireEvent.click(retry);
    await screen.findByText('合成历史SKU');
    expect(screen.queryByRole('alert')).toBeNull();
  });

});
