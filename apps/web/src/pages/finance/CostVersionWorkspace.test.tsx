import { cleanup,fireEvent,render,screen,waitFor,within,act } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { resourceApi,type ResourceDto } from '../../resources/api';
import { MemoryRouter } from 'react-router-dom';
import { CostVersionWorkspace } from './CostVersionWorkspace';
import { costVersionsApi,type VersionPreview } from './costVersionsApi';

vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({can:()=>true})}));
vi.mock('../../resources/RecordDetail',()=>({useResourceCan:()=>()=>true}));
vi.mock('./CostSkuEditor',()=>({CostSkuEditor:({record}:{record:ResourceDto | null})=><div role="dialog" aria-label="SKU计算设置">{JSON.stringify(record?.data)}</div>}));
vi.mock('../../resources/RecordForm',()=>({RecordForm:({initial}:{initial:unknown})=><div role="dialog" aria-label="资料表单">{JSON.stringify(initial)}</div>,ReasonDialog:()=>null}));
vi.mock('../../resources/api',()=>({resourceApi:{list:vi.fn(),get:vi.fn(),update:vi.fn(),changeStatus:vi.fn()}}));
vi.mock('./costVersionsApi',()=>({costVersionsApi:{preview:vi.fn(),recalculatePreview:vi.fn(),recalculate:vi.fn(),activate:vi.fn(),copy:vi.fn(),sources:vi.fn(),register:vi.fn(),export:vi.fn()},downloadCostWorkbook:vi.fn()}));
const version=(id=1,status='draft'):ResourceDto=>({id,type:'finance-cost-versions',title:`秋季成本${id}`,status,statusReason:null,data:{versionCode:`CB${id}`,versionName:`秋季成本${id}`,defaultMarkupPercent:33.333333,...(status==='draft'?{}:{lockedAt:'2026-10-31T01:00:00Z',isDefault:true})},secretConfigured:{},refLabels:{},files:{},createdAt:'',updatedAt:''});
const preview=(id=1):VersionPreview=>({ready:true,signature:`signature-${id}`,activationSignature:`activation-${id}`,issues:[],locked:false,rows:[{settingId:id,bundleId:id,skuId:id,skuType:'bundle',code:`ZH-${id}`,name:`商品${id}`,weightG:1000,markupPercent:20,preShipCostCents:1000,freightCents:200,costIncludingFreightCents:1200,minPriceCents:1440,buckets:{purchase:1000,transfer:0,pre_ship_package:0,production:0,shipping_package:0,express:200},issues:[],lines:[]} as never]});
beforeEach(()=>{vi.mocked(resourceApi.list).mockResolvedValue({items:[version()],total:1,page:1,pageSize:200});vi.mocked(costVersionsApi.preview).mockResolvedValue(preview());vi.mocked(costVersionsApi.activate).mockResolvedValue({id:1});});
afterEach(()=>{cleanup();vi.resetAllMocks();});
const renderPage=()=>render(<MemoryRouter><CostVersionWorkspace/></MemoryRouter>);

