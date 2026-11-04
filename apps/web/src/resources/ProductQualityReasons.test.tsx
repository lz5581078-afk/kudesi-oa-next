import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {resourcePermission} from '@kudesi/shared';
import {ProductQualityDialog} from './ProductQualityDialog';
import {resourceApi,type ResourceDto} from './api';
const actor=vi.hoisted(()=>({companyId:1,admin:true}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:actor.companyId,permissions:{isCompanyAdmin:actor.admin,allow:[resourcePermission('finance-zero-reasons','view')],deny:[]}}})}));
vi.mock('./api',async original=>({...await original<typeof import('./api')>(),resourceApi:{list:vi.fn(),create:vi.fn(),update:vi.fn(),remove:vi.fn()}}));
const api=vi.mocked(resourceApi),reason=(id:number,title:string):ResourceDto=>({id,type:'finance-zero-reasons',title,data:{reason:title},status:'active',statusReason:null,files:{},refLabels:{},secretConfigured:{},createdAt:'',updatedAt:''});
const values={archiveType:'raw',name:'合成资料',purchaseSpec:'千克',purchasePrice:100,freight:0,handlingFee:1};
const view=(onCancel=()=>{})=><ProductQualityDialog values={values} options={{canCost:true}} onCancel={onCancel} onConfirm={()=>{}}/>;
beforeEach(()=>{vi.resetAllMocks();actor.companyId=1;actor.admin=true;api.list.mockResolvedValue({items:[],total:0,page:1,pageSize:200});});
afterEach(cleanup);
it('原因全分页可搜索选择，方向键与Escape不关闭核算窗口',async()=>{
 const rows=Array.from({length:205},(_,i)=>reason(i+1,`原因${String(i+1).padStart(3,'0')}`));
 api.list.mockImplementation(async(_type,query)=>({items:rows.slice(((query?.page??1)-1)*200,(query?.page??1)*200),total:205,page:query?.page??1,pageSize:200}));
 const cancel=vi.fn();render(view(cancel));const input=screen.getByRole('combobox',{name:'运费零值原因'});
 await waitFor(()=>expect((input as HTMLInputElement).disabled).toBe(false));
 expect(api.list).toHaveBeenCalledWith('finance-zero-reasons',expect.objectContaining({page:2}));
 fireEvent.change(input,{target:{value:'205'}});const option=await screen.findByRole('option',{name:'原因205'});fireEvent.keyDown(input,{key:'ArrowDown'});
 await waitFor(()=>expect(document.activeElement).toBe(option));fireEvent.keyDown(option,{key:'Escape'});expect(cancel).not.toHaveBeenCalled();expect(screen.queryByRole('listbox')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'运费零值原因下拉选项'}));fireEvent.click(screen.getByRole('option',{name:'原因205'}));
 expect((input as HTMLInputElement).value).toBe('原因205');fireEvent.click(screen.getByRole('button',{name:'确认该项为0'}));expect(screen.getByText('已确认：原因205')).toBeTruthy();
});
it('内嵌维护支持搜索和真实编辑接口，最多180字；查看权限不出现写入控件',async()=>{
 let rows=[reason(1,'原有原因')];api.list.mockImplementation(async()=>({items:rows,total:rows.length,page:1,pageSize:200}));
 api.update.mockImplementation(async(_type,id,body)=>{rows=[reason(id,String(body.reason))];return rows[0];});
 const rendered=render(view());fireEvent.click(screen.getByRole('button',{name:'管理零值原因'}));fireEvent.click(await screen.findByRole('button',{name:'编辑原因原有原因'}));
 const input=screen.getByRole('textbox',{name:'常用原因名称'});expect(input.getAttribute('maxlength')).toBe('180');fireEvent.change(input,{target:{value:'维护后原因'}});fireEvent.click(screen.getByRole('button',{name:'保存原因修改'}));
 await screen.findByRole('button',{name:'编辑原因维护后原因'});expect(api.update).toHaveBeenCalledWith('finance-zero-reasons',1,{reason:'维护后原因'});
 fireEvent.change(screen.getByRole('textbox',{name:'维护原因搜索'}),{target:{value:'不存在'}});expect(screen.queryByRole('button',{name:'编辑原因维护后原因'})).toBeNull();
 actor.admin=false;rendered.rerender(view());fireEvent.click(screen.getByRole('button',{name:'管理零值原因'}));await screen.findByText('维护后原因');
 expect(screen.queryByRole('button',{name:'新增原因'})).toBeNull();expect(screen.queryByRole('button',{name:'编辑原因维护后原因'})).toBeNull();expect(screen.queryByRole('button',{name:'删除原因维护后原因'})).toBeNull();
});
it('换公司后旧原因续页不回填，读取失败可明确重试',async()=>{
 let resolve!:(result:Awaited<ReturnType<typeof resourceApi.list>>)=>void;
 api.list.mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockRejectedValueOnce(new Error('读取失败')).mockResolvedValue({items:[reason(2,'当前公司原因')],total:1,page:1,pageSize:200});
 const rendered=render(view());actor.companyId=2;rendered.rerender(view());await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'重试'}));
 await waitFor(()=>expect((screen.getByRole('combobox',{name:'运费零值原因'}) as HTMLInputElement).disabled).toBe(false));resolve({items:[reason(1,'旧公司原因')],total:1,page:1,pageSize:200});
 fireEvent.click(screen.getByRole('button',{name:'运费零值原因下拉选项'}));await screen.findByRole('option',{name:'当前公司原因'});expect(screen.queryByRole('option',{name:'旧公司原因'})).toBeNull();
});
it('核算面板显示真实八位物流值，不截成普通六位报价',async()=>{
 render(<ProductQualityDialog values={{...values,freight:12.345678,handlingFee:0.000001}} options={{canCost:true}} onCancel={()=>{}} onConfirm={()=>{}}/>);
 expect(screen.getByText('0.12345678')).toBeTruthy();expect(screen.getByText('0.00000001')).toBeTruthy();
 await waitFor(()=>expect(screen.getByRole('button',{name:'确认并保存'}).hasAttribute('disabled')).toBe(false));
});
