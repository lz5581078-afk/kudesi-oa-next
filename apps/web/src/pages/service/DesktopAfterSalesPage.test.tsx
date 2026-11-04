import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
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
  if(path.endsWith('/options'))return {stores:[{id:10,name:'演示店'}],people:[]};
  if(path.includes('?'))return {total:2,rows:[1,2].map(id=>({...archive(id).snapshot,id,progress:'等待物流'}))};
  if(path.endsWith('/1'))return archive();if(path.endsWith('/2'))return archive(2);
  if(path.endsWith('/1/files'))return {...archive(1,3),files:[{id:77,name:'截图.png',size:100,mime:'image/png'}]};
  return archive();
 });
});
afterEach(()=>{cleanup();delete window.oaDesktop;vi.restoreAllMocks();vi.unstubAllGlobals();mock.mockReset();});
async function choose(id=1){await screen.findByText(String(85110000+id));fireEvent.click(screen.getByText(String(85110000+id)));await screen.findByText(`售后 ${85110000+id}`);await waitFor(()=>expect((screen.getByLabelText('处理到哪一步') as HTMLInputElement).disabled).toBe(false));}
it('建档前必须选择正确 OA 店铺并确认来源公司，内部订单通过原页面打开',async()=>{
 render(<DesktopAfterSalesPage/>);await choose();fireEvent.click(screen.getByText('4400001'));await waitFor(()=>expect(window.oaDesktop!.openOrder).toHaveBeenCalledWith('4400001'));
 fireEvent.click(screen.getByText('读取当前页面'));await screen.findByText('读取结果 · 1 条');
 fireEvent.click(screen.getByText('确认关联并保存到 OA'));await screen.findByRole('alert');expect(mock.mock.calls.some(([p])=>p==='/desktop-after-sales/import')).toBe(false);
 fireEvent.change(screen.getByLabelText('关联 OA 店铺'),{target:{value:'10'}});fireEvent.click(screen.getByText('确认关联并保存到 OA'));
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
