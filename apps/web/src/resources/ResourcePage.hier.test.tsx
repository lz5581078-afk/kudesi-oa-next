import { act, cleanup, fireEvent, render, screen, waitFor,within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import {api as jsonApi} from '../api/client';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../api/client',async orig=>{const actual=await orig<typeof import('../api/client')>();return{...actual,api:vi.fn((path:string,options?:Parameters<typeof actual.api>[1])=>path.startsWith('/user-preferences/')?Promise.resolve({value:{categoryOrders:{},itemOrders:{}}}):path==='/finance/fee-archive/snapshots'?Promise.resolve([]):actual.api(path,options))};});
vi.mock('./csv',async orig=>({...await orig<typeof import('./csv')>(),downloadText:vi.fn()}));
const formProps = vi.fn();
vi.mock('./RecordForm', async (orig) => {
  const mod = await orig<typeof import('./RecordForm')>();
  return { ...mod, RecordForm: (p: { initial?: Record<string, unknown>; record?: { title: string } | null }) => { formProps(p); return <div>{p.record ? `编辑表单:${p.record.title}` : '新增表单'}</div>; }, loadRefOptions: async () => [] };
});
const treeProps = vi.fn();
let leafValue = false;
vi.mock('./CategoryTree', async () => {
  const React = await import('react');
  return { CategoryTree: (p: { rootId?: number; hint?: string; onLeaf?: (v: boolean) => void; onSelect: (k: string, id: string) => void; values: Record<string, string> }) => {
    treeProps(p);
    React.useEffect(() => { p.onLeaf?.(leafValue); }, [p.onLeaf]);
    return <div data-testid="tree">{p.hint}<button onClick={()=>p.onSelect('categoryIds','3')}>切换测试末级</button><button onClick={() => p.onSelect('categoryIds', '')}>全部</button><i data-testid="val">{p.values.categoryIds ?? ''}</i></div>;
  } };
});
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), get:vi.fn(), import:vi.fn(), users: vi.fn().mockResolvedValue([]), changeStatus: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({ ok: true }), export:vi.fn().mockResolvedValue({filename:'合成.csv',csv:'',count:1}) } };
});
import { ResourcePage } from './ResourcePage';

