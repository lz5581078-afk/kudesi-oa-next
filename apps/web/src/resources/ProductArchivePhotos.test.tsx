import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {ResourceDto} from './api';
const state=vi.hoisted(()=>({identity:'one',edit:true,save:vi.fn()}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{permissions:{isCompanyAdmin:false,allow:state.edit?['resource.finance-products.edit']:[],deny:[]}}})}));
vi.mock('../pages/finance/CostIdentityBoundary',()=>({useCostIdentityKey:()=>state.identity}));
vi.mock('./api',()=>({resourceApi:{gridSave:(...a:unknown[])=>state.save(...a)}}));
vi.mock('./FilesField',()=>({FileList:()=> <p>只读照片预览</p>,FilesInput:({value,onChange,field}:{value:number[];onChange:(ids:number[])=>void;field:{maxFiles:number;phoneUpload:boolean;accept:string}})=><div><span>{field.maxFiles}/{String(field.phoneUpload)}/{field.accept}</span><button onClick={()=>onChange([...value,2])}>合成上传</button><button onClick={()=>onChange(value.filter(id=>id!==1))}>合成移除</button></div>}));
import {ProductArchivePhotos} from './ProductArchivePhotos';
const record:ResourceDto={id:17,type:'finance-products',title:'合成原料',status:'active',statusReason:null,data:{photos:[1],purchasePrice:123},version:'v1',files:{1:{id:1,name:'合成.jpg',mime:'image/jpeg',size:2}},secretConfigured:{},refLabels:{},createdAt:'',updatedAt:''};
afterEach(()=>{cleanup();vi.clearAllMocks();state.identity='one';state.edit=true;});
const response=(version:string,photos:number[])=>({results:[{kind:'update',id:17,ok:true,row:{...record,version,data:{...record.data,photos}}}],saved:1,failed:0});
it('沿max20/image/手机原控件，单photos版本保存；上传与删除串行不覆盖末次',async()=>{
 let finish!:(v:unknown)=>void;state.save.mockImplementationOnce(()=>new Promise(r=>{finish=r;})).mockResolvedValueOnce(response('v3',[2]));const done=vi.fn();render(<ProductArchivePhotos record={record} onChanged={done}/>);
 expect(screen.getByText('20/true/image')).toBeTruthy();fireEvent.click(screen.getByText('合成上传'));await waitFor(()=>expect(state.save).toHaveBeenCalledOnce());
 fireEvent.click(screen.getByText('合成移除'));expect(state.save).toHaveBeenCalledOnce();fireEvent.click(screen.getByRole('button',{name:'删除'}));await act(async()=>finish(response('v2',[1,2])));
 await waitFor(()=>expect(state.save).toHaveBeenCalledTimes(2));expect(state.save.mock.calls[0]).toEqual(['finance-products',{updates:[{id:17,version:'v1',data:{photos:[1,2]}}],note:'商品照片'}]);expect(state.save.mock.calls[1][1].updates[0]).toEqual({id:17,version:'v2',data:{photos:[2]}});expect(done).toHaveBeenCalledOnce();
});
it('无编辑权限只预览，不提供上传/删除；缺version或保存失败明确提示且保输入',async()=>{
 state.edit=false;const {rerender}=render(<ProductArchivePhotos record={record}/>);expect(screen.getByText('只读照片预览')).toBeTruthy();expect(screen.queryByText('合成上传')).toBeNull();
 state.edit=true;rerender(<ProductArchivePhotos record={{...record,version:undefined}}/>);fireEvent.click(screen.getByText('合成上传'));await screen.findByText(/版本缺失/);expect(state.save).not.toHaveBeenCalled();
});
it('身份切换后旧photos保存不能回调新身份，旧请求不续发',async()=>{
 let finish!:(v:unknown)=>void;state.save.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));const done=vi.fn();const {rerender}=render(<ProductArchivePhotos record={record} onChanged={done}/>);fireEvent.click(screen.getByText('合成上传'));await waitFor(()=>expect(state.save).toHaveBeenCalledOnce());state.identity='two';rerender(<ProductArchivePhotos record={record} onChanged={done}/>);await act(async()=>finish(response('v2',[1,2])));expect(done).not.toHaveBeenCalled();expect(state.save).toHaveBeenCalledOnce();
});
it('删除取消不写；失败留选择供重试，不降级无版本PATCH',async()=>{
 state.save.mockResolvedValueOnce({results:[{kind:'update',id:17,ok:false,message:'版本冲突'}],failed:1,saved:0}).mockResolvedValueOnce(response('v2',[1,2]));render(<ProductArchivePhotos record={record}/>);
 fireEvent.click(screen.getByText('合成移除'));fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(state.save).not.toHaveBeenCalled();fireEvent.click(screen.getByText('合成上传'));await screen.findByText(/版本冲突/);fireEvent.click(screen.getByText('重试'));await waitFor(()=>expect(state.save).toHaveBeenCalledTimes(2));expect(state.save.mock.calls[1][1].updates[0].data).toEqual({photos:[1,2]});
});