describe('成本版本工作区',()=>{
  it('从版本进入公司底价和SKU成本，启用前先预检并确认具体签名',async()=>{
    renderPage();await screen.findByText('秋季成本1');
    fireEvent.click(screen.getByRole('button',{name:'启用并锁定'}));
    const dialog=await screen.findByRole('dialog',{name:'启用并锁定「秋季成本1」'});
    fireEvent.click(await within(dialog).findByRole('button',{name:'确认启用并锁定'}));
    await waitFor(()=>expect(costVersionsApi.activate).toHaveBeenCalledWith(1,'activation-1'));
  });
  it('预检有阻断项时不能启用',async()=>{
    vi.mocked(costVersionsApi.preview).mockResolvedValue({...preview(),ready:false,issues:['ZH-1：缺少快递成本']});renderPage();
    fireEvent.click(await screen.findByRole('button',{name:'启用并锁定'}));
    const button=await screen.findByRole('button',{name:'请先处理阻断项'});expect(button.hasAttribute('disabled')).toBe(true);expect(costVersionsApi.activate).not.toHaveBeenCalled();
  });
  it('锁定版本只读，不能显示可修改成本或批量清空的按钮',async()=>{
    vi.mocked(resourceApi.list).mockResolvedValue({items:[version(1,'active')],total:1,page:1,pageSize:200});renderPage();
    fireEvent.click((await screen.findAllByRole('button',{name:'SKU成本'}))[0]);await screen.findByText('ZH-1');
    for(const name of ['编辑成本','选择SKU设置','导入SKU成本','清空版本成本'])expect(screen.queryByRole('button',{name})).toBeNull();
    expect(screen.getByText(/显示启用时锁定的成本/)).toBeTruthy();
  });
  it('编辑版本保留原加价率和默认状态，编辑组合SKU保留其类型',async()=>{
    renderPage();fireEvent.click(await screen.findByRole('button',{name:'编辑'}));
    expect(screen.getByRole('dialog',{name:'资料表单'}).textContent).toContain('33.333333');
    cleanup();vi.mocked(resourceApi.get).mockResolvedValue({...version(),id:1,type:'finance-cost-skus',data:{versionId:1,skuType:'bundle',bundleId:99,purchaseCost:777}});
    renderPage();fireEvent.click(await screen.findByRole('button',{name:'SKU成本'}));fireEvent.click(await screen.findByRole('button',{name:'编辑成本'}));
    await waitFor(()=>expect(screen.getByRole('dialog',{name:'SKU计算设置'}).textContent).toContain('"skuType":"bundle"'));
    expect(screen.getByRole('dialog',{name:'SKU计算设置'}).textContent).toContain('777');
  });
  it('重算先展示差异和非阻断提醒，再按预检签名确认更新',async()=>{
    vi.mocked(costVersionsApi.recalculatePreview).mockResolvedValue({rows:[{skuType:'bundle',skuId:1,code:'ZH-1',name:'商品1',settingId:1,previous:1200,proposed:1300,issues:[]}],signature:'recalculate-signature',ready:true,issues:[],warnings:['ZH-1：预计重量为0'],businessDate:'2026-10-31',changed:1});
    vi.mocked(costVersionsApi.recalculate).mockResolvedValue({updated:1,created:0});renderPage();
    fireEvent.click(await screen.findByRole('button',{name:'SKU成本'}));await screen.findByText('ZH-1');
    fireEvent.click(screen.getByRole('button',{name:'预检自动重算'}));
    const dialog=await screen.findByRole('dialog',{name:'自动重算差异预检'});
    expect(costVersionsApi.recalculate).not.toHaveBeenCalled();expect(within(dialog).getByText('查看非阻断提醒（1）')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button',{name:'确认按预检结果更新成本快照'}));
    await waitFor(()=>expect(costVersionsApi.recalculate).toHaveBeenCalledWith(1,'recalculate-signature'));
  });
  it('快速切换版本时，慢到达的旧响应不会覆盖当前SKU',async()=>{
    let resolveFirst!:(r:VersionPreview)=>void;
    vi.mocked(resourceApi.list).mockResolvedValue({items:[version(1),version(2)],total:2,page:1,pageSize:200});
    vi.mocked(costVersionsApi.preview).mockImplementation(id=>id===1?new Promise(resolve=>{resolveFirst=resolve;}):Promise.resolve(preview(2)));
    renderPage();fireEvent.click(within((await screen.findByText('秋季成本1')).closest('tr')!).getByRole('button',{name:'SKU成本'}));
    fireEvent.click(screen.getByRole('button',{name:'返回成本版本'}));fireEvent.click(within(screen.getByText('秋季成本2').closest('tr')!).getByRole('button',{name:'SKU成本'}));
    await screen.findByText('ZH-2');await act(async()=>{resolveFirst(preview(1));});expect(screen.queryByText('ZH-1')).toBeNull();expect(screen.getByText('ZH-2')).toBeTruthy();
  });
});
