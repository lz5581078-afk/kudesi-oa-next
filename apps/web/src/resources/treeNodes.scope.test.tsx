import {beforeEach,expect,it,vi} from 'vitest';
import {clearTreeNodes,descendantIds,loadAll,loadTreeNodes,toNode} from './treeNodes';
import {setReferenceCacheIdentity} from './referenceOptionsCache';
import {resourceApi,type ListResult,type ResourceDto} from './api';
vi.mock('./api',()=>({resourceApi:{list:vi.fn()}}));
const identity=(companyId:number)=>({id:1,companyId,permissions:{allow:[],deny:[]}});
const row=(id:number):ResourceDto=>({id,type:'finance-categories',title:`合成分类${id}`,data:{},status:'normal',statusReason:null,refLabels:{},files:{},secretConfigured:{},createdAt:'',updatedAt:''});
beforeEach(()=>{vi.resetAllMocks();setReferenceCacheIdentity(identity(1),true);clearTreeNodes();});
it('目录超过5000条仍完整，保持服务端次序和原showHidden语义',async()=>{
 const rows=Array.from({length:5001},(_,i)=>row(5001-i));
 vi.mocked(resourceApi.list).mockImplementation(async(_type,q)=>({items:rows.slice(((q.page??1)-1)*200,(q.page??1)*200),total:5001,page:q.page??1,pageSize:200}));
 expect((await loadAll('finance-categories',{showHidden:false})).map(row=>row.id)).toEqual(rows.map(row=>row.id));
 expect(resourceApi.list).toHaveBeenLastCalledWith('finance-categories',{page:26,pageSize:200,showHidden:false});
});
it('换公司立即失效树缓存，旧分页不续读且失败不删新缓存',async()=>{
 let finish!:(value:ListResult)=>void;
 vi.mocked(resourceApi.list).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({items:[row(9001)],total:1,page:1,pageSize:200});
 const old=loadTreeNodes('finance-categories'),rejected=expect(old).rejects.toThrow('身份已变化');
 setReferenceCacheIdentity(identity(2));const fresh=await loadTreeNodes('finance-categories');
 finish({items:Array.from({length:200},(_,i)=>row(i+1)),total:201,page:1,pageSize:200});await rejected;
 expect(await loadTreeNodes('finance-categories')).toBe(fresh);expect(resourceApi.list).toHaveBeenCalledTimes(2);
});
it('不把缺页目录作为成功缓存；修复后可重读',async()=>{
 vi.mocked(resourceApi.list).mockResolvedValueOnce({items:[row(1)],total:2,page:1,pageSize:200}).mockResolvedValueOnce({items:[],total:2,page:2,pageSize:200});
 await expect(loadTreeNodes('finance-categories')).rejects.toThrow('目录读取不完整');
 vi.mocked(resourceApi.list).mockResolvedValue({items:[row(2)],total:1,page:1,pageSize:200});expect((await loadTreeNodes('finance-categories')).map(row=>row.id)).toEqual([2]);
});
it('全部子孙不截断，并能终止异常环而不重复分类',()=>{
 const children=Array.from({length:5001},(_,i)=>toNode(row(i+2))),root=toNode(row(1));
 expect(descendantIds(1,new Map([[1,children],[2,[root]]]))).toHaveLength(5002);
});
