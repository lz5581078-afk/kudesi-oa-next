import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { BundlesPage } from './BundlesPage';
import { jstApi } from './jstApi';
import {api} from '../../../api/client';
vi.mock('../../../api/client',async orig=>({...await orig<typeof import('../../../api/client')>(),api:vi.fn().mockResolvedValue({rows:[]})}));

vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('../../../resources/RecordDetail', () => ({ RecordDetail: () => <div>组合抽屉</div>, useResourceCan: () => () => true }));

vi.mock('./BundleDialogs',async orig=>({...await orig<typeof import('./BundleDialogs')>(),GenerateDialog:({initialCategoryId}:{initialCategoryId?:number})=><div role="dialog">新增分类{initialCategoryId}</div>}));
vi.mock('../../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../../resources/api')>()), resourceApi: { list: vi.fn(), export: vi.fn() } }));
vi.mock('./jstApi', async (orig) => ({ ...(await orig<typeof import('./jstApi')>()), jstApi: { bundleComposition:vi.fn(), bundleOverview: vi.fn(), bundleSummaries:vi.fn().mockResolvedValue({rows:[]}) } }));
beforeEach(()=>{vi.mocked(api).mockResolvedValue({rows:[]});vi.mocked(jstApi.bundleSummaries).mockResolvedValue({rows:[]});});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const mk = (id: number, type: string, data: Record<string, unknown>, refLabels: Record<string, string> = {}): ResourceDto => ({ id, type, title: String(data.code ?? data.label ?? id), status: 'pending', statusReason: null, data, secretConfigured: {}, refLabels, files: {}, createdAt: '', updatedAt: '' });

