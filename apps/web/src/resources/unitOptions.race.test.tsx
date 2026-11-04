import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const api=vi.hoisted(()=>vi.fn());
vi.mock('../api/client',()=>({api}));
import {loadUnitOptions,resetUnitOptions,resetUnitOptionsForTest,useUnitOptions,type UnitOptionsPayload} from './unitOptions';
const deferred=()=>{let resolve!:(value:UnitOptionsPayload)=>void,reject!:(reason:Error)=>void;const promise=new Promise<UnitOptionsPayload>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function Units(){const options=useUnitOptions();return <output>{options.unit?.map(row=>row.label).join(',')||'空目录'}</output>;}
beforeEach(()=>{api.mockReset();resetUnitOptions();});
afterEach(()=>{cleanup();resetUnitOptionsForTest();});
it('换公司即时清空旧单位，已打开的字段重新读取，旧成功不覆盖新目录',async()=>{
 const old=deferred(),fresh=deferred();api.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
 render(<Units/>);await waitFor(()=>expect(api).toHaveBeenCalledTimes(1));
 act(()=>resetUnitOptions());expect(screen.getByText('空目录')).toBeTruthy();await waitFor(()=>expect(api).toHaveBeenCalledTimes(2));
 await act(async()=>fresh.resolve({unit:[{value:'B',label:'乙公司袋'}]}));expect(screen.getByText('乙公司袋')).toBeTruthy();
 await act(async()=>old.resolve({unit:[{value:'A',label:'甲公司箱'}]}));expect(screen.getByText('乙公司袋')).toBeTruthy();expect(screen.queryByText('甲公司箱')).toBeNull();
});
it('强制刷新后的旧失败/完成不解除新请求锁，也不将旧目录标成已读取',async()=>{
 const old=deferred(),fresh=deferred();api.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
 const first=loadUnitOptions(),second=loadUnitOptions(true);old.reject(new Error('旧请求失败'));await first;
 expect(loadUnitOptions()).toBe(second);expect(api).toHaveBeenCalledTimes(2);
 fresh.resolve({unit:[{value:'B',label:'当前单位'}]});await second;
 render(<Units/>);expect(screen.getByText('当前单位')).toBeTruthy();expect(api).toHaveBeenCalledTimes(2);
});
