import {act,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({identity:'company1/user1',api:vi.fn(),read:vi.fn(),download:vi.fn()}));
vi.mock('../pages/finance/CostIdentityBoundary',()=>({useCostIdentityKey:()=>state.identity}));
vi.mock('../api/client',()=>({api:(...args:unknown[])=>state.api(...args)}));
vi.mock('./productCostWorkbook',()=>({readProductCostWorkbook:(...args:unknown[])=>state.read(...args),downloadProductCostWorkbook:(...args:unknown[])=>state.download(...args),productCostPhysicalIssues:(issues:Array<{row:number}>,numbers:number[])=>issues.map(e=>({...e,row:numbers[e.row-2]}))}));
import {useProductCostExcelActions} from './useProductCostExcelActions';
afterEach(()=>{vi.resetAllMocks();state.identity='company1/user1';});
const file=new File(['synthetic'],'合成.xlsx');const rows=[{'档案编号':'00001'}];
const preview={errors:[],warnings:[{sheet:'商品档案成本',row:2,field:'',message:'提醒'}],created:1,updated:0,rowCount:1,confirm:'server-signature'};
it('直接选文件→现API预检→显式确认→execute，忙时互斥且保留服务端confirm',async()=>{
 const confirm=vi.fn().mockResolvedValue(true),done=vi.fn();state.read.mockResolvedValue({rows,rowNumbers:[5]});state.api.mockResolvedValueOnce(preview).mockResolvedValueOnce({...preview,confirm:undefined});
 const {result}=renderHook(()=>useProductCostExcelActions({canImport:true,confirm,onDone:done}));
 await act(async()=>{const first=result.current.pickFile(file);void result.current.pickFile(file);await first;});
 expect(state.api.mock.calls).toEqual([['/finance/product-costs/import/preflight',{method:'POST',body:{rows}}],['/finance/product-costs/import/execute',{method:'POST',body:{rows,confirm:'server-signature'}}]]);expect(confirm).toHaveBeenCalledWith('预检通过：新增1条、更新0条，提醒1项。是否导入商品档案成本？');expect(done).toHaveBeenCalledOnce();expect(result.current.notice).toContain('新增1条');
});
it('错误按真实Excel行号报错，取消确认或无权限都不执行',async()=>{
 state.read.mockResolvedValue({rows,rowNumbers:[5]});state.api.mockResolvedValueOnce({...preview,errors:[{sheet:'商品档案成本',row:2,field:'',message:'原行错误'}]});const confirm=vi.fn().mockResolvedValue(false);
 const {result,rerender}=renderHook(({canImport})=>useProductCostExcelActions({canImport,confirm,onDone:vi.fn()}),{initialProps:{canImport:true}});
 await act(()=>result.current.pickFile(file));expect(result.current.error).toContain('第5行：原行错误');expect(confirm).not.toHaveBeenCalled();
 state.api.mockResolvedValueOnce(preview);await act(()=>result.current.pickFile(file));expect(confirm).toHaveBeenCalledOnce();expect(state.api).toHaveBeenCalledTimes(2);
 rerender({canImport:false});await act(()=>result.current.pickFile(file));expect(result.current.error).toContain('没有导入');expect(state.api).toHaveBeenCalledTimes(2);
});
it('公司/用户/权限切换后旧预检、旧确认结果均不能触发execute或回调',async()=>{
 let resolve!:(value:typeof preview)=>void;state.read.mockResolvedValue({rows,rowNumbers:[2]});state.api.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const confirm=vi.fn().mockResolvedValue(true),done=vi.fn();
 const {result,rerender}=renderHook(()=>useProductCostExcelActions({canImport:true,confirm,onDone:done}));let pending!:Promise<void>;act(()=>{pending=result.current.pickFile(file);});await waitFor(()=>expect(state.api).toHaveBeenCalledOnce());state.identity='company2/user2/changed-permissions';rerender();await act(async()=>{resolve(preview);await pending;});expect(confirm).not.toHaveBeenCalled();expect(done).not.toHaveBeenCalled();expect(result.current.notice).toBe('');
 let confirmResolve!:(value:boolean)=>void;confirm.mockImplementationOnce(()=>new Promise(r=>{confirmResolve=r;}));state.api.mockResolvedValueOnce(preview);act(()=>{pending=result.current.pickFile(file);});await waitFor(()=>expect(confirm).toHaveBeenCalledOnce());state.identity='company3/user3';rerender();await act(async()=>{confirmResolve(true);await pending;});expect(state.api).toHaveBeenCalledTimes(2);expect(done).not.toHaveBeenCalled();
});
it('直接下载只请求现template，身份迟到结果不下载',async()=>{
 let resolve!:(value:unknown)=>void;state.api.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const {result,rerender}=renderHook(()=>useProductCostExcelActions({canImport:true,confirm:vi.fn(),onDone:vi.fn()}));let pending!:Promise<void>;act(()=>{pending=result.current.downloadTemplate();});state.identity='other-company';rerender();await act(async()=>{resolve({headers:[],rows:[]});await pending;});expect(state.download).not.toHaveBeenCalled();
});
