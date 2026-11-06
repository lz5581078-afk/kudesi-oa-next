import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DesktopAfterSalesPage} from './DesktopAfterSalesPage';
import {api} from '../../api/client';
vi.mock('../../api/client',()=>({api:vi.fn()}));
const mock=vi.mocked(api);
const archive=(id=1,version=2)=>({id,version,storeId:10,storeName:'演示店',snapshot:{afterSaleId:String(85110000+id),internalOrderId:String(4400000+id),sourceCompany:'演示公司',capturedAt:'2026-11-04T10:00:00Z',fields:{线上状态:'等待退货'}},progress:'等待物流',ownerId:null,ownerName:'',nextAt:null,updatedAt:'2026-11-04T10:00:00Z',events:[],files:[]});
let shotCallback:(v:{id:number;afterSaleId:string;image:string})=>void;
beforeEach(()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 window.oaDesktop={version:'0.1.0',preferences:vi.fn().mockResolvedValue({shortcut:'CommandOrControl+Shift+S',registered:true}),zoom:vi.fn().mockResolvedValue(true),mount:vi.fn().mockResolvedValue(true),hide:vi.fn().mockResolvedValue(true),context:vi.fn().mockResolvedValue(true),read:vi.fn().mockResolvedValue([{...archive().snapshot}]),refresh:vi.fn().mockResolvedValue(true),openOrder:vi.fn().mockResolvedValue(true),screenshot:vi.fn().mockResolvedValue(true),shortcut:vi.fn().mockResolvedValue(true),clearLogin:vi.fn().mockResolvedValue(true),onScreenshot:cb=>{shotCallback=cb;return vi.fn();}};
 mock.mockImplementation(async path=>{
  if(path==='/desktop-after-sales-collection')return [];
  if(path.endsWith('/options'))return {stores:[{id:10,name:'演示店'}],people:[]};
  if(path.includes('?'))return {total:2,rows:[1,2].map(id=>({...archive(id).snapshot,id,progress:'等待物流'}))};
  if(path.endsWith('/1'))return archive();if(path.endsWith('/2'))return archive(2);
  if(path.endsWith('/1/files'))return {...archive(1,3),files:[{id:77,name:'截图.png',size:100,mime:'image/png'}]};
  return archive();
 });
});
afterEach(()=>{cleanup();delete window.oaDesktop;vi.restoreAllMocks();vi.unstubAllGlobals();mock.mockReset();});
async function choose(id=1){await screen.findByText(String(85110000+id));fireEvent.click(screen.getByText(String(85110000+id)));await screen.findByText(`售后 ${85110000+id}`);await waitFor(()=>expect((screen.getByLabelText('处理到哪一步') as HTMLInputElement).disabled).toBe(false));}
it('浏览器可直接查看档案并保存跟进',async()=>{
 delete window.oaDesktop;
 render(<DesktopAfterSalesPage/>);
 await choose();
 fireEvent.change(screen.getByLabelText('本次处理记录'),{target:{value:'网页跟进'}});
 fireEvent.click(screen.getByText('保存跟进'));
 await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/follow',expect.objectContaining({body:expect.objectContaining({note:'网页跟进'})})));
 expect(screen.queryByRole('button',{name:'打开本机聚水潭工具'})).toBeNull();
});
it('桌面客户端访问网页时先显示工作台，只有主动点击才打开本机工具',async()=>{
 const desktop=window.oaDesktop!;
 desktop.surface='main';
 desktop.openAfterSales=vi.fn().mockResolvedValue(true);
 render(<DesktopAfterSalesPage/>);
 await screen.findByText('85110001');
 expect(desktop.preferences).not.toHaveBeenCalled();
 expect(desktop.openAfterSales).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'打开本机聚水潭工具'}));
 await waitFor(()=>expect(desktop.openAfterSales).toHaveBeenCalledOnce());
});
it('独立售后窗口默认挂载聚水潭原页，并能切换回 OA 档案',async()=>{
 const desktop=window.oaDesktop!;
 desktop.surface='after-sales';
 desktop.openSourceAfterSales=vi.fn().mockResolvedValue(true);
 render(<DesktopAfterSalesPage/>);
 const toolbar=screen.getByRole('group',{name:'售后功能区'});
 await waitFor(()=>expect(desktop.openSourceAfterSales).toHaveBeenCalledOnce());
 expect(desktop.mount).toHaveBeenCalledOnce();
 expect(screen.queryByRole('table')).toBeNull();
 fireEvent.click(within(toolbar).getByRole('button',{name:'OA 售后档案'}));
 await screen.findByRole('table');
 await waitFor(()=>expect(desktop.hide).toHaveBeenCalledOnce());
});
it('建档前必须选择正确 OA 店铺并确认来源公司，内部订单通过原页面打开',async()=>{
 render(<DesktopAfterSalesPage/>);await choose();fireEvent.click(within(screen.getByRole('dialog',{name:'售后 85110001'})).getByText('4400001'));await waitFor(()=>expect(window.oaDesktop!.openOrder).toHaveBeenCalledWith('4400001'));
 fireEvent.click(screen.getByText('读取当前页面'));await screen.findByText('读取结果 · 1 条');
 fireEvent.click(screen.getByText('确认关联并保存到 OA'));await screen.findByRole('alert');expect(mock.mock.calls.some(([p])=>p==='/desktop-after-sales/import')).toBe(false);
 fireEvent.change(screen.getAllByLabelText('关联 OA 店铺')[0],{target:{value:'10'}});fireEvent.click(screen.getByText('确认关联并保存到 OA'));
 await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales/import',expect.objectContaining({method:'POST',body:expect.objectContaining({storeId:10,snapshot:expect.objectContaining({sourceCompany:'演示公司'})})})));
});
it('切换后旧截图不得上传到新售后',async()=>{
 render(<DesktopAfterSalesPage/>);await choose(2);shotCallback({id:1,afterSaleId:'85110001',image:'data:image/png;base64,AAAA'});
 await screen.findByText(/截图对应的售后已切换/);expect(mock.mock.calls.some(([p])=>p.endsWith('/files'))).toBe(false);
});
it('上传凭证后保留未保存的备注，并使用更新后的版本提交',async()=>{
 render(<DesktopAfterSalesPage/>);await choose();fireEvent.change(screen.getByLabelText('本次处理记录'),{target:{value:'买家说明天寄回'}});
 fireEvent.change(screen.getByLabelText('上传凭证'),{target:{files:[new File(['x'],'截图.png',{type:'image/png'})]}});
 await screen.findByText('截图.png');expect((screen.getByLabelText('本次处理记录') as HTMLTextAreaElement).value).toBe('买家说明天寄回');
 fireEvent.click(screen.getByText('保存跟进'));await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/follow',expect.objectContaining({body:expect.objectContaining({version:3,note:'买家说明天寄回'})})));
});
it('凭证上传期间其他人更新进度，不会悄悄把旧草稿升级为可覆盖的新版本',async()=>{
 const impl=mock.getMockImplementation()!;
 mock.mockImplementation(async(p,o)=>p.endsWith('/1/files')?{...archive(1,4),progress:'其他人已联系仓库',files:[{id:77,name:'截图.png',size:100,mime:'image/png'}]}:impl(p,o));
 render(<DesktopAfterSalesPage/>);await choose();fireEvent.change(screen.getByLabelText('本次处理记录'),{target:{value:'我的待保存记录'}});
 fireEvent.change(screen.getByLabelText('上传凭证'),{target:{files:[new File(['x'],'截图.png',{type:'image/png'})]}});
 await screen.findByText(/上传期间档案被其他人更新/);fireEvent.click(screen.getByText('保存跟进'));
 await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/follow',expect.objectContaining({body:expect.objectContaining({version:2,note:'我的待保存记录'})})));
});
it('外层只显示自己的表格，原聚水潭必须主动展开；未启动采集显著告警',async()=>{
 render(<DesktopAfterSalesPage/>);await screen.findByText('最新售后采集尚未配置');expect(document.querySelector('.ds-viewport')).toBeNull();expect(screen.getByRole('table')).toBeTruthy();
 fireEvent.click(screen.getByText('展开聚水潭'));expect(document.querySelector('.ds-viewport')).toBeTruthy();
 fireEvent.click(screen.getByText('关闭原页面'));await waitFor(()=>expect(window.oaDesktop!.hide).toHaveBeenCalled());
});
it('采集失败在顶部显示，最后一次成功不能掩盖故障',async()=>{
 const original=mock.getMockImplementation()!;mock.mockImplementation(async(p,o)=>p==='/desktop-after-sales-collection'?[{id:1,sourceCompany:'演示公司',enabled:true,intervalSeconds:60,health:'failed',lastSuccessAt:'2026-11-04T10:00:00Z',lastError:'登录失效，请重新连接'}]:original(p,o));
 render(<DesktopAfterSalesPage/>);await screen.findByText('演示公司 · 最新售后采集失败');expect(screen.getByRole('alert').textContent).toContain('登录失效');expect(screen.getByRole('alert').textContent).toContain('最后成功');
});
it('历史查询仅调用本机并把回查变化归档，不领取协同轮次',async()=>{
 const original=mock.getMockImplementation()!;mock.mockImplementation(async(p,o)=>p==='/desktop-after-sales-collection'?[{id:1,sourceCompany:'演示公司',enabled:true,health:'stopped',intervalSeconds:60}]:original(p,o));
 window.oaDesktop!.query=vi.fn().mockResolvedValue({records:[archive().snapshot],page:1,pageSize:50,hasNext:false,total:1});
 render(<DesktopAfterSalesPage/>);await screen.findByText('演示公司 · 最新售后采集已停止');
 fireEvent.change(screen.getByLabelText('查询来源公司'),{target:{value:'1'}});fireEvent.change(screen.getByLabelText('本机查询范围'),{target:{value:'history'}});fireEvent.change(screen.getByLabelText('搜索售后单号或内部订单号'),{target:{value:'85110001'}});fireEvent.click(screen.getByText('本机查询并更新 OA'));
 await waitFor(()=>expect(window.oaDesktop!.query).toHaveBeenCalledWith(expect.objectContaining({kind:'history',value:'85110001'})));
 await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales-collection/1/local',expect.objectContaining({body:expect.objectContaining({records:expect.any(Array)})})));
 expect(mock.mock.calls.some(([p])=>p.endsWith('/claim'))).toBe(false);
});
it('保存跟进时保留尚未提交的跟踪报告',async()=>{
 render(<DesktopAfterSalesPage/>);await choose();fireEvent.change(screen.getByLabelText('跟踪报告'),{target:{value:'尚在核对仓库签收'}});fireEvent.change(screen.getByLabelText('本次处理记录'),{target:{value:'今天已联系仓库'}});fireEvent.click(screen.getByText('保存跟进'));
 await waitFor(()=>expect((screen.getByLabelText('处理到哪一步') as HTMLInputElement).disabled).toBe(false));expect((screen.getByLabelText('跟踪报告') as HTMLTextAreaElement).value).toBe('尚在核对仓库签收');
});
