import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {CostVersionRecords} from './CostVersionRecords';
import {resourceApi,type ResourceDto} from '../../resources/api';
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:{companyId:1,id:1,permissions:{isCompanyAdmin:true,allow:['*'],deny:[]}}})}));
vi.mock('../../resources/RecordDetail',()=>({useResourceCan:()=>()=>true}));
vi.mock('../../resources/RecordForm',()=>({RecordForm:({initial}:{initial:unknown})=><div role="dialog" aria-label="成本资料表单">{JSON.stringify(initial)}</div>,ReasonDialog:()=>null}));
vi.mock('../../resources/api',()=>({resourceApi:{list:vi.fn(),export:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const row=(name:string):ResourceDto=>({id:7,type:'finance-cost-auxiliary',title:name,data:{costName:name,amount:123.4567,versionId:1,costBucket:'production'},status:'active',statusReason:null,createdAt:'',updatedAt:'',secretConfigured:{},files:{},refLabels:{}});
const list=(name:string)=>({items:[row(name)],total:1,page:1,pageSize:20});
describe('独立成本版本内辅助资料',()=>{
  it('搜索不被前一请求覆盖，失败不保留可编辑旧记录',async()=>{
    let finish!:(value:ReturnType<typeof list>)=>void;
    vi.mocked(resourceApi.list).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce(list('新查询辅助成本')).mockRejectedValueOnce(new Error('合成失败'));
    render(<CostVersionRecords type="finance-cost-auxiliary" versionId={1} locked={false}/>);
    await waitFor(()=>expect(finish).toBeTruthy());
    fireEvent.change(screen.getByLabelText('搜索辅助成本'),{target:{value:'新查询'}});
    await screen.findByText('新查询辅助成本');
    finish(list('旧响应成本'));await waitFor(()=>expect(screen.queryByText('旧响应成本')).toBeNull());
    fireEvent.change(screen.getByLabelText('搜索辅助成本'),{target:{value:'失败'}});
    await screen.findByRole('alert');expect(screen.queryByText('新查询辅助成本')).toBeNull();
    expect(screen.queryByRole('button',{name:'编辑'})).toBeNull();
  });
  it('变更版本或锁定状态立即重建弹层，表单归属固定当前版本',async()=>{
    vi.mocked(resourceApi.list).mockResolvedValue(list('合成辅助成本'));
    const view=render(<CostVersionRecords type="finance-cost-auxiliary" versionId={1} locked={false}/>);
    await screen.findByText('合成辅助成本');fireEvent.click(screen.getByRole('button',{name:'新增辅助成本'}));
    expect(screen.getByRole('dialog').textContent).toContain('"versionId":1');
    view.rerender(<CostVersionRecords type="finance-cost-auxiliary" versionId={2} locked={false}/>);
    expect(screen.queryByRole('dialog')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'新增辅助成本'}));
    expect(screen.getByRole('dialog').textContent).toContain('"versionId":2');
    view.rerender(<CostVersionRecords type="finance-cost-auxiliary" versionId={2} locked/>);
    expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('button',{name:'新增辅助成本'})).toBeNull();
    await waitFor(()=>expect(resourceApi.list).toHaveBeenLastCalledWith('finance-cost-auxiliary',expect.objectContaining({fieldKey:'versionId',fieldValue:2})));
  });
});