const row = (id: number, name: string, status = 'active') => ({ id, type: 'finance-suppliers', title: name, status, statusReason: null, data: { name, code: `GYS-00${id}`, shortName: '简', categoryIds: [3] }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' });
const hier = { title: '种子供应商', subtitle: '种子相关', rootId: 1, onBack: vi.fn() };
const renderIt = () => render(<MemoryRouter><ResourcePage type="finance-suppliers" hier={hier} /></MemoryRouter>);

it.each([['raw','原料'],['shipping_material','发货物料'],['self_made','自产成品'],['original_purchase','外购成品'],['supplier_oem','外购成品'],['package','产品包装'],['oem_package','OEM包装']])('原版商品%s六项资料操作保持文件入口，导出不夹带表内筛选',async(family,noun)=>{
 const product={...row(501,'合成商品'),type:'finance-products',data:{name:'合成商品',code:'HC-PRODUCT',basicInfoFullName:'合成商品全名',archiveType:['original_purchase','supplier_oem'].includes(family)?'purchased':family,supplyMode:family,categoryId:3}};
 vi.mocked(resourceApi.list).mockResolvedValue({items:[product],total:1,page:1,pageSize:30} as never);
 render(<MemoryRouter><ResourcePage type="finance-products" lockedTab={family} hier={{title:'合成商品档案',subtitle:'',onBack:vi.fn()}}/></MemoryRouter>);
 await screen.findByText('合成商品全名');
 fireEvent.click(screen.getByText('资料操作',{exact:true}));
 const menu=screen.getByText('资料操作',{exact:true}).closest('details')!;
 expect(Array.from(menu.querySelectorAll('button')).map(button=>button.textContent)).toEqual([`导入${noun}`,'下载空白模板','下载填写示例','下载成本模板','导入成本',`导出${noun}`]);
 expect(within(menu).queryByRole('searchbox')).toBeNull();
 expect(within(menu).queryByText(/行高|表格编辑|高级筛选/)).toBeNull();
 fireEvent.click(within(menu).getByRole('button',{name:`导出${noun}`}));
 await waitFor(()=>expect(resourceApi.export).toHaveBeenCalledWith('finance-products',false,{referenceArchive:true,tab:family}));
 expect(screen.getByLabelText('导入商品档案原版文件').getAttribute('accept')).toContain(family==='self_made'?'.xlsx,.csv':'.csv');
});

beforeEach(() => {
  leafValue = false;
  vi.mocked(resourceApi.get).mockImplementation(async(_type,id)=>row(id,id===1?'润农':'绿源',id===1?'active':'inactive'));
  vi.mocked(resourceApi.list).mockResolvedValue({ items: [row(1, '润农'), row(2, '绿源', 'inactive')], total: 2, page: 1, pageSize: 20 } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('分级布局下的列表页', () => {
  it('页头有返回上一级和顶级分类名；目录收到顶级分类 id 和“最末级才能新增”的提示；列表按顶级分类筛', async () => {
    renderIt();
    await screen.findByText('润农');
    expect(screen.getByRole('heading', { name: '种子供应商' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回上一级' }));
    expect(hier.onBack).toHaveBeenCalled();
    expect(treeProps.mock.calls.at(-1)![0]).toMatchObject({ rootId: 1, hint: '请选择最末级分类后新增供应商' });
    await waitFor(() => expect(vi.mocked(resourceApi.list).mock.calls.some((c) => c[1]?.filters?.categoryIds === '1')).toBe(true));
    // 顶级分类本身不算“筛选条件”，不出现“清除全部条件”
    expect(screen.queryByText(/找到 \d+ 条符合条件/)).toBeNull();
  });

  it('往来资料操作按原版只列导入导出，新增及显示停用仍可直接操作', async () => {
    renderIt();
    await screen.findByText('润农');
    expect(screen.queryByRole('button', { name: '＋ 新增' })).toBeNull();
    expect(screen.getByRole('button', { name: '显示停用' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '资料操作' }));
    expect(screen.queryByRole('searchbox', { name: '搜索' })).toBeNull();
    expect(screen.queryByRole('button', { name: '筛选' })).toBeNull();
    expect(screen.queryByRole('button', { name: /行高/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '表格编辑' })).toBeNull();
    expect(screen.getByRole('button', { name: '导入' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出' })).toBeTruthy();
  });

  it('没选到最末级分类时不显示新增；选到最末级才打开表单', async () => {
    renderIt();
    await screen.findByText('润农');
    expect(screen.queryByRole('button', { name: '＋ 新增' })).toBeNull();
    expect(screen.queryByText('新增表单')).toBeNull();
    cleanup(); leafValue = true;
    renderIt();
    await screen.findByText('润农');
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增' }));
    await screen.findByText('新增表单');
  });

  it('每行有 查看/编辑/复制新增/停用或启用/删除；复制新增不带编号；编辑打开该行的表单', async () => {
    renderIt();
    await screen.findByText('润农');
    expect(screen.getByRole('button', { name: '停用：润农' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '启用：绿源' })).toBeTruthy(); // 停用的是“启用”
    fireEvent.click(screen.getByRole('button', { name: '编辑：润农' }));
    await waitFor(()=>expect(resourceApi.get).toHaveBeenCalledWith('finance-suppliers',1));
    await screen.findByText('编辑表单:润农');
    expect(formProps.mock.calls.at(-1)![0].record).toMatchObject({id:1,data:{name:'润农'}});
    cleanup(); formProps.mockClear();
    renderIt();
    await screen.findByText('润农');
    fireEvent.click(screen.getByRole('button', { name: '复制新增：润农' }));
    await screen.findByText('新增表单');
    const init = formProps.mock.calls.at(-1)![0].initial as Record<string, unknown>;
    expect(init.name).toBe('润农');
    expect(init.categoryIds).toEqual([3]);
    expect(init.code).toBeUndefined();
  });

  it('行内停用要写原因，写完调用状态接口；删除要写原因', async () => {
    renderIt();
    await screen.findByText('润农');
    fireEvent.click(screen.getByRole('button', { name: '停用：润农' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '不再合作' } });
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }));
    await waitFor(() => expect(resourceApi.changeStatus).toHaveBeenCalledWith('finance-suppliers', 1, 'inactive', '不再合作'));
    fireEvent.click(screen.getByRole('button', { name: '删除：绿源' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(resourceApi.remove).toHaveBeenCalledWith('finance-suppliers', 2, '财务档案页面删除',undefined));
  });

  it('勾选后批量删除沿原资料确认，不添加原因输入，逐条保留失败保护', async () => {
    renderIt();
    await screen.findByText('润农');
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[1]); fireEvent.click(boxes[2]);
    fireEvent.click(await screen.findByRole('button', { name: '批量删除 2' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(await screen.findByText('已选择 2 个供应商')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(resourceApi.remove).toHaveBeenCalledTimes(2));
    expect(resourceApi.remove).toHaveBeenCalledWith('finance-suppliers', 1, '财务档案页面批量删除',undefined);
  });

  it('不是分级布局时（如在别处嵌入）没有这些行内操作', async () => {
    render(<MemoryRouter><ResourcePage type="finance-suppliers" /></MemoryRouter>);
    await screen.findByText('润农');
    expect(screen.queryByRole('button', { name: '复制新增：润农' })).toBeNull();
    expect(screen.queryByRole('button', { name: '返回上一级' })).toBeNull();
  });
});

it('24号默认供应商前七列、30条分页和未选项批量禁用，空父级不提供新增',async()=>{
 vi.mocked(resourceApi.list).mockResolvedValue({items:[],total:0,page:1,pageSize:30});renderIt();
 await waitFor(()=>expect(vi.mocked(resourceApi.list).mock.calls.some(([,q])=>q?.pageSize===30)).toBe(true));
 expect((screen.getByRole('button',{name:'移动分类'}) as HTMLButtonElement).disabled).toBe(true);
 expect((screen.getByRole('button',{name:'批量删除'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.queryByRole('button',{name:/新增/})).toBeNull();
 expect(screen.getByRole('columnheader',{name:'账户名称'})).toBeTruthy();
 expect(screen.queryByRole('columnheader',{name:'状态'})).toBeNull();
 expect(screen.queryByRole('columnheader',{name:'供应商分类'})).toBeNull();
 expect(screen.queryByRole('combobox',{name:'每页条数'})).toBeNull();
});

it('客户默认字段和状态排序沿统一列表请求，候选不添加新系统额外字段',async()=>{
 vi.mocked(resourceApi.list).mockResolvedValue({items:[{...row(4,'合成客户'),type:'finance-customers'}],total:1,page:1,pageSize:30});
 render(<MemoryRouter><ResourcePage type="finance-customers" hier={{...hier,title:'店铺客户'}}/></MemoryRouter>);
 await screen.findByText('合成客户');expect(screen.getByRole('columnheader',{name:'联系电话'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'状态'}));await waitFor(()=>expect(vi.mocked(resourceApi.list).mock.calls.some(([,q])=>q?.sortBy==='$status'&&q.sortDir==='asc')).toBe(true));
 fireEvent.click(screen.getByRole('button',{name:'显示字段'}));expect(screen.getByRole('checkbox',{name:'操作'})).toBeTruthy();expect((screen.getByRole('checkbox',{name:'操作'}) as HTMLInputElement).disabled).toBe(true);
 expect(screen.queryByRole('checkbox',{name:'客户简称'})).toBeNull();expect(screen.queryByRole('checkbox',{name:'客户分类'})).toBeNull();
});

it('跨页勾选保留原行真实版本，切换目录后清空，未用当前页猜被删记录版本',async()=>{
 const first={...row(41,'跨页第一项'),version:'selected-v1'},second={...row(42,'跨页第二项'),version:'page2-v1'};
 vi.mocked(resourceApi.list).mockImplementation(async(_type,q)=>({items:q?.page===2?[second]:[first],total:31,page:q?.page??1,pageSize:30}));renderIt();
 await screen.findByText('跨页第一项');fireEvent.click(screen.getByRole('checkbox',{name:'勾选 跨页第一项'}));fireEvent.click(screen.getByRole('button',{name:'下一页'}));await screen.findByText('跨页第二项');
 fireEvent.click(screen.getByRole('button',{name:'批量删除 1'}));fireEvent.click(screen.getByRole('button',{name:'确认删除'}));await waitFor(()=>expect(resourceApi.remove).toHaveBeenCalledWith('finance-suppliers',41,'财务档案页面批量删除','selected-v1'));
 fireEvent.click(screen.getByRole('checkbox',{name:'勾选 跨页第二项'}));fireEvent.click(screen.getByRole('button',{name:'切换测试末级'}));await waitFor(()=>expect((screen.getByRole('button',{name:'批量删除'}) as HTMLButtonElement).disabled).toBe(true));
});
it('费用原工具栏、30条分页及多条搜索完整短语沿统一API，导出不套表内搜索',async()=>{
 vi.mocked(resourceApi.list).mockResolvedValue({items:[{...row(44,'合成费用'),type:'finance-fee-items'}],total:1,page:1,pageSize:30});
 render(<MemoryRouter><ResourcePage type="finance-fee-items" hier={{...hier,title:'运行支撑费用'}}/></MemoryRouter>);
 await screen.findByText('合成费用');expect(screen.getByRole('heading',{name:'运行支撑费用直属费用档案'})).toBeTruthy();
 expect(screen.queryByRole('button',{name:'资料操作'})).toBeNull();expect(screen.getByRole('button',{name:'导入'})).toBeTruthy();expect((screen.getByRole('button',{name:'移动分类'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.queryByRole('combobox',{name:'每页条数'})).toBeNull();fireEvent.click(within(screen.getByRole('region',{name:'费用档案列表'})).getByRole('button',{name:'打开多条搜索'}));fireEvent.change(screen.getByRole('textbox',{name:'多条搜索内容'}),{target:{value:'办公费用 A\n运输'}});fireEvent.click(screen.getByRole('button',{name:'开始搜索'}));
 await waitFor(()=>expect(vi.mocked(resourceApi.list).mock.calls.some(([,q])=>q?.referenceSearch==='办公费用 A\n运输'&&q.pageSize===30)).toBe(true));
 fireEvent.click(screen.getByRole('button',{name:'导出'}));await waitFor(()=>expect(resourceApi.export).toHaveBeenCalledWith('finance-fee-items',false,expect.objectContaining({keyword:undefined,filters:{categoryId:'1'}})));
});

it('快速切换分类后旧请求晚到不能覆盖新目录',async()=>{
 let resolveOld!:(value:Awaited<ReturnType<typeof resourceApi.list>>)=>void;
 vi.mocked(resourceApi.list).mockImplementation(async(type,q)=>{if(type!=='finance-suppliers')return{items:[],total:0,page:1,pageSize:30};if(q?.filters?.categoryIds==='3')return{items:[row(52,'新目录资料')],total:1,page:1,pageSize:30};return new Promise(resolve=>{resolveOld=resolve;});});
 renderIt();await waitFor(()=>expect(resolveOld).toBeTypeOf('function'));fireEvent.click(screen.getByRole('button',{name:'切换测试末级'}));await screen.findByText('新目录资料');
 await act(async()=>{resolveOld({items:[row(51,'旧目录晚到资料')],total:1,page:1,pageSize:30});});
 expect(screen.queryByText('旧目录晚到资料')).toBeNull();expect(screen.getByText('新目录资料')).toBeTruthy();
});

function referenceCsv(body:string){const file=new File([body],'合成.csv',{type:'text/csv'});file.arrayBuffer=async()=>new TextEncoder().encode(body).buffer as ArrayBuffer;return file;}
it('原版导入直接读CSV、跳过空名称、失败可重选，不再插入通用预检窗口',async()=>{
 const alert=vi.spyOn(window,'alert').mockImplementation(()=>{});
 vi.mocked(resourceApi.import).mockResolvedValueOnce({committed:false,created:0,updated:0,failed:1,results:[{line:2,action:'error',errors:['合成错误']}]} as never).mockResolvedValueOnce({committed:true,created:1,updated:0,failed:0,results:[]} as never);
 renderIt();await screen.findByText('润农');const input=screen.getByLabelText('导入原版CSV');
 const file=referenceCsv('供应商名称,联系电话\n合成供应商,13000000000\n,\n');
 fireEvent.change(input,{target:{files:[file]}});await waitFor(()=>expect(alert).toHaveBeenCalledWith('导入失败：第2行：合成错误'));
 expect(resourceApi.import).toHaveBeenCalledWith('finance-suppliers',[{'供应商名称':'合成供应商','联系电话':'13000000000'}],false,false,undefined,{categoryId:1});
 expect(screen.queryByText(/拖到这里/)).toBeNull();fireEvent.change(input,{target:{files:[file]}});await waitFor(()=>expect(alert).toHaveBeenCalledWith('导入完成，共处理 1 条资料'));alert.mockRestore();
});
it('读取文件期间离开资料页，不把迟到文件提交到新页面',async()=>{
 const alert=vi.spyOn(window,'alert').mockImplementation(()=>{});let release!:(value:ArrayBuffer)=>void;
 const file=referenceCsv('供应商名称\n合成');file.arrayBuffer=()=>new Promise(resolve=>{release=resolve;});
 renderIt();await screen.findByText('润农');fireEvent.change(screen.getByLabelText('导入原版CSV'),{target:{files:[file]}});cleanup();
 await act(async()=>release(new TextEncoder().encode('供应商名称\n合成').buffer as ArrayBuffer));expect(resourceApi.import).not.toHaveBeenCalled();expect(alert).not.toHaveBeenCalled();alert.mockRestore();
});
it('费用资料拖动先完整读取当前目录，把未显示行保留到本人偏好，未调用共享资料排序',async()=>{
 const all=[701,702,703].map(id=>({...row(id,`合成拖动${id}`),type:'finance-fee-items',data:{code:`FY-${id}`,name:`合成拖动${id}`,categoryId:1}}));
 vi.mocked(resourceApi.list).mockImplementation(async(type,q)=>({items:type==='finance-fee-items'?q?.pageSize===200?all:all.slice(0,2):[],total:type==='finance-fee-items'?3:0,page:1,pageSize:q?.pageSize||30}));
 render(<MemoryRouter><ResourcePage type="finance-fee-items" hier={{...hier,title:'合成费用'}}/></MemoryRouter>);await screen.findByText('合成拖动701');
 const from=screen.getByText('合成拖动702').closest('tr')!,to=screen.getByText('合成拖动701').closest('tr')!;expect(from.draggable).toBe(true);fireEvent.dragStart(from,{dataTransfer:{effectAllowed:''}});fireEvent.dragOver(to);fireEvent.drop(to);
 await waitFor(()=>expect(jsonApi).toHaveBeenCalledWith('/user-preferences/finance-expense-sort-v1',{method:'PUT',body:{value:{categoryOrders:{},itemOrders:{'1':['702','701','703']}}}}));
 expect(vi.mocked(resourceApi.list).mock.calls.some(([type,q])=>type==='finance-fee-items'&&q?.pageSize===200&&q.referenceOrder&&q.filters?.categoryId==='1')).toBe(true);
 await waitFor(()=>expect(within(screen.getByRole('region',{name:'费用档案列表'})).getAllByRole('row')[1].textContent).toContain('合成拖动702'));
});
