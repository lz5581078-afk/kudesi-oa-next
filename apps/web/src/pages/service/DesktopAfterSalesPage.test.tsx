import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DesktopAfterSalesPage} from './DesktopAfterSalesPage';
import {DesktopAfterSalesSharedPage} from './DesktopAfterSalesSharedPage';
import {MemoryRouter,Route,Routes} from 'react-router-dom';
import {api} from '../../api/client';
vi.mock('../../api/client',()=>({api:vi.fn(),tokenStore:{get:()=> 'test-identity'}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:{companyId:1,id:1}})}));
const mock=vi.mocked(api);
const columnKey='oa.afterSales.columns.1.1';
const setColumns=(columns:string[])=>localStorage.setItem(columnKey,JSON.stringify({columns}));
const archive=(id=1,version=2)=>({id,version,storeId:10,storeName:'演示店',snapshot:{afterSaleId:String(85110000+id),internalOrderId:String(4400000+id),sourceCompany:'演示公司',capturedAt:'2026-11-04T10:00:00Z',fields:{线上状态:'等待退货'}},progress:'等待物流',ownerId:null,ownerName:'',nextAt:null,updatedAt:'2026-11-04T10:00:00Z',events:[],files:[]});
let shotCallback:(v:import('./desktopBridge').Shot)=>void;
beforeEach(()=>{
 setColumns(['售后单号','内部订单号','申请时间','线上状态','店铺']);
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 window.oaDesktop={version:'0.1.0',preferences:vi.fn().mockResolvedValue({shortcut:'CommandOrControl+Shift+S',registered:true}),zoom:vi.fn().mockResolvedValue(true),mount:vi.fn().mockResolvedValue(true),hide:vi.fn().mockResolvedValue(true),context:vi.fn().mockResolvedValue(true),read:vi.fn().mockResolvedValue([{...archive().snapshot}]),refresh:vi.fn().mockResolvedValue(true),openOrder:vi.fn().mockResolvedValue(true),screenshot:vi.fn().mockResolvedValue(true),shortcut:vi.fn().mockResolvedValue(true),clearLogin:vi.fn().mockResolvedValue(true),onScreenshot:cb=>{shotCallback=cb;return vi.fn();}};
 mock.mockImplementation(async (path,options)=>{
  if(path==='/user-preferences/desktop-after-sales-columns')return options?.body??{value:null};
  if(path==='/desktop-after-sales-collection')return [];
  if(path.endsWith('/options'))return {stores:[{id:10,name:'演示店'}],people:[]};
  if(path.includes('?'))return {total:2,rows:[1,2].map(id=>({...archive(id),...archive(id).snapshot}))};
  if(path.endsWith('/1'))return archive();if(path.endsWith('/2'))return archive(2);
  if(path.endsWith('/1/files'))return {...archive(1,3),files:[{id:77,name:'截图.png',size:100,mime:'image/png'}]};
  return archive();
 });
});
afterEach(()=>{cleanup();delete window.oaDesktop;vi.restoreAllMocks();vi.unstubAllGlobals();mock.mockReset();});
async function choose(id=1){
 const sale=await screen.findByText(String(85110000+id));
 fireEvent.click(within(sale.closest('tr')!).getByRole('button',{name:'处理'}));
 await screen.findByText(`售后 ${85110000+id}`);
 await waitFor(()=>expect((screen.getByLabelText('本次处理记录') as HTMLTextAreaElement).disabled).toBe(false));
}
it('处理抽屉里的内部订单号也在 OA 内打开只读详情',async()=>{
 const readOrderDetail=vi.fn().mockResolvedValue(archive().snapshot);
 Object.assign(window.oaDesktop!,{readOrderDetail});
 render(<DesktopAfterSalesPage/>);
 await choose();
 fireEvent.click(within(screen.getByRole('dialog',{name:'售后 85110001'})).getByText('4400001'));
 expect(await screen.findByRole('article',{name:'内部订单详情'})).toBeTruthy();
 expect(readOrderDetail).toHaveBeenCalledWith({afterSaleId:'85110001',internalOrderId:'4400001',sourceCompany:'演示公司'});
 expect(window.oaDesktop!.openOrder).not.toHaveBeenCalled();
});
it('售后单号打开聚水潭售后资料，内部订单号打开独立订单详情',async()=>{
 const original=mock.getMockImplementation()!;
 const sale=archive().snapshot;
 const order={...sale,fields:{商品明细:'商品名称：演示商品',实际已付:'15.20',售后单状态:'不覆盖列表状态'}};
 const readOrderDetail=vi.fn().mockResolvedValue(order);
 Object.assign(window.oaDesktop!,{readOrderDetail,query:vi.fn().mockResolvedValue({records:[sale]})});
 mock.mockImplementation(async(p,o)=>{
  if(p.endsWith('/1/source'))return {...archive(),snapshot:{...sale,fields:{...sale.fields,...(o?.body as typeof order)?.fields}}};
  return original(p,o);
 });
 render(<DesktopAfterSalesPage/>);
 fireEvent.click(await screen.findByRole('button',{name:'85110001'}));
 const detail=await screen.findByRole('dialog',{name:'售后 85110001'});
 await within(detail).findByText('等待退货');
 expect(within(detail).queryByLabelText('本次处理记录')).toBeNull();
 await waitFor(()=>expect(window.oaDesktop!.query).toHaveBeenCalledOnce());
 await waitFor(()=>expect(mock.mock.calls.some(([path])=>path.endsWith('/source'))).toBe(true));
 expect(within(detail).queryByText('聚水潭最新状态已归档')).toBeNull();
 fireEvent.click(within(detail).getByRole('button',{name:'关闭售后详情'}));
 fireEvent.click(screen.getByRole('button',{name:'4400001'}));
 const orderPanel=await screen.findByRole('article',{name:'内部订单详情'});
 await within(orderPanel).findByRole('cell',{name:'演示商品'}, {timeout:3000});
 expect(within(orderPanel).getByText('15.20')).toBeTruthy();
 expect(readOrderDetail).toHaveBeenCalledWith({afterSaleId:'85110001',internalOrderId:'4400001',sourceCompany:'演示公司'});
 expect(mock.mock.calls.filter(([path])=>path.endsWith('/1/source')).map(([,options])=>options?.body))
  .toEqual([sale,{...order,fields:{商品明细:'商品名称：演示商品',实际已付:'15.20'}}]);
});
it('切换后旧截图不得上传到新售后',async()=>{
 render(<DesktopAfterSalesPage/>);await choose(2);shotCallback({id:1,afterSaleId:'85110001',image:'data:image/png;base64,AAAA'});
 await screen.findByText(/截图对应的售后已切换/);expect(mock.mock.calls.some(([p])=>p.endsWith('/files'))).toBe(false);
});
it('上传凭证后保留未保存的备注，并使用更新后的版本提交',async()=>{
 render(<DesktopAfterSalesPage/>);await choose();fireEvent.change(screen.getByLabelText('本次处理记录'),{target:{value:'买家说明天寄回'}});
 await act(async()=>shotCallback({id:1,afterSaleId:'85110001',image:'data:image/png;base64,AAAA'}));
 await screen.findByText('截图.png');expect((screen.getByLabelText('本次处理记录') as HTMLTextAreaElement).value).toBe('买家说明天寄回');
 fireEvent.click(screen.getByText('保存跟进'));await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/follow',expect.objectContaining({body:expect.objectContaining({version:3,note:'买家说明天寄回'})})));
});
it('凭证上传期间其他人更新进度，不会悄悄把旧草稿升级为可覆盖的新版本',async()=>{
 const impl=mock.getMockImplementation()!;
 mock.mockImplementation(async(p,o)=>p.endsWith('/1/files')?{...archive(1,4),progress:'其他人已联系仓库',files:[{id:77,name:'截图.png',size:100,mime:'image/png'}]}:impl(p,o));
 render(<DesktopAfterSalesPage/>);await choose();fireEvent.change(screen.getByLabelText('本次处理记录'),{target:{value:'我的待保存记录'}});
 await act(async()=>shotCallback({id:1,afterSaleId:'85110001',image:'data:image/png;base64,AAAA'}));
 await screen.findByText(/档案被其他人更新/);fireEvent.click(screen.getByText('保存跟进'));
 await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/follow',expect.objectContaining({body:expect.objectContaining({version:2,note:'我的待保存记录'})})));
});
it('处理区在历史上方，历史倒序显示，完结必须填写理由并二次确认',async()=>{
 const original=mock.getMockImplementation()!;
 const record=archive();
 const createdAt=record.snapshot.capturedAt;
 const events=[
  {id:1,kind:'follow',content:'第一次处理',actorName:'甲',createdAt},
  {id:2,kind:'source_change',content:'来源变更',actorName:'采集',createdAt,
   changes:[{field:'售后单状态',before:'待确认',after:'已确认'}]},
  {id:3,kind:'follow',content:'最近的处理',actorName:'乙',createdAt},
 ];
 mock.mockImplementation(async(p,o)=>{
  if(p.endsWith('/1'))return {...record,events};
  if(p.endsWith('/1/close'))return {...record,progress:'已完结',closed:{reason:'买家已确认',actorName:'乙',createdAt},events};
  return original(p,o);
 });
 const confirmation=vi.spyOn(window,'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
 try{
  render(<DesktopAfterSalesPage/>);await choose();
  const area=screen.getByRole('region',{name:'处理区'});
  const history=screen.getByRole('region',{name:'历史处理记录'});
  expect(area.compareDocumentPosition(history)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(history).getAllByRole('listitem').map(row=>row.textContent)).toEqual([
   expect.stringContaining('最近的处理'),expect.stringContaining('第一次处理'),
  ]);
  expect(within(area).getByRole('button',{name:'截图'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'聚水潭字段变更'}));
  const changes=screen.getByRole('region',{name:'字段变更历史'});
  expect(within(changes).getByRole('row',{name:'售后单状态 待确认 已确认'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'OA 处理记录'}));
  fireEvent.change(screen.getByLabelText('本次处理记录'),{target:{value:'已联系买家'}});
  fireEvent.click(screen.getByRole('button',{name:'完结'}));
  const submit=screen.getByRole('button',{name:'确认完结'});
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('完结理由'),{target:{value:'买家已确认'}});
  fireEvent.click(submit);
  expect(mock.mock.calls.some(([p])=>p.endsWith('/close'))).toBe(false);
  expect((screen.getByLabelText('本次处理记录') as HTMLTextAreaElement).value).toBe('已联系买家');
  fireEvent.click(submit);
  await screen.findByText('已完结');
  expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/close',
   expect.objectContaining({body:expect.objectContaining({version:2,note:'已联系买家',reason:'买家已确认'})}));
 }finally{confirmation.mockRestore();}
});
it('自动截图完成时即使已切单，也只上传到发起截图的售后',async()=>{
 render(<DesktopAfterSalesPage/>);await choose();
 fireEvent.click(screen.getByRole('button',{name:'截图'}));
 await waitFor(()=>expect(window.oaDesktop!.screenshot).toHaveBeenCalledWith({id:1,afterSaleId:'85110001',autoAttach:true}));
 fireEvent.click(screen.getByRole('button',{name:'关闭售后详情'}));
 await choose(2);
 await act(async()=>shotCallback({id:1,afterSaleId:'85110001',image:'data:image/png;base64,AAAA',autoAttach:true}));
 await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/files',expect.objectContaining({method:'POST',form:expect.any(FormData)})));
 expect(mock.mock.calls.some(([p])=>p==='/desktop-after-sales/2/files')).toBe(false);
 expect(screen.queryByText('截图.png')).toBeNull();
});
it('旧客户端主动打开原页面才挂载，默认显示 OA 表格',async()=>{
 render(<DesktopAfterSalesPage/>);await screen.findByText('服务器暂无采集来源');expect(document.querySelector('.ds-viewport')).toBeNull();expect(screen.getByRole('table')).toBeTruthy();
 fireEvent.click(screen.getByText('打开聚水潭售后页面'));expect(document.querySelector('.ds-viewport')).toBeTruthy();
 fireEvent.click(screen.getByText('关闭原页面'));await waitFor(()=>expect(window.oaDesktop!.hide).toHaveBeenCalled());
});
it('独立 OA 售后窗口默认展示工作台，聚水潭按钮打开独立原窗口',async()=>{
 const openSourceWindow=vi.fn().mockResolvedValue(true);
 Object.assign(window.oaDesktop!,{surface:'after-sales',openSourceWindow});
 render(<DesktopAfterSalesPage/>);
 await screen.findByText('85110001');
 const toolbar=screen.getByRole('region',{name:'售后功能区'});
 const source=within(toolbar).getByRole('button',{name:'打开聚水潭售后页面'});
 expect(openSourceWindow).not.toHaveBeenCalled();
 expect(screen.queryByRole('button',{name:'采集连接'})).toBeNull();
 fireEvent.click(source);
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
 await waitFor(()=>expect(window.oaDesktop!.query).toHaveBeenNthCalledWith(2,expect.objectContaining({kind:'history',value:'85110001'})));
 await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/source',{body:snapshot}));
 fireEvent.click(screen.getByRole('button',{name:'聚水潭字段变更'}));
 expect(await screen.findByText('等待退货 → 已完成')).toBeTruthy();
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
 fireEvent.change(screen.getByRole('textbox',{name:'查找列'}),{target:{value:'解决方案'}});
 fireEvent.click(screen.getByRole('button',{name:'显示解决方案'}));
 const heading=screen.getByRole('columnheader',{name:/解决方案/});
 const dataTransfer={setData:vi.fn(),effectAllowed:'all'};
 fireEvent.dragStart(within(screen.getByRole('table')).getByTitle('拖动售后单号'),{dataTransfer});
 fireEvent.dragOver(heading,{dataTransfer});
 fireEvent.drop(heading,{dataTransfer});
 const order=()=>screen.getAllByRole('columnheader').map(h=>h.textContent);
 expect(order().indexOf('售后单号')).toBeGreaterThan(order().indexOf('解决方案'));
 fireEvent.click(screen.getByRole('button',{name:'筛选解决方案'}));
 fireEvent.change(screen.getByRole('textbox',{name:'解决方案包含'}),{target:{value:'补寄'}});
 fireEvent.click(screen.getByRole('button',{name:'筛选'}));
 await screen.findByText('共 42 条');
 expect(mock).toHaveBeenCalledWith('/desktop-after-sales/search',{body:expect.objectContaining({page:1,filters:[{column:'解决方案',value:'补寄'}]})});
 page.unmount();render(<DesktopAfterSalesPage/>);
 expect(order().indexOf('售后单号')).toBeGreaterThan(order().indexOf('解决方案'));
});
it('通知表单按部门分组，三个旧入口已移除',async()=>{
 const original=mock.getMockImplementation()!;
 mock.mockImplementation(async(p,o)=>p.endsWith('/options')
  ?{currentUserId:1,currentDepartmentId:11,people:[{id:3,name:'张三',departmentId:12,departmentName:'仓储部'},{id:4,name:'李四',departmentId:11,departmentName:'客服部'}]}:original(p,o));
 render(<DesktopAfterSalesPage/>);await choose();
 const area=screen.getByRole('region',{name:'处理区'});
 expect(within(area).getAllByRole('textbox')).toHaveLength(1);
 const follow=within(area).getByLabelText('下次跟进人');
 expect(within(follow).getByRole('option',{name:'李四'})).toBeTruthy();
 expect(within(follow).queryByRole('option',{name:'张三'})).toBeNull();
 expect(within(area).queryByText(/颜色|按 OA 流程|推送给其他部门/)).toBeNull();
 fireEvent.click(within(area).getByRole('button',{name:'通知其他部门处理'}));
 fireEvent.change(within(area).getByLabelText('搜索人名'),{target:{value:'张'}});
 expect(within(area).getByRole('group',{name:'仓储部'})).toBeTruthy();
 fireEvent.click(within(area).getByRole('button',{name:'选择人'}));
 fireEvent.change(within(area).getByLabelText('选择部门'),{target:{value:'12'}});
 fireEvent.change(within(area).getByLabelText('通知对象'),{target:{value:'3'}});
 fireEvent.change(within(area).getByLabelText('交接说明'),{target:{value:'请核对入库'}});
 fireEvent.click(within(area).getByRole('button',{name:'发送通知'}));
 await waitFor(()=>expect(mock).toHaveBeenCalledWith('/desktop-after-sales-shared/1/share',
  {body:{recipients:[3],message:'请核对入库',canWrite:true}}));
});
it('开始和取消完结都记录，历史显示操作人',async()=>{
 const original=mock.getMockImplementation()!;
 let eventId=100;
 mock.mockImplementation(async(path,options)=>{
  if(path==='/desktop-after-sales/1/activity'){
   const click=(options?.body as {click:string}).click;
   const action=click==='start_close'?'点击完结':click==='cancel_close'?'取消完结':'打开售后处理';
   return {id:++eventId,kind:'activity',action,content:'',actorId:7,actorName:'值班员',createdAt:archive().updatedAt};
  }
  return original(path,options);
 });
 render(<DesktopAfterSalesPage/>);await choose();
 fireEvent.click(screen.getByRole('button',{name:'完结'}));
 fireEvent.click(screen.getByRole('button',{name:/^取消$/}));
 const history=screen.getByRole('region',{name:'历史处理记录'});
 const cancelled=await within(history).findByText('取消完结');
 expect(cancelled.closest('li')?.textContent).toContain('值班员');
 expect(within(history).getByText('点击完结')).toBeTruthy();
 expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/activity',{body:{click:'open_case'}});
 expect(mock.mock.calls.some(([path])=>path.endsWith('/1/close'))).toBe(false);
});
it('撕单按钮位于处理记录上方，三个列表各自请求对应状态',async()=>{
 const original=mock.getMockImplementation()!;
 mock.mockImplementation(async(path,options)=>path.endsWith('/1/tear')
  ?{archive:{...archive(1,3),workspaceState:'tear'},recipients:2,assistantQueued:1}
  :original(path,options));
 render(<DesktopAfterSalesPage/>);await choose();
 const area=screen.getByRole('region',{name:'处理区'});
 const tear=within(area).getByRole('button',{name:'撕单'});
 expect(tear.compareDocumentPosition(within(area).getByLabelText('本次处理记录'))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 fireEvent.click(tear);
 await screen.findByText('等待仓储部撕单');
 expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/tear',{body:{version:2}});
 fireEvent.click(screen.getByRole('button',{name:'关闭售后详情'}));
 for(const [name,state] of [['撕单售后','tear'],['已完结售后','closed']]){
  fireEvent.click(screen.getByRole('button',{name}));
  await waitFor(()=>expect(mock.mock.calls.some(([path])=>path.startsWith('/desktop-after-sales?')&&path.includes('state='+state))).toBe(true));
 }
 const filters=screen.getByRole('region',{name:'售后功能区'});
 expect(within(filters).getAllByRole('button').at(-1)?.textContent).toBe('显示列');
});
it('仓储协作页可提交撕单结果并完结该售后',async()=>{
 const original=mock.getMockImplementation()!;
 const tear={...archive(),workspaceState:'tear',canCloseTear:true};
 mock.mockImplementation(async(path,options)=>{
  if(path==='/desktop-after-sales-shared/1')return tear;
  if(path==='/desktop-after-sales-shared/1/close-tear')return {...tear,workspaceState:'closed',canCloseTear:false,
   closed:{reason:'已核对并撕单',actorName:'仓储同事',createdAt:tear.snapshot.capturedAt}};
  return original(path,options);
 });
 vi.spyOn(window,'confirm').mockReturnValue(true);
 render(<MemoryRouter initialEntries={['/after-sales/shared/1']} future={{v7_startTransition:true,v7_relativeSplatPath:true}}>
  <Routes><Route path="/after-sales/shared/:id" element={<DesktopAfterSalesSharedPage/>}/></Routes>
 </MemoryRouter>);
 fireEvent.change(await screen.findByLabelText('撕单处理记录'),{target:{value:'已处理'}});
 fireEvent.click(screen.getByRole('button',{name:'撕单已处理，完结售后'}));
 fireEvent.change(screen.getByLabelText('完结理由'),{target:{value:'已核对并撕单'}});
 fireEvent.click(screen.getByRole('button',{name:'确认完结'}));
 await screen.findByText('已完结');
 expect(mock).toHaveBeenCalledWith('/desktop-after-sales-shared/1/close-tear',
  {body:{version:2,note:'已处理',reason:'已核对并撕单'}});
});
it('拖动列宽只在松手时保存，重新打开会保留，双击可恢复默认',async()=>{
 const page=render(<DesktopAfterSalesPage/>);
 await screen.findByText('85110001');
 const handle=()=>screen.getByRole('separator',{name:'调整售后单号列宽'});
 const pointer=(type:string,clientX:number)=>{
  const event=new MouseEvent(type,{bubbles:true,clientX});
  Object.defineProperty(event,'pointerId',{value:1});
  fireEvent(handle(),event);
 };
 expect(handle().getAttribute('aria-valuenow')).toBe('148');
 pointer('pointerdown',100);
 pointer('pointermove',144);
 expect(handle().getAttribute('aria-valuenow')).toBe('192');
 expect(mock.mock.calls.some(([,options])=>options?.method==='PUT')).toBe(false);
 pointer('pointerup',144);
 const preference='/user-preferences/desktop-after-sales-columns';
 await waitFor(()=>expect(mock).toHaveBeenCalledWith(preference,{method:'PUT',body:{value:{
  columns:['售后单号','内部订单号','申请时间','线上状态','店铺'],widths:{售后单号:192},
 }}}));
 page.unmount();
 render(<DesktopAfterSalesPage/>);
 expect(handle().getAttribute('aria-valuenow')).toBe('192');
 fireEvent.doubleClick(handle());
 expect(handle().getAttribute('aria-valuenow')).toBe('148');
 await waitFor(()=>expect(JSON.parse(localStorage.getItem(columnKey)!).widths).toEqual({}));
});
it('默认聚水潭 67 列，查看日志打开独立日志弹窗并归档同一售后',async()=>{
 localStorage.removeItem(columnKey);
 const original=mock.getMockImplementation()!;
 const snapshot={...archive().snapshot,fields:{售后日志:'时间：2026-11-06 · 操作人：演示 · 操作：确认'}};
 mock.mockImplementation(async(p,o)=>p.endsWith('/1/source')?{...archive(),snapshot}:original(p,o));
 const readSourcePanel=vi.fn().mockResolvedValue(snapshot);
 Object.assign(window.oaDesktop!,{surface:'after-sales',readSourcePanel});
 render(<DesktopAfterSalesPage/>);
 await screen.findByText('85110001');
 expect(screen.getAllByRole('columnheader')).toHaveLength(67);
 expect(screen.getByRole('columnheader',{name:/平台卖家退货地址/})).toBeTruthy();
 expect(screen.getByRole('columnheader',{name:/退货物流状态/})).toBeTruthy();
 fireEvent.click(within(screen.getAllByRole('row')[1]).getByRole('button',{name:'查看日志'}));
 const dialog=await screen.findByRole('dialog',{name:'查看日志'});
 const panel=within(dialog).getByRole('region',{name:'售后日志'});
 await within(panel).findByRole('cell',{name:'确认'});
 expect(readSourcePanel).toHaveBeenCalledWith({kind:'logs',afterSaleId:'85110001',sourceCompany:'演示公司'});
 expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/source',{body:snapshot});
});
it('点击字段立即显示列表中的归档详情，等待期间关闭不会重新弹出',async()=>{
 const original=mock.getMockImplementation()!;
 const record=archive();
 const snapshot={...record.snapshot,fields:{...record.snapshot.fields,售后日志:'时间：2026-11-06 · 操作：确认'}};
 let resolveArchive!:(value:typeof record)=>void;
 mock.mockImplementation(async(p,o)=>{
  if(p.startsWith('/desktop-after-sales?'))return {total:1,rows:[{...record,...snapshot,snapshot}]};
  if(p.endsWith('/1'))return new Promise<typeof record>(resolve=>{resolveArchive=resolve;});
  return original(p,o);
 });
 const readSourcePanel=vi.fn();
 Object.assign(window.oaDesktop!,{surface:'after-sales',readSourcePanel});
 render(<DesktopAfterSalesPage/>);
 fireEvent.click(await screen.findByRole('button',{name:'查看日志'}));
 const dialog=screen.getByRole('dialog',{name:'查看日志'});
 expect(within(dialog).getByRole('cell',{name:'确认'})).toBeTruthy();
 expect(readSourcePanel).not.toHaveBeenCalled();
 fireEvent.click(within(dialog).getByRole('button',{name:'关闭售后详情'}));
 await act(async()=>resolveArchive({...record,snapshot}));
 expect(screen.queryByRole('dialog',{name:'查看日志'})).toBeNull();
 expect(readSourcePanel).not.toHaveBeenCalled();
});
it('未归档的明细与 OA 档案同时读取，经 OA 返回后才显示',async()=>{
 const original=mock.getMockImplementation()!;
 const record=archive();
 const snapshot={...record.snapshot,fields:{...record.snapshot.fields,售后日志:'时间：2026-11-06 · 操作：确认'}};
 let resolveArchive!:(value:typeof record)=>void;
 let resolveSource!:(value:typeof record)=>void;
 mock.mockImplementation(async(p,o)=>{
  if(p.endsWith('/1'))return new Promise<typeof record>(resolve=>{resolveArchive=resolve;});
  if(p.endsWith('/1/source'))return new Promise<typeof record>(resolve=>{resolveSource=resolve;});
  return original(p,o);
 });
 const readSourcePanel=vi.fn().mockResolvedValue(snapshot);
 Object.assign(window.oaDesktop!,{surface:'after-sales',readSourcePanel,
  jushuitanStatus:vi.fn().mockResolvedValue({state:'authenticated',sourceCompany:'演示公司'})});
 render(<DesktopAfterSalesPage/>);
 await screen.findByText('聚水潭已登录');
 fireEvent.click((await screen.findAllByRole('button',{name:'查看日志'}))[0]);
 const dialog=screen.getByRole('dialog',{name:'查看日志'});
 expect(readSourcePanel).toHaveBeenCalledTimes(1);
 expect(mock).not.toHaveBeenCalledWith('/desktop-after-sales/1/source',expect.anything());
 expect(within(dialog).queryByRole('cell',{name:'确认'})).toBeNull();
 await act(async()=>resolveArchive(record));
 expect(mock).toHaveBeenCalledWith('/desktop-after-sales/1/source',{body:{...snapshot,fields:{售后日志:snapshot.fields.售后日志}}});
 expect(within(dialog).queryByRole('cell',{name:'确认'})).toBeNull();
 await act(async()=>resolveSource({...record,snapshot}));
 expect(within(dialog).getByRole('cell',{name:'确认'})).toBeTruthy();
 expect(readSourcePanel).toHaveBeenCalledTimes(1);
});
it('聚水潭未返回新的售后日志时保留已归档日志',async()=>{
 const original=mock.getMockImplementation()!;
 const record=archive();
 const savedLog='时间：2026-11-06 · 操作：确认';
 const snapshot={...record.snapshot,fields:{...record.snapshot.fields,售后日志:savedLog}};
 mock.mockImplementation(async(p,o)=>p.endsWith('/1')?{...record,snapshot}:original(p,o));
 const readSourcePanel=vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({...snapshot,fields:{售后日志:''}});
 Object.assign(window.oaDesktop!,{surface:'after-sales',readSourcePanel});
 render(<DesktopAfterSalesPage/>);
 const [logButton]=await screen.findAllByRole('button',{name:'查看日志'});
 fireEvent.click(logButton);
 const detail=await screen.findByRole('dialog',{name:'查看日志'});
 const panel=within(detail).getByRole('region',{name:'售后日志'});
 await within(detail).findByText('聚水潭本次没有返回明细，正在显示已归档内容');
 fireEvent.click(within(detail).getByRole('button',{name:'重查聚水潭'}));
 await waitFor(()=>expect(readSourcePanel).toHaveBeenCalledTimes(2));
 await within(detail).findByText('聚水潭本次没有返回明细，正在显示已归档内容');
 expect(within(panel).getByRole('cell',{name:'确认'})).toBeTruthy();
 expect(mock.mock.calls.some(([path])=>path.endsWith('/source'))).toBe(false);
});
it('普通字段保持原列表文本，实退金额入口仅打开行内浮层',async()=>{
 const original=mock.getMockImplementation()!;
 const record=archive();
 const note='需要先核对物流\n买家确认后处理';
 const snapshot={...record.snapshot,fields:{...record.snapshot.fields,退款原因:note,实退金额:'9.00',实退金额明细:'实退金额：9.00'}};
 setColumns(['售后单号','退款原因','实退金额']);
 mock.mockImplementation(async(p,o)=>p.includes('?')?{total:1,rows:[{...record,...snapshot,snapshot}]}:
  p.endsWith('/1')?{...record,snapshot}:original(p,o));
 render(<DesktopAfterSalesPage/>);
 const text=await screen.findByText('需要先核对物流 买家确认后处理');
 expect(text.textContent).toBe(note);
 expect(screen.queryByRole('button',{name:'查看退款原因'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'查看明细'}));
 const popup=await screen.findByRole('dialog',{name:'实退金额明细'});
 expect(popup.classList.contains('ds-source-popover')).toBe(true);
 expect(within(popup).getByText('9.00')).toBeTruthy();
 expect(screen.queryByLabelText('本次处理记录')).toBeNull();
 fireEvent.pointerDown(document.body);
 expect(screen.queryByRole('dialog',{name:'实退金额明细'})).toBeNull();
});

it('可编辑原字段可按单号定位，空备注和编辑入口同样可打开',async()=>{
 const original=mock.getMockImplementation()!;
 const record=archive();
 const snapshot={...record.snapshot,fields:{...record.snapshot.fields,售后标签:'待确认',发货快递单号:'SF123456789',
  '原订单备注/旗帜':'客户已联系','原订单旗帜':'#f44336'}};
 setColumns(['售后单号','售后标签','备注','发货快递单号','原订单备注/旗帜']);
 mock.mockImplementation(async(path,options)=>path.includes('?')?{total:1,rows:[{...record,...snapshot,snapshot}]}:original(path,options));
 const openOriginalField=vi.fn().mockResolvedValue(true);
 const writeText=vi.fn().mockResolvedValue(undefined);
 Object.assign(window.oaDesktop!,{openOriginalField});
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
 try {
  render(<DesktopAfterSalesPage/>);
  const identity={afterSaleId:'85110001',sourceCompany:'演示公司'};
  fireEvent.click(await screen.findByRole('button',{name:'在聚水潭打开售后标签'}));
  await waitFor(()=>expect(openOriginalField).toHaveBeenLastCalledWith({...identity,column:'售后标签'}));
  const note=screen.getByRole('button',{name:'在聚水潭打开备注'}) as HTMLButtonElement;
  await waitFor(()=>expect(note.disabled).toBe(false));
  fireEvent.click(note);
  await waitFor(()=>expect(openOriginalField).toHaveBeenLastCalledWith({...identity,column:'备注'}));
  const edit=screen.getByRole('button',{name:'聚水潭编辑'}) as HTMLButtonElement;
  await waitFor(()=>expect(edit.disabled).toBe(false));
  fireEvent.click(edit);
  await waitFor(()=>expect(openOriginalField).toHaveBeenLastCalledWith({...identity,column:'操作'}));
  const flag=screen.getByRole('img',{name:'原订单旗帜'});
  expect(flag.getAttribute('fill')).toBe('#f44336');
  expect(within(flag.closest('td')!).getByText('客户已联系').tagName).toBe('SPAN');
  const originalRemark=screen.getByRole('button',{name:'在聚水潭打开原订单备注/旗帜'}) as HTMLButtonElement;
  await waitFor(()=>expect(originalRemark.disabled).toBe(false));
  fireEvent.click(originalRemark);
  await waitFor(()=>expect(openOriginalField).toHaveBeenLastCalledWith({...identity,column:'原订单备注/旗帜'}));
  fireEvent.click(screen.getByRole('button',{name:'复制发货快递单号'}));
  await waitFor(()=>expect(writeText).toHaveBeenCalledWith('SF123456789'));
  expect(mock.mock.calls.some(([path,options])=>options?.body&&!path.endsWith('/activity'))).toBe(false);
 } finally { Reflect.deleteProperty(navigator,'clipboard'); }
});
it('订单金额和拒绝原因各自打开 OA 明细，附件使用独立入口',async()=>{
 const original=mock.getMockImplementation()!;
 const record=archive(),snapshot={...record.snapshot,fields:{...record.snapshot.fields,
  '原订单下单金额':'30.00','原订单下单金额明细':'商品金额：30.00',
  '拒绝原因':'查看','拒绝原因明细':'买家重复提交','售后问题附件':'下载附件','备注':'业务说明','原列表可编辑字段':'售后问题登记'}};
 setColumns(['售后单号','原订单下单金额','拒绝原因','售后问题登记','备注']);
 const openOriginalField=vi.fn().mockResolvedValue(true);
 Object.assign(window.oaDesktop!,{openOriginalField});
 mock.mockImplementation(async(p,o)=>p.includes('?')?{total:1,rows:[{...record,...snapshot,snapshot}]}
  :p.endsWith('/1')?{...record,snapshot}:original(p,o));
 render(<DesktopAfterSalesPage/>);
 fireEvent.click(await screen.findByRole('button',{name:'查看原订单下单金额明细'}));
 const amounts=await screen.findByRole('dialog',{name:'原订单下单金额'});
 expect(within(amounts).getByText('商品金额：30.00')).toBeTruthy();
 expect(screen.getByText('业务说明').tagName).toBe('SPAN');
 expect(screen.queryByRole('button',{name:'在聚水潭打开备注'})).toBeNull();
 await waitFor(()=>expect((screen.getByRole('button',{name:'查看原订单下单金额明细'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.keyDown(document,{key:'Escape'});
 fireEvent.click(screen.getByRole('button',{name:'查看拒绝原因'}));
 const refusal=await screen.findByRole('dialog',{name:'拒绝原因'});
 expect(within(refusal).getByText('买家重复提交')).toBeTruthy();
 fireEvent.click(within(refusal).getByRole('button',{name:'关闭售后详情'}));
 await waitFor(()=>expect((screen.getByRole('button',{name:'下载售后问题登记附件'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'下载售后问题登记附件'}));
 await waitFor(()=>expect(openOriginalField).toHaveBeenCalledWith({afterSaleId:'85110001',sourceCompany:'演示公司',column:'售后问题登记',action:'attachment'}));
});
it('聚水潭已登录时，两个单号也只在 OA 内打开各自详情',async()=>{
 const original=mock.getMockImplementation()!;
 const record=archive(),snapshot=record.snapshot;
 const openOriginalSale=vi.fn().mockResolvedValue(true),openOriginalOrder=vi.fn().mockResolvedValue(true);
 const sale={...snapshot,fields:{'快递登记':'退货未登记'}};
 const order={...snapshot,productImages:['https://img.pddpic.com/goods/a.jpg'],fields:{'商品明细':JSON.stringify({columns:['商品信息','数量'],rows:[['样例商品','2']]})}};
 const readSaleDetail=vi.fn().mockResolvedValue(sale),readOrderDetail=vi.fn().mockResolvedValue(order);
 Object.assign(window.oaDesktop!,{
  jushuitanStatus:vi.fn().mockResolvedValue({state:'authenticated',sourceCompany:'演示公司'}),
  openOriginalSale,openOriginalOrder,readSaleDetail,readOrderDetail,
 });
 mock.mockImplementation(async(p,o)=>{
  if(p.endsWith('/1/source'))return {...record,snapshot:{...snapshot,fields:{...snapshot.fields,...(o?.body as typeof sale)?.fields}}};
  return original(p,o);
 });
 render(<DesktopAfterSalesPage/>);
 await screen.findByText(/聚水潭已登录/);
 fireEvent.click(await screen.findByRole('button',{name:'85110001'}));
 const saleDetail=await screen.findByRole('article',{name:'售后单详情'});
 await within(saleDetail).findByText('退货未登记');
 expect(within(saleDetail).getByRole('region',{name:'售后单金额'})).toBeTruthy();
 const identity={afterSaleId:'85110001',internalOrderId:'4400001',sourceCompany:'演示公司'};
 expect(readSaleDetail).toHaveBeenCalledWith(identity);
 fireEvent.click(within(saleDetail).getByRole('button',{name:'4400001'}));
 const orderDetail=await screen.findByRole('article',{name:'内部订单详情'});
 await within(orderDetail).findByRole('cell',{name:'样例商品'});
 expect(within(orderDetail).getByRole('region',{name:'交易信息'})).toBeTruthy();
 expect(readOrderDetail).toHaveBeenCalledWith(identity);
 fireEvent.click(within(orderDetail).getByRole('button',{name:'查看商品图片'}));
 expect(screen.getByRole('dialog',{name:'商品图片'})).toBeTruthy();
 expect(mock.mock.calls.filter(([path])=>path.endsWith('/source')).some(([,options])=>Object.hasOwn(options?.body as object,'productImages'))).toBe(false);
 expect(openOriginalSale).not.toHaveBeenCalled();
 expect(openOriginalOrder).not.toHaveBeenCalled();
});
it('本机聚水潭登录状态由桌面会话提供，与服务器采集配置独立',async()=>{
 const openSourceWindow=vi.fn().mockResolvedValue(true);
 const jushuitanStatus=vi.fn()
  .mockResolvedValueOnce({state:'login_required'})
  .mockResolvedValue({state:'authenticated',sourceCompany:'演示公司'});
 Object.assign(window.oaDesktop!,{surface:'after-sales',openSourceWindow,jushuitanStatus});
 render(<DesktopAfterSalesPage/>);
 const signIn=await screen.findByRole('button',{name:'聚水潭未登录 · 点击登录'});
 expect(signIn.closest('header')).toBeTruthy();
 expect(await screen.findByText('服务器暂无采集来源')).toBeTruthy();
 fireEvent.click(signIn);
 expect(openSourceWindow).toHaveBeenCalledOnce();
 fireEvent.focus(window);
 expect(await screen.findByText(/聚水潭已登录/)).toBeTruthy();
 expect(await screen.findByText('服务器暂无采集来源')).toBeTruthy();
});
it('聚水潭未登录仍可打开已归档售后且不会发起逐单刷新',async()=>{
 const query=vi.fn();
 Object.assign(window.oaDesktop!,{jushuitanStatus:vi.fn().mockResolvedValue({state:'login_required'}),query});
 render(<DesktopAfterSalesPage/>);
 await screen.findByRole('button',{name:'聚水潭未登录 · 点击登录'});
 await choose();
 expect(screen.getByText('正在显示 OA 已归档数据 · 请先登录聚水潭')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'聚水潭字段变更'}));
 expect(screen.getByText(/最近读取/)).toBeTruthy();
 expect(query).not.toHaveBeenCalled();
});
it('视频监控只向桌面端发送所选售后单的身份，并显示来源没有入口的提示',async()=>{
 const openOriginalVideo=vi.fn().mockRejectedValue(new Error('聚水潭未显示这笔售后的可用视频监控入口'));
 Object.assign(window.oaDesktop!,{surface:'after-sales',openOriginalVideo});
 render(<DesktopAfterSalesPage/>);
 const row=(await screen.findByRole('button',{name:'85110002'})).closest('tr')!;
 fireEvent.click(within(row).getByRole('button',{name:'视频监控'}));
 await screen.findByText('聚水潭未显示这笔售后的可用视频监控入口');
 expect(openOriginalVideo).toHaveBeenCalledTimes(1);
 expect(openOriginalVideo).toHaveBeenCalledWith({afterSaleId:'85110002',sourceCompany:'演示公司'});
 expect(mock.mock.calls.some(([path,options])=>options?.body&&!path.endsWith('/activity'))).toBe(false);
});

it('分别显示聚水潭的有视频、没视频和未核实状态',async()=>{
 const openOriginalVideo=vi.fn();
 const record=archive(3);
 const original=mock.getMockImplementation()!;
 mock.mockImplementation(async(path,options)=>{
  const result=await original(path,options);
  return path.includes('?')?{total:3,rows:[...((result as {rows:unknown[]}).rows),{...record,...record.snapshot}]}:result;
 });
 const getOriginalVideoStatuses=vi.fn().mockResolvedValue([
  {afterSaleId:'85110001',sourceCompany:'演示公司',state:'available'},
  {afterSaleId:'85110002',sourceCompany:'演示公司',state:'unavailable'},
 ]);
 Object.assign(window.oaDesktop!,{surface:'after-sales',openOriginalVideo,getOriginalVideoStatuses});
 render(<DesktopAfterSalesPage/>);
 await screen.findByText('有视频');
 const row=(sale:string)=>within(screen.getByRole('button',{name:sale}).closest('tr')!);
 expect(row('85110001').getByRole('button',{name:'视频监控'})).toBeTruthy();
 expect(row('85110002').getByText('没视频')).toBeTruthy();
 expect(row('85110002').queryByRole('button',{name:'视频监控'})).toBeNull();
 expect(row('85110003').getByText('未核实')).toBeTruthy();
 expect(openOriginalVideo).not.toHaveBeenCalled();
});

it('订单优惠在 OA 弹窗中从当前订单读取并记录操作者',async()=>{
 const original=mock.getMockImplementation()!;
 const record=archive(),snapshot={...record.snapshot,fields:{'支付优惠':'3.00'}};
 const detail={...snapshot,fields:{'订单优惠明细':JSON.stringify({summary:false,items:[['平台优惠券','3.00'],['店铺红包','1.00']]})}};
 const readOrderDiscount=vi.fn().mockResolvedValue(detail);
 Object.assign(window.oaDesktop!,{readOrderDiscount,readOrderDetail:vi.fn().mockResolvedValue(snapshot)});
 mock.mockImplementation(async(path,options)=>{
  if(path.endsWith('/1/source'))return {...record,snapshot:{...snapshot,fields:{...snapshot.fields,...(options?.body as typeof detail)?.fields}}};
  if(path.endsWith('/1'))return {...record,snapshot};
  return original(path,options);
 });
 render(<DesktopAfterSalesPage/>);
 fireEvent.click(await screen.findByRole('button',{name:'4400001'}));
 fireEvent.click(await screen.findByRole('button',{name:'查看优惠明细'}));
 const dialog=await screen.findByRole('dialog',{name:'订单优惠明细'});
 expect(await within(dialog).findByRole('cell',{name:'平台优惠券'})).toBeTruthy();
 expect(readOrderDiscount).toHaveBeenCalledWith({afterSaleId:'85110001',internalOrderId:'4400001',sourceCompany:'演示公司'});
 expect(mock.mock.calls.some(([path,options])=>path.endsWith('/1/activity')&&(options?.body as {click?:string})?.click==='view_discount')).toBe(true);
});

it('确认有播放器时，录像挂载在 OA 内并可关闭',async()=>{
 const prepareRecording=vi.fn().mockResolvedValue({state:'ready'});
 const openOriginalVideo=vi.fn();
 Object.assign(window.oaDesktop!,{prepareRecording,openOriginalVideo});
 render(<DesktopAfterSalesPage/>);
 const row=(await screen.findByRole('button',{name:'85110001'})).closest('tr')!;
 fireEvent.click(within(row).getByRole('button',{name:'视频监控'}));
 const dialog=await screen.findByRole('dialog',{name:'售后录像回放'});
 await waitFor(()=>expect(window.oaDesktop!.mount).toHaveBeenCalled());
 expect(prepareRecording).toHaveBeenCalledWith({afterSaleId:'85110001',sourceCompany:'演示公司'});
 expect(openOriginalVideo).not.toHaveBeenCalled();
 fireEvent.click(within(dialog).getByRole('button',{name:'关闭录像'}));
 await waitFor(()=>expect(window.oaDesktop!.hide).toHaveBeenCalled());
});

it('极速版确认有录像但未显示播放入口时，仍标记有录像',async()=>{
 const prepareRecording=vi.fn().mockResolvedValue({state:'missing',hasRecording:true});
 Object.assign(window.oaDesktop!,{prepareRecording});
 render(<DesktopAfterSalesPage/>);
 const row=within((await screen.findByRole('button',{name:'85110001'})).closest('tr')!);
 fireEvent.click(row.getByRole('button',{name:'视频监控'}));
 await screen.findByText('聚水潭确认有录像，当前页面未显示播放入口');
 expect(row.getByText('有视频')).toBeTruthy();
 expect(row.queryByText('未核实')).toBeNull();
});
