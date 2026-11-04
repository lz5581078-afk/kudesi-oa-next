import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { BundlesPage } from './BundlesPage';
import { jstApi } from './jstApi';

vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('../../../resources/RecordDetail', () => ({ RecordDetail: () => <div>组合抽屉</div>, useResourceCan: () => () => true }));

vi.mock('./BundleDialogs',async orig=>({...await orig<typeof import('./BundleDialogs')>(),GenerateDialog:({initialCategoryId}:{initialCategoryId?:number})=><div role="dialog">新增分类{initialCategoryId}</div>}));
vi.mock('../../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../../resources/api')>()), resourceApi: { list: vi.fn(), export: vi.fn() } }));
vi.mock('./jstApi', async (orig) => ({ ...(await orig<typeof import('./jstApi')>()), jstApi: { bundleOverview: vi.fn(), bundleSummaries:vi.fn().mockResolvedValue({rows:[]}) } }));
beforeEach(()=>{vi.mocked(jstApi.bundleSummaries).mockResolvedValue({rows:[]});});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const mk = (id: number, type: string, data: Record<string, unknown>, refLabels: Record<string, string> = {}): ResourceDto => ({ id, type, title: String(data.code ?? data.label ?? id), status: 'pending', statusReason: null, data, secretConfigured: {}, refLabels, files: {}, createdAt: '', updatedAt: '' });

