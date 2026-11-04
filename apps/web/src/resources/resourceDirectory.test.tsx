import { afterEach, expect, it, vi } from 'vitest';
import { loadResourceDirectory } from './resourceDirectory';
import { resourceApi, type ResourceDto } from './api';
vi.mock('./api',()=>({resourceApi:{list:vi.fn()}}));
afterEach(()=>vi.resetAllMocks());
const row=(id:number):ResourceDto=>({id,type:'finance-packaging-schemes',title:'方案'+id,data:{},status:id%2?'inactive':'active',statusReason:null,refLabels:{},files:{},secretConfigured:{},createdAt:'',updatedAt:''});
it('完整201条读取，默认仍只返回启用项，包装摘要可显式含停用项',async()=>{
 const rows=Array.from({length:201},(_,i)=>row(i+1));
 vi.mocked(resourceApi.list).mockImplementation(async(_type,q)=>({items:rows.slice(((q?.page??1)-1)*200,(q?.page??1)*200),total:201,page:q?.page??1,pageSize:200}));
 expect(await loadResourceDirectory('finance-packaging-schemes',()=>true)).toHaveLength(100);
 expect(await loadResourceDirectory('finance-packaging-schemes',()=>true,undefined,{includeInactive:true})).toHaveLength(201);
});
it.each(['empty','duplicate','changed','excess'] as const)('不完整目录 %s 拒绝返回部分统计',async mode=>{
 const first={items:[row(1)],total:2,page:1,pageSize:200};
 const second=mode==='empty'?{...first,items:[]}:mode==='duplicate'?{...first,items:[row(1)]}:mode==='changed'?{...first,items:[row(2)],total:3}:{...first,items:[row(2),row(3)]};
 vi.mocked(resourceApi.list).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
 await expect(loadResourceDirectory('finance-packaging-schemes',()=>true)).rejects.toThrow('目录读取不完整');
});
it('非法total拒绝，身份过期的迟到响应返回null',async()=>{
 for(const total of [-1,.5]){vi.mocked(resourceApi.list).mockResolvedValue({items:[],total,page:1,pageSize:200});await expect(loadResourceDirectory('finance-packaging-schemes',()=>true)).rejects.toThrow();}
 let current=true;vi.mocked(resourceApi.list).mockImplementation(async()=>{current=false;return{items:[row(1)],total:1,page:1,pageSize:200};});
 expect(await loadResourceDirectory('finance-packaging-schemes',()=>current)).toBeNull();
});
