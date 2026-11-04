import {useState} from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ProductArchiveBrandSelect} from './ProductArchiveBrandSelect';
import {resourceApi,type ResourceDto} from './api';
const actor=vi.hoisted(()=>({company:1}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:actor.company,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('./api',async original=>({...await original<typeof import('./api')>(),resourceApi:{list:vi.fn(),create:vi.fn(),changeStatus:vi.fn()}}));
const api=vi.mocked(resourceApi),row=(id:number,title:string,status='active'):ResourceDto=>({id,type:'finance-brands',title,data:{name:title,code:'MANUAL'+id},status,statusReason:null,files:{},refLabels:{},secretConfigured:{},createdAt:'',updatedAt:''});
beforeEach(()=>{vi.resetAllMocks();actor.company=1;api.list.mockResolvedValue({items:[],total:0,page:1,pageSize:200});});afterEach(cleanup);
it('品牌完整读取205项，中文首字母与实际编码都能找到候选且展示编码',async()=>{
 const rows=Array.from({length:205},(_,i)=>row(i+1,i===204?'华泰':'合成'+i));api.list.mockImplementation(async(_type,q)=>({items:rows.slice(((q?.page??1)-1)*200,(q?.page??1)*200),total:205,page:q?.page??1,pageSize:200}));
 const change=vi.fn();render(<ProductArchiveBrandSelect value={null} onChange={change}/>);const input=screen.getByRole('combobox',{name:'品牌'});fireEvent.focus(input);
 await waitFor(()=>expect(api.list).toHaveBeenCalledWith('finance-brands',expect.objectContaining({page:2})));
 fireEvent.change(input,{target:{value:'HT'}});fireEvent.click(await screen.findByRole('option',{name:'华泰 MANUAL205'}));expect(change).toHaveBeenLastCalledWith(205);expect(api.create).not.toHaveBeenCalled();
});
it('内联使用并保存保留失败输入，真实ID返回前清旧选择并通知父表单等待',async()=>{
 let rows=[row(1,'原品牌')];api.list.mockImplementation(async()=>({items:rows,total:rows.length,page:1,pageSize:200}));api.create.mockRejectedValueOnce(new Error('合成新增失败')).mockImplementationOnce(async()=>{const saved=row(2,'新品牌');rows=[...rows,saved];return saved;});
 const pending=vi.fn();function Form(){const[value,setValue]=useState<number|null>(1);return <><ProductArchiveBrandSelect value={value} onChange={setValue} onPendingChange={pending}/><output data-testid="brand-id">{value}</output></>;}
 render(<Form/>);const input=screen.getByRole('combobox',{name:'品牌'});fireEvent.focus(input);await screen.findByRole('option',{name:'原品牌 MANUAL1'});fireEvent.change(input,{target:{value:'新品牌'}});expect(screen.getByTestId('brand-id').textContent).toBe('');
 fireEvent.click(screen.getByRole('button',{name:'使用并保存“新品牌”'}));await screen.findByRole('alert');expect((input as HTMLInputElement).value).toBe('新品牌');fireEvent.click(screen.getByRole('button',{name:'使用并保存“新品牌”'}));
 await waitFor(()=>expect(screen.getByTestId('brand-id').textContent).toBe('2'));expect(pending).toHaveBeenCalledWith(true);expect(pending).toHaveBeenLastCalledWith(false);expect(api.create).toHaveBeenLastCalledWith('finance-brands',{name:'新品牌'});
});
it('已有停用名称沿真实恢复接口，不新造重复品牌',async()=>{
 let rows=[row(1,'旧品牌','inactive')];api.list.mockImplementation(async()=>({items:rows,total:1,page:1,pageSize:200}));api.changeStatus.mockImplementation(async()=>{rows=[row(1,'旧品牌')];return rows[0];});const change=vi.fn();render(<ProductArchiveBrandSelect value={null} onChange={change}/>);
 const input=screen.getByRole('combobox',{name:'品牌'});fireEvent.focus(input);await screen.findByText('暂无品牌，可直接输入新品牌');fireEvent.change(input,{target:{value:'旧品牌'}});fireEvent.keyDown(input,{key:'Enter'});
 await waitFor(()=>expect(change).toHaveBeenLastCalledWith(1));expect(api.changeStatus).toHaveBeenCalledWith('finance-brands',1,'active');expect(api.create).not.toHaveBeenCalled();
});
it('换公司后旧内联新增的迟到ID不会写进新表单',async()=>{
 let resolve!:(row:ResourceDto)=>void;api.create.mockImplementation(()=>new Promise(done=>{resolve=done;}));const change=vi.fn(),props={value:null,onChange:change};const view=render(<ProductArchiveBrandSelect {...props}/>);const input=screen.getByRole('combobox',{name:'品牌'});fireEvent.focus(input);await screen.findByText('暂无品牌，可直接输入新品牌');fireEvent.change(input,{target:{value:'旧公司新品牌'}});fireEvent.click(screen.getByRole('button',{name:'使用并保存“旧公司新品牌”'}));
 actor.company=2;view.rerender(<ProductArchiveBrandSelect {...props}/>);resolve(row(9,'旧公司新品牌'));await waitFor(()=>expect((screen.getByRole('combobox',{name:'品牌'}) as HTMLInputElement).disabled).toBe(false));expect(change).not.toHaveBeenCalledWith(9);
});