describe('商品组合编码页', () => {
  it('可展开构成行（不打开详情）；编码可复制；没结果时可清除搜索', async () => {
    const bundle = mk(7, 'finance-bundles', { code: 'ZH-APPLE-2' });
    const line = mk(70, 'finance-bundle-lines', { role: 'main', qty: 2, unit: '个' }, { baseCodeId: '红富士1KG' });
    vi.mocked(resourceApi.list).mockImplementation(async (type) => (type === 'finance-platforms' ? {items:[],total:0,page:1,pageSize:200} : type === 'finance-bundle-lines' ? { items: [line], total: 1, page: 1, pageSize: 100 } : { items: [bundle], total: 1, page: 1, pageSize: 20 }) as never);
    vi.mocked(jstApi.bundleOverview).mockResolvedValue({ status: { pending: 1 } } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<BundlesPage />);
    await screen.findByText('ZH-APPLE-2',{selector:'td[data-label="组合编码"]'});
    fireEvent.click(screen.getByRole('button', { name: '复制组合编码' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ZH-APPLE-2'));
    fireEvent.click(screen.getAllByText('更多操作',{selector:'summary'}).find(node=>node.closest('tr'))!);
    fireEvent.click(screen.getByRole('button', { name: '展开构成' }));
    await screen.findByText(/红富士1KG × 2 个/);
    expect(screen.getByText('主品')).toBeTruthy();
    expect(vi.mocked(resourceApi.list)).toHaveBeenCalledWith('finance-bundle-lines', expect.objectContaining({ fieldKey: 'bundleId', fieldValue: 7 }));
    expect(screen.queryByText('组合抽屉')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起构成' }));
    expect(screen.queryByText(/红富士1KG × 2 个/)).toBeNull();
    vi.mocked(resourceApi.list).mockImplementation(async () => ({ items: [], total: 0, page: 1, pageSize: 20 }) as never);
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '没有' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    fireEvent.click(await screen.findByRole('button', { name: '清除搜索和分类' }));
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('');
  });
  it('三页签、30条分页、查询才应用输入，末级分类带入新增且已验证禁批选',async()=>{
    const bundle=mk(7,'finance-bundles',{code:'ZH-PARITY'});
    vi.mocked(resourceApi.list).mockImplementation(async type=>{const items=type==='finance-bundles'?[bundle]:type==='finance-categories'?[{...mk(5,'finance-categories',{label:'合成末级分类',archiveType:'bundle'}),status:'active'}]:[];return{items,total:items.length,page:1,pageSize:200};});
    vi.mocked(jstApi.bundleOverview).mockResolvedValue({status:{pending:1,verified:2,reverify:3}});
    render(<BundlesPage/>);await screen.findByText('ZH-PARITY',{selector:'td[data-label="组合编码"]'});
    expect(screen.getAllByRole('tab').map(tab=>tab.textContent)).toEqual(['待验证1','已验证2','二次验证3']);
    expect(resourceApi.list).toHaveBeenCalledWith('finance-bundles',expect.objectContaining({pageSize:30}));
    expect(screen.queryByRole('button',{name:'新建组合编码'})).toBeNull();
    const before=vi.mocked(resourceApi.list).mock.calls.filter(([type])=>type==='finance-bundles').length;
    fireEvent.change(screen.getByLabelText('搜索'),{target:{value:'查找草稿'}});
    await new Promise(resolve=>setTimeout(resolve,250));
    expect(vi.mocked(resourceApi.list).mock.calls.filter(([type])=>type==='finance-bundles')).toHaveLength(before);
    fireEvent.submit(screen.getByLabelText('搜索').closest('form')!);
    await waitFor(()=>expect(resourceApi.list).toHaveBeenCalledWith('finance-bundles',expect.objectContaining({keyword:'查找草稿'})));
    fireEvent.click(screen.getByRole('button',{name:'合成末级分类 0'}));
    fireEvent.click(screen.getByRole('button',{name:'新建组合编码'}));
    expect(screen.getByRole('dialog').textContent).toBe('新增分类5');
    fireEvent.keyDown(screen.getAllByRole('tab')[0],{key:'ArrowRight'});
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('');
    await screen.findByText('ZH-PARITY',{selector:'td[data-label="组合编码"]'});
    expect(screen.queryByLabelText('本页全选')).toBeNull();
    expect(screen.queryByLabelText('勾选 ZH-PARITY')).toBeNull();
  });
  it('平台及组成完整201条分页，展开最后一行不截断',async()=>{
    const bundle=mk(7,'finance-bundles',{code:'ZH-FULL'});
    const platforms=Array.from({length:201},(_,i)=>({...mk(i+500,'finance-platforms',{label:'合成平台'+i}),status:'active'}));
    const lines=Array.from({length:201},(_,i)=>mk(i+700,'finance-bundle-lines',{qty:1,role:'main'},{baseCodeId:'合成构成'+i}));
    vi.mocked(resourceApi.list).mockImplementation(async(type,q)=>{
      const all=type==='finance-platforms'?platforms:type==='finance-bundle-lines'?lines:[bundle], page=q?.page??1;
      return{items:all.slice((page-1)*200,page*200),total:all.length,page,pageSize:200};
    });
    vi.mocked(jstApi.bundleOverview).mockResolvedValue({status:{pending:1}});
    render(<BundlesPage/>);fireEvent.click(screen.getByRole('button',{name:'归档与聚水潭禁用记录'}));fireEvent.click(screen.getAllByText('更多操作',{selector:'summary'}).find(node=>!node.closest('tr'))!);await screen.findByRole('option',{name:'合成平台200'});await screen.findByText('ZH-FULL',{selector:'td[data-label="组合编码"]'});
    fireEvent.click(screen.getAllByText('更多操作',{selector:'summary'}).find(node=>node.closest('tr'))!);
    fireEvent.click(screen.getByRole('button',{name:'展开构成'}));
    await screen.findByText(/合成构成200 × 1/);
    expect(resourceApi.list).toHaveBeenCalledWith('finance-platforms',expect.objectContaining({page:2}));
    expect(resourceApi.list).toHaveBeenCalledWith('finance-bundle-lines',expect.objectContaining({page:2,fieldValue:7}));
    expect(screen.queryByText('组合抽屉')).toBeNull();
  });

  it('主表消费整页只读摘要，显示原成本/售价/kg/包装事实且可重试失败摘要',async()=>{
    const bundle=mk(7,'finance-bundles',{code:'ZH-FACTS',styleCode:'STYLE-FINAL',name:'合成组合',shortName:'合成简称',propertiesValue:'500克'},{platformId:'合成平台'});
    vi.mocked(resourceApi.list).mockImplementation(async type=>{const items=type==='finance-bundles'?[bundle]:type==='finance-categories'?[{...mk(5,'finance-categories',{label:'合成末级分类',archiveType:'bundle'}),status:'active'}]:[];return{items,total:items.length,page:1,pageSize:200};});
    vi.mocked(jstApi.bundleOverview).mockResolvedValue({status:{pending:1}});
    vi.mocked(jstApi.bundleSummaries).mockRejectedValueOnce(new Error('读取失败')).mockResolvedValue({rows:[{id:7,mainStyleCode:'STYLE-MAIN',weightG:525,cost:700,salePrice:900.1234,componentCount:3,packageCount:1,packageSummary:'PK-1 包装 ×2'}]});
    render(<BundlesPage/>);await screen.findByText('组合汇总读取失败，请重试');fireEvent.click(screen.getByRole('button',{name:'重试'}));
    await screen.findByText('STYLE-MAIN');
    expect(jstApi.bundleSummaries).toHaveBeenLastCalledWith([7]);
    expect(screen.getByText('¥7.000')).toBeTruthy();expect(screen.getByText('销售 ¥9.001234')).toBeTruthy();expect(screen.getByText('0.525000 kg')).toBeTruthy();expect(screen.getByRole('button',{name:'查看 3 项'})).toBeTruthy();expect(screen.getByText('PK-1 包装 ×2')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map(head=>head.textContent)).toEqual(['','组合编码','主款式编码','款式编码','商品名称 / 简称','平台','规格','成本价 / 销售价','重量','组成','包装','状态','操作']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

});