describe('商品组合编码页', () => {
  it('查看项打开真实专用详情，主列无源外复制控件，空态沿源文案', async () => {
    const bundle = mk(7, 'finance-bundles', { code: 'ZH-APPLE-2' });
    const line = mk(70, 'finance-bundle-lines', { role: 'main', qty: 2, unit: '个' }, { baseCodeId: '红富士1KG' });
    vi.mocked(resourceApi.list).mockImplementation(async (type) => (type === 'finance-platforms' ? {items:[],total:0,page:1,pageSize:200} : type === 'finance-bundle-lines' ? { items: [line], total: 1, page: 1, pageSize: 100 } : { items: [bundle], total: 1, page: 1, pageSize: 20 }) as never);
    vi.mocked(jstApi.bundleOverview).mockResolvedValue({ status: { pending: 1 } } as never);
    vi.mocked(jstApi.bundleComposition).mockResolvedValue({referenceDetail:{id:7,code:'ZH-APPLE-2',name:'详情组合',shortName:'',styleCode:'',mainStyleCode:'',platform:'',spec:'',lines:[{id:70,role:'main',name:'真实详情原料',code:'RAW',spec:'',qty:2,unit:'个',weightG:1000,isRawFinishedName:false}]}} as never);
    render(<BundlesPage />);
    await screen.findByText('ZH-APPLE-2',{selector:'td[data-label="组合编码"] strong'});
    expect(screen.queryByRole('button',{name:'复制组合编码'})).toBeNull();
    expect(document.querySelector('tr .code-row-more')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /查看 .* 项/ }));
    await screen.findByRole('heading',{name:'商品组合编码详情'});
    await screen.findByText('真实详情原料');
    expect(jstApi.bundleComposition).toHaveBeenCalledWith(7);
    expect(resourceApi.list).not.toHaveBeenCalledWith('finance-bundle-lines',expect.anything());
    expect(screen.queryByText('组合抽屉')).toBeNull();
    fireEvent.click(screen.getAllByRole('button',{name:'关闭'})[0]);
    vi.mocked(resourceApi.list).mockImplementation(async () => ({ items: [], total: 0, page: 1, pageSize: 20 }) as never);
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '没有' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByText('暂无组合编码');expect(screen.queryByRole('button',{name:'清除搜索和分类'})).toBeNull();expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('没有');
  });
  it('三页签、30条分页、查询才应用输入，末级分类带入新增且已验证禁批选',async()=>{
    const bundle=mk(7,'finance-bundles',{code:'ZH-PARITY'});
    vi.mocked(resourceApi.list).mockImplementation(async type=>{const items=type==='finance-bundles'?[bundle]:type==='finance-categories'?[{...mk(5,'finance-categories',{label:'合成末级分类',archiveType:'bundle'}),status:'active'}]:[];return{items,total:items.length,page:1,pageSize:200};});
    vi.mocked(jstApi.bundleOverview).mockResolvedValue({status:{pending:1,verified:2,reverify:3}});
    render(<BundlesPage/>);await screen.findByText('ZH-PARITY',{selector:'td[data-label="组合编码"] strong'});
    expect(screen.getAllByRole('tab').map(tab=>tab.textContent)).toEqual(['待验证1','已验证2','二次验证3']);
    expect(resourceApi.list).toHaveBeenCalledWith('finance-bundles',expect.objectContaining({pageSize:30}));
    expect(screen.queryByRole('button',{name:'新建组合编码'})).toBeNull();expect(screen.getByText('选择末级分类后可新增').className).toBe('bundle-list-create-hint');
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
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('查找草稿');
    await screen.findByText('ZH-PARITY',{selector:'td[data-label="组合编码"] strong'});
    expect(screen.queryByLabelText('本页全选')).toBeNull();
    expect(screen.queryByLabelText('勾选 ZH-PARITY')).toBeNull();
  });
  it('平台完整201条分页，详情消费完整GET不以当前页行截断',async()=>{
    const bundle=mk(7,'finance-bundles',{code:'ZH-FULL'});
    const platforms=Array.from({length:201},(_,i)=>({...mk(i+500,'finance-platforms',{label:'合成平台'+i}),status:'active'}));
    const lines=Array.from({length:201},(_,i)=>mk(i+700,'finance-bundle-lines',{qty:1,role:'main'},{baseCodeId:'合成构成'+i}));
    vi.mocked(resourceApi.list).mockImplementation(async(type,q)=>{
      const all=type==='finance-platforms'?platforms:type==='finance-bundle-lines'?lines:[bundle], page=q?.page??1;
      return{items:all.slice((page-1)*200,page*200),total:all.length,page,pageSize:200};
    });
    vi.mocked(jstApi.bundleOverview).mockResolvedValue({status:{pending:1}});
    render(<BundlesPage/>);await within(screen.getByRole('combobox',{name:'销售平台筛选'})).findByRole('option',{name:'合成平台200'});await screen.findByText('ZH-FULL',{selector:'td[data-label="组合编码"] strong'});

    vi.mocked(jstApi.bundleComposition).mockResolvedValue({referenceDetail:{id:7,code:'ZH-FULL',name:'完整详情',shortName:'',styleCode:'',mainStyleCode:'',platform:'',spec:'',lines:lines.map(line=>({id:line.id,role:'main',name:line.refLabels.baseCodeId,code:'',spec:'',qty:1,unit:'',weightG:null,isRawFinishedName:false}))}} as never);
    fireEvent.click(screen.getByRole('button',{name:/查看 .* 项/}));
    await screen.findByText('合成构成200');
    expect(resourceApi.list).toHaveBeenCalledWith('finance-platforms',expect.objectContaining({page:2}));
    expect(jstApi.bundleComposition).toHaveBeenCalledWith(7);
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
    expect(screen.queryByRole('button',{name:'合成组合'})).toBeNull();expect(screen.getByText('合成组合').closest('button')).toBeNull();
    expect(screen.getByText('¥7.000')).toBeTruthy();expect(screen.getByText('销售 ¥9.001')).toBeTruthy();expect(screen.getByText('0.525000 kg')).toBeTruthy();expect(screen.getByRole('button',{name:'查看 3 项'})).toBeTruthy();expect(screen.getByText('PK-1 包装 ×2')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map(head=>head.textContent)).toEqual(['','组合编码','主款式编码','款式编码','商品名称 / 简称','平台','规格','成本价 / 销售价','重量','组成','包装','状态','操作']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

});

describe('V2真实pending / verified / reverify主表合同',()=>{
 it('分类完整名称和分类标题、三态排序/分页选项、复验停用行也能选入批验',async()=>{
  const item={...mk(71,'finance-bundles',{code:'ZH-R',name:'复验合成',verificationState:'reverify',pendingRevisionId:99}),status:'inactive'};
  vi.mocked(resourceApi.list).mockImplementation(async type=>{const items=type==='finance-bundles'?[item]:type==='finance-categories'?[{...mk(5,'finance-categories',{name:'真实目录',archiveType:'bundle'}),title:'真实目录',status:'active'}]:[];return{items,total:items.length,page:1,pageSize:30};});vi.mocked(jstApi.bundleOverview).mockResolvedValue({status:{pending:0,verified:0,reverify:1}});vi.mocked(jstApi.bundleSummaries).mockResolvedValue({rows:[{id:71,mainStyleCode:null,weightG:1,componentCount:0,packageCount:0,packageSummary:'',issueCount:2}]});render(<BundlesPage/>);await screen.findByText('ZH-R',{selector:'td strong'});expect(screen.getByText('商品组合编码分类')).toBeTruthy();expect(within(screen.getByLabelText('每页条数')).getAllByRole('option').map(option=>option.textContent)).toEqual(['10','20','30','50']);fireEvent.click(screen.getByRole('button',{name:'真实目录 0'}));expect(screen.getByRole('heading',{name:'真实目录组合编码（1）'})).toBeTruthy();
  fireEvent.click(screen.getByRole('tab',{name:/二次验证\s*1/}));await screen.findByRole('button',{name:'验证（待补齐 2 项）'});expect(screen.getByRole('button',{name:'组成修改待验证'})).toBeTruthy();fireEvent.click(screen.getByLabelText('勾选 ZH-R'));expect(screen.getByRole('button',{name:'批量验证'}).hasAttribute('disabled')).toBe(false);expect(screen.queryByRole('button',{name:/批量验证（/})).toBeNull();
  const header=screen.getByRole('columnheader',{name:'组合编码'}),sort=within(header).getByRole('button');fireEvent.click(sort);expect(header.getAttribute('aria-sort')).toBe('ascending');fireEvent.click(sort);expect(header.getAttribute('aria-sort')).toBe('descending');fireEvent.click(sort);expect(header.getAttribute('aria-sort')).toBe('none');
 });
 it('已验证页用实际items ids读取badge和本页统计，不取陈旧row.jstStatus；无批选',async()=>{
  const items=[{...mk(71,'finance-bundles',{code:'ZH-SYNCED',jstStatus:'failed'}),status:'verified'},{...mk(72,'finance-bundles',{code:'ZH-FAILED',jstStatus:'synced'}),status:'verified'}];vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-bundles'?items:[],total:type==='finance-bundles'?2:0,page:1,pageSize:30}));vi.mocked(jstApi.bundleOverview).mockResolvedValue({status:{pending:0,verified:2,reverify:0}});vi.mocked(api).mockImplementation(async path=>String(path).startsWith('/finance/jst-sync/items?')?{rows:[{id:71,state:'synced'},{id:72,state:'failed'}]}:{rows:[]} as never);render(<BundlesPage/>);await screen.findByText('ZH-SYNCED',{selector:'td strong'});expect(api).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('tab',{name:/已验证\s*2/}));await screen.findByRole('button',{name:'同步成功'});const table=screen.getByRole('table');expect(within(table).getAllByRole('columnheader')).toHaveLength(12);expect(within(table).queryByRole('checkbox')).toBeNull();expect(screen.queryByText('已选 0 条')).toBeNull();expect(screen.getByRole('button',{name:'同步失败'})).toBeTruthy();const summary=screen.getByRole('status',{name:'本页聚水潭同步统计'});expect(summary.textContent).toContain('同步成功 1 条');expect(summary.textContent).toContain('同步失败 1 条');expect(api).toHaveBeenCalledWith(expect.stringContaining('ids=71%2C72'));expect(screen.queryByRole('button',{name:'批量验证'})).toBeNull();expect(within(table).getAllByRole('button',{name:'同步'})).toHaveLength(2);
 });
 it('查询中不可重复提交；批选上限50保留源限制',async()=>{
  const items=Array.from({length:51},(_,i)=>mk(i+1,'finance-bundles',{code:'ZH-'+i}));vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-bundles'?items:[],total:type==='finance-bundles'?51:0,page:1,pageSize:50}));vi.mocked(jstApi.bundleOverview).mockResolvedValue({status:{pending:51}});render(<BundlesPage/>);expect(screen.getByRole('button',{name:'查询中...'}).hasAttribute('disabled')).toBe(true);await screen.findByText('ZH-0',{selector:'td strong'});fireEvent.click(screen.getByLabelText('本页全选'));expect(screen.getByText('已选 50 条')).toBeTruthy();fireEvent.click(screen.getByLabelText('勾选 ZH-50'));expect(screen.getByText('已选 51 条')).toBeTruthy();expect(screen.getByRole('button',{name:'批量验证'}).hasAttribute('disabled')).toBe(true);
 });
});

it('按真源树计数只取phase：停用/keyword筛到空列表不清空目录counts',async()=>{const item=mk(71,'finance-bundles',{code:'ZH-TREE',bundleCategoryId:18});vi.mocked(resourceApi.list).mockImplementation(async(type,q)=>{const items=type==='finance-bundles'?(q?.filters?.enabledState==='inactive'||q?.keyword?[]:[item]):type==='finance-categories'?[{...mk(18,'finance-categories',{name:'固定phase目录',archiveType:'bundle'}),title:'固定phase目录',status:'active'}]:[];return{items,total:items.length,page:1,pageSize:30};});vi.mocked(jstApi.bundleOverview).mockResolvedValue({status:{pending:1},verification:{pending:1},byBundleLifecycleCategory:{18:{pending:{active:1,inactive:0}}}});render(<BundlesPage/>);await screen.findByText('ZH-TREE',{selector:'td strong'});expect(screen.getByRole('button',{name:'固定phase目录 1'})).toBeTruthy();fireEvent.change(screen.getByRole('combobox',{name:'状态筛选'}),{target:{value:'inactive'}});fireEvent.click(screen.getByRole('button',{name:'查询'}));await screen.findByText('暂无组合编码');expect(screen.getByRole('button',{name:'固定phase目录 1'})).toBeTruthy();fireEvent.change(screen.getByLabelText('搜索'),{target:{value:'不存在'}});fireEvent.click(screen.getByRole('button',{name:'查询'}));await screen.findByText('暂无组合编码');expect(screen.getByRole('button',{name:'固定phase目录 1'})).toBeTruthy();});
