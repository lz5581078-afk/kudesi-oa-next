import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),user:{id:1,companyId:1,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}}));
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:mocks.user})}));
vi.mock('../api/client',()=>({api:mocks.api}));
import {useArchiveCodePreview} from './ArchiveCodeInput';
afterEach(()=>{cleanup();vi.clearAllMocks();mocks.user={...mocks.user,companyId:1};});
it('换公司立即隐藏旧自动编号，迟到旧公司响应不覆盖新预览',async()=>{
 let oldResolve!:(value:unknown)=>void,newResolve!:(value:unknown)=>void;
 mocks.api.mockResolvedValueOnce({code:'甲公司已读',shortCode:'A'}).mockReturnValueOnce(new Promise(resolve=>{oldResolve=resolve;})).mockReturnValueOnce(new Promise(resolve=>{newResolve=resolve;}));
 const view=renderHook(({name})=>useArchiveCodePreview('finance-suppliers',{name,categoryIds:[3]},true),{initialProps:{name:'合成名称'}});
 await waitFor(()=>expect(view.result.current.code).toBe('甲公司已读'));
 view.rerender({name:'修改名称'});await waitFor(()=>expect(mocks.api).toHaveBeenCalledTimes(2));
 mocks.user={...mocks.user,companyId:2};view.rerender({name:'修改名称'});expect(view.result.current.code).toBeUndefined();
 await waitFor(()=>expect(mocks.api).toHaveBeenCalledTimes(3));
 await act(async()=>newResolve({code:'乙公司编号',shortCode:'B'}));expect(view.result.current.code).toBe('乙公司编号');
 await act(async()=>oldResolve({code:'甲公司迟到编号',shortCode:'A2'}));expect(view.result.current.code).toBe('乙公司编号');
});
