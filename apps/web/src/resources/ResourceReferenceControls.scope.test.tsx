import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {FieldDef} from '@kudesi/shared';
import {RefSelect,RefsSelect,clearRefCache} from './ResourceReferenceControls';
import {resourceApi,type ListResult,type ResourceDto} from './api';
import {setReferenceCacheIdentity} from './referenceOptionsCache';
const auth=vi.hoisted(()=>({companyId:1,id:1,permissions:{allow:[] as string[],deny:[] as string[]}}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:auth})}));
vi.mock('./api',()=>({resourceApi:{list:vi.fn()}}));
const field:FieldDef={key:'categoryId',label:'分类',group:'基础信息',type:'ref',ref:'finance-categories'};
const row=(id:number,title:string,data={}):ResourceDto=>({id,title,data,status:'active',type:'',statusReason:null,refLabels:{},files:{},secretConfigured:{},createdAt:'',updatedAt:''});
const list=(items:ResourceDto[]):ListResult=>({items,total:items.length,page:1,pageSize:200});
beforeEach(()=>{vi.resetAllMocks();auth.companyId=1;auth.id=1;auth.permissions.allow=[];setReferenceCacheIdentity(auth,true);clearRefCache();});
afterEach(cleanup);
it.each(['single','multi'] as const)('%s 引用身份变化后不会复用旧公司目录或接收迟到响应',async kind=>{
 let finish!:(result:ListResult)=>void;
 vi.mocked(resourceApi.list).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue(list([row(2,'当前公司叶分类')]));
 const control=()=>kind==='single'?<RefSelect field={field} value={null} onChange={vi.fn()}/>:<RefsSelect field={field} value={[]} onChange={vi.fn()}/>;
 const view=render(control());await waitFor(()=>expect(resourceApi.list).toHaveBeenCalledTimes(1));
 act(()=>{auth.companyId=2;setReferenceCacheIdentity(auth);view.rerender(control());});await screen.findByText('当前公司叶分类');
 const reads=vi.mocked(resourceApi.list).mock.calls.length;
 await act(async()=>{finish({...list(Array.from({length:200},(_,i)=>row(i+10,'旧公司分类'))),total:201});});
 expect(screen.queryByText('旧公司分类')).toBeNull();
 expect(resourceApi.list).toHaveBeenCalledTimes(reads);
 auth.permissions.allow=['product.cost.view'];vi.mocked(resourceApi.list).mockResolvedValueOnce(list([row(3,'新权限目录')]));view.rerender(control());
 await screen.findByText('新权限目录');expect(screen.queryByText('当前公司叶分类')).toBeNull();
});
it('编码分类按独立字典类型过滤并显示完整父路径，不混入品种',async()=>{
 vi.mocked(resourceApi.list).mockResolvedValue(list([row(1,'根分类',{kind:'product_category',code:'A'}),row(2,'末级分类',{kind:'product_category',parentId:1,code:'B'}),row(3,'同名品种',{kind:'variety',code:'C'})]));
 render(<RefSelect field={{...field,ref:'finance-code-dictionaries',refOptions:{complete:true,filters:{kind:'product_category'},pathField:'parentId',codeField:'code'}}} value={null} onChange={vi.fn()}/>);
 await screen.findByRole('option',{name:'根分类 / 末级分类（B）'});
 expect(screen.queryByRole('option',{name:/同名品种/})).toBeNull();
});
it('分类多选沿维护顺序逐树展开，不按名称把不同父级的末级穿插',async()=>{
 vi.mocked(resourceApi.list).mockResolvedValue(list([row(11,'乙根',{sort:1}),row(21,'甲根',{sort:2}),row(23,'A末级',{parentId:21,sort:1}),row(13,'Z末级',{parentId:11,sort:2}),row(12,'Y末级',{parentId:11,sort:1})]));
 render(<RefsSelect field={field} value={[]} leafOnly onChange={vi.fn()}/>);
 await screen.findByText('乙根 / Y末级');
 expect(screen.getAllByRole('checkbox').map(input=>input.parentElement?.textContent)).toEqual(['乙根 / Y末级','乙根 / Z末级','甲根 / A末级']);
});
it('明确启用末级选择时不新列父级，保留当前历史父级且不自动改值',async()=>{
 vi.mocked(resourceApi.list).mockResolvedValue(list([row(1,'父级',{kind:'product_category',code:'A'}),row(2,'末级',{kind:'product_category',parentId:1,code:'B'}),row(3,'另一个父级',{kind:'product_category'}),{...row(4,'停用子级',{kind:'product_category',parentId:3}),status:'inactive'}]));
 const change=vi.fn();render(<RefSelect field={{...field,ref:'finance-code-dictionaries',refOptions:{complete:true,filters:{kind:'product_category'},pathField:'parentId',leafOnly:true}}} value={1} labelNow="历史父级" onChange={change}/>);
 await screen.findByRole('option',{name:'父级 / 末级'});
 expect(screen.queryByRole('option',{name:'父级'})).toBeNull();
 expect(screen.queryByRole('option',{name:'另一个父级'})).toBeNull();
 expect(screen.getByRole('option',{name:'历史父级'})).toHaveProperty('selected',true);expect(change).not.toHaveBeenCalled();
});
