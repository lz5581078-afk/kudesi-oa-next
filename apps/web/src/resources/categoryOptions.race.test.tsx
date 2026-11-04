import {beforeEach,expect,it,vi} from 'vitest';
import type {CategoryOptionsPayload} from '@kudesi/shared';
import {api} from '../api/client';
import {categoryOptionsOf,loadCategoryOptions,resetCategoryOptions} from './categoryOptions';
vi.mock('../api/client',()=>({api:vi.fn()}));
const payload=(label:string):CategoryOptionsPayload=>({qualifications:{field:'type',rows:[{value:'c_synthetic',label,sortOrder:100,custom:true,hidden:false}]}});
beforeEach(()=>{vi.resetAllMocks();resetCategoryOptions();});
it('切换身份后旧选项响应及finally不能覆盖新公司或清除新请求',async()=>{
 let oldFinish!:(value:CategoryOptionsPayload)=>void,nextFinish!:(value:CategoryOptionsPayload)=>void;
 vi.mocked(api).mockImplementationOnce(()=>new Promise(resolve=>{oldFinish=resolve;})).mockImplementationOnce(()=>new Promise(resolve=>{nextFinish=resolve;}));
 const old=loadCategoryOptions();resetCategoryOptions();const current=loadCategoryOptions();
 oldFinish(payload('旧公司分类'));await old;
 expect(categoryOptionsOf('qualifications')?.some(option=>option.label==='旧公司分类')).toBe(false);
 expect(loadCategoryOptions()).toBe(current);expect(api).toHaveBeenCalledTimes(2);
 nextFinish(payload('当前公司分类'));await current;
 expect(categoryOptionsOf('qualifications')?.find(option=>option.value==='c_synthetic')?.label).toBe('当前公司分类');
});
it('同公司强制刷新以最后一次为准，旧失败不覆盖已完成维护结果',async()=>{
 let fail!:(error:Error)=>void;
 vi.mocked(api).mockImplementationOnce(()=>new Promise((_,reject)=>{fail=reject;})).mockResolvedValueOnce(payload('刚维护的分类'));
 const old=loadCategoryOptions();await loadCategoryOptions(true);fail(new Error('旧请求失败'));await old;
 expect(categoryOptionsOf('qualifications')?.find(option=>option.value==='c_synthetic')?.label).toBe('刚维护的分类');
 await loadCategoryOptions();expect(api).toHaveBeenCalledTimes(2);
});
