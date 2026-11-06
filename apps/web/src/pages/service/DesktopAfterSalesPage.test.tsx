import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DesktopAfterSalesPage} from './DesktopAfterSalesPage';
import {api} from '../../api/client';
vi.mock('../../api/client',()=>({api:vi.fn(),tokenStore:{get:()=> 'test-identity'}}));
const mock=vi.mocked(api);
const archive=(id=1,version=2)=>({id,version,storeId:10,storeName:'演示店',snapshot:{afterSaleId:String(85110000+id),internalOrderId:String(4400000+id),sourceCompany:'演示公司',capturedAt:'2026-11-04T10:00:00Z',fields:{线上状态:'等待退货'}},progress:'等待物流',ownerId:null,ownerName:'',nextAt:null,updatedAt:'2026-11-04T10:00:00Z',events:[],files:[]});
let shotCallback:(v:{id:number;afterSaleId:string;image:string})=>void;
beforeEach(()=>{
 localStorage.removeItem('oa.afterSales.columns');
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 window.oaDesktop={version:'0.1.0',preferences:vi.fn().mockResolvedValue({shortcut:'CommandOrControl+Shift+S',registered:true}),zoom:vi.fn().mockResolvedValue(true),mount:vi.fn().mockResolvedValue(true),hide:vi.fn().mockResolvedValue(true),context:vi.fn().mockResolvedValue(true),read:vi.fn().mockResolvedValue([{...archive().snapshot}]),refresh:vi.fn().mockResolvedValue(true),openOrder:vi.fn().mockResolvedValue(true),screenshot:vi.fn().mockResolvedValue(true),shortcut:vi.fn().mockResolvedValue(true),clearLogin:vi.fn().mockResolvedValue(true),onScreenshot:cb=>{shotCallback=cb;return vi.fn();}};
 mock.mockImplementation(async path=>{
  if(path==='/desktop-after-sales-collection')return [];
  if(path.endsWith('/options'))return {stores:[{id:10,name:'演示店'}],people:[]};
  if(path.includes('?'))return {total:2,rows:[1,2].map(id=>({...archive(id),...archive(id).snapshot}))};
  if(path.endsWith('/1'))return archive();if(path.endsWith('/2'))return archive(2);
  if(path.endsWith('/1/files'))return {...archive(1,3),files:[{id:77,name:'截图.png',size:100,mime:'image/png'}]};
  return archive();
 });
});
afterEach(()=>{cleanup();delete window.oaDesktop;vi.restoreAllMocks();vi.unstubAllGlobals();mock.mockReset();});
async function choose(id=1){await screen.findByText(String(85110000+id));fireEvent.click(screen.getByText(String(85110000+id)));await screen.findByText(`售后 ${85110000+id}`);await waitFor(()=>expect((screen.getByLabelText('处理到哪一步') as HTMLInputElement).disabled).toBe(false));}
it('原始内部订单仍可从单单详情打开',async()=>{
 render(<DesktopAfterSalesPage/>);await choose();fireEvent.click(within(screen.getByRole('dialog',{name:'售后 85110001'})).getByText('4400001'));await waitFor(()=>expect(window.oaDesktop!.openOrder).toHaveBeenCalledWith('4400001'));
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
 await screen.findByText(/档案被其他人更新/);fireEvent.click(screen.getByText('保存跟进'));
 await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/follow',expect.objectContaining({body:expect.objectContaining({version:2,note:'我的待保存记录'})})));
});
it('旧客户端主动打开原页面才挂载，默认显示 OA 表格',async()=>{
 render(<DesktopAfterSalesPage/>);await screen.findByText('等待登录聚水潭后开始自动采集');expect(document.querySelector('.ds-viewport')).toBeNull();expect(screen.getByRole('table')).toBeTruthy();
 fireEvent.click(screen.getByText('打开聚水潭售后页面'));expect(document.querySelector('.ds-viewport')).toBeTruthy();
 fireEvent.click(screen.getByText('关闭原页面'));await waitFor(()=>expect(window.oaDesktop!.hide).toHaveBeenCalled());
});
it('独立 OA 售后窗口默认展示工作台，最右按钮仅打开新的聚水潭窗口',async()=>{
 const openSourceWindow=vi.fn().mockResolvedValue(true);
 Object.assign(window.oaDesktop!,{surface:'after-sales',openSourceWindow});
 render(<DesktopAfterSalesPage/>);
 await screen.findByText('85110001');
 const toolbar=screen.getByRole('region',{name:'售后功能区'});
 const last=within(toolbar).getAllByRole('button').at(-1)!;
 expect(last.textContent).toContain('打开聚水潭售后页面');
 expect(openSourceWindow).not.toHaveBeenCalled();
 expect(screen.queryByRole('button',{name:'采集连接'})).toBeNull();
 fireEvent.click(last);
 expect(openSourceWindow).toHaveBeenCalledOnce();
 expect(window.oaDesktop!.mount).not.toHaveBeenCalled();
});
it('采集失败在顶部显示，最后一次成功不能掩盖故障',async()=>{
 const original=mock.getMockImplementation()!;mock.mockImplementation(async(p,o)=>p==='/desktop-after-sales-collection'?[{id:1,sourceCompany:'演示公司',enabled:true,intervalSeconds:60,health:'failed',lastSuccessAt:'2026-11-04T10:00:00Z',lastError:'登录失效，请重新连接'}]:original(p,o));
 render(<DesktopAfterSalesPage/>);await screen.findByText('演示公司 · 最新售后采集失败');expect(screen.getByRole('alert').textContent).toContain('登录失效');expect(screen.getByRole('alert').textContent).toContain('最后成功');
});
it('点处理自动回查当前与历史售后，并将匹配记录归档到同一售后',async()=>{
 const original=mock.getMockImplementation()!;
 const snapshot={...archive().snapshot,fields:{线上状态:'已完成'}};
 mock.mockImplementation(async(p,o)=>p.endsWith('/1/source')?{...archive(),snapshot,events:[{id:1,kind:'source_change',content:'等待退货 → 已完成',actorName:'同事',createdAt:snapshot.capturedAt}]}:original(p,o));
 window.oaDesktop!.query=vi.fn().mockResolvedValueOnce({records:[archive(2).snapshot]}).mockResolvedValueOnce({records:[snapshot]});
 render(<DesktopAfterSalesPage/>);await choose();
 expect(window.oaDesktop!.query).toHaveBeenNthCalledWith(1,expect.objectContaining({kind:'current',value:'85110001'}));
 expect(window.oaDesktop!.query).toHaveBeenNthCalledWith(2,expect.objectContaining({kind:'history',value:'85110001'}));
 expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/source',{body:snapshot});
 expect(screen.getByText('等待退货 → 已完成')).toBeTruthy();
 expect(mock.mock.calls.some(([p])=>p.endsWith('/claim'))).toBe(false);
});
it('缺内部订单号的售后仍按售后单号回查，并在同一档案显示补齐的号码',async()=>{
 const original=mock.getMockImplementation()!;
 const missing={...archive().snapshot,internalOrderId:''};
 const filled={...missing,internalOrderId:'4400001'};
 mock.mockImplementation(async(p,o)=>p.endsWith('/1')?{...archive(),snapshot:missing}:
  p.endsWith('/1/source')?{...archive(),snapshot:filled}:original(p,o));
 let respond!:(result:{records:typeof filled[]})=>void;
 window.oaDesktop!.query=vi.fn().mockReturnValue(new Promise(resolve=>{respond=resolve;}));
 render(<DesktopAfterSalesPage/>);
 fireEvent.click(await screen.findByText('85110001'));
 const detail=await screen.findByRole('dialog',{name:'售后 85110001'});
 expect((within(detail).getByRole('button',{name:'待聚水潭补齐'}) as HTMLButtonElement).disabled).toBe(true);
 respond({records:[filled]});
 await within(detail).findByRole('button',{name:'4400001'});
 expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/source',{body:filled});
});
it('列筛选提交给服务端，拖动后的售后单号位置在重开时保留',async()=>{
 const original=mock.getMockImplementation()!;
 mock.mockImplementation(async(p,o)=>p.endsWith('/search')?{total:42,rows:[]}:original(p,o));
 const page=render(<DesktopAfterSalesPage/>);await screen.findByText('85110001');
 fireEvent.click(screen.getByRole('button',{name:'显示列'}));
 fireEvent.change(screen.getByRole('textbox',{name:'查找列'}),{target:{value:'退货签收'}});
 fireEvent.click(screen.getByRole('checkbox',{name:'退货签收时间'}));
 const heading=screen.getByRole('columnheader',{name:/退货签收时间/});
 const dataTransfer={setData:vi.fn(),effectAllowed:'all'};
 fireEvent.dragStart(screen.getByTitle('拖动售后单号'),{dataTransfer});
 fireEvent.dragOver(heading,{dataTransfer});
 fireEvent.drop(heading,{dataTransfer});
 const order=()=>screen.getAllByRole('columnheader').map(h=>h.textContent);
 expect(order().indexOf('售后单号')).toBeGreaterThan(order().indexOf('退货签收时间'));
 fireEvent.click(screen.getByRole('button',{name:'筛选线上状态'}));
 fireEvent.change(screen.getByRole('textbox',{name:'线上状态包含'}),{target:{value:'等待退货'}});
 fireEvent.click(screen.getByRole('button',{name:'筛选'}));
 await screen.findByText('共 42 条');
 expect(mock).toHaveBeenCalledWith('/desktop-after-sales/search',{body:expect.objectContaining({page:1,filters:[{column:'线上状态',value:'等待退货'}]})});
 page.unmount();render(<DesktopAfterSalesPage/>);
 expect(order().indexOf('售后单号')).toBeGreaterThan(order().indexOf('退货签收时间'));
});
it('保存跟进时保留尚未提交的跟踪报告',async()=>{
 render(<DesktopAfterSalesPage/>);await choose();fireEvent.change(screen.getByLabelText('跟踪报告'),{target:{value:'尚在核对仓库签收'}});fireEvent.change(screen.getByLabelText('本次处理记录'),{target:{value:'今天已联系仓库'}});fireEvent.click(screen.getByText('保存跟进'));
 await waitFor(()=>expect((screen.getByLabelText('处理到哪一步') as HTMLInputElement).disabled).toBe(false));expect((screen.getByLabelText('跟踪报告') as HTMLTextAreaElement).value).toBe('尚在核对仓库签收');
});
