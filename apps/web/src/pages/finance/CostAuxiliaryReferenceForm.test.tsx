import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {MemoryRouter} from 'react-router-dom';
import {CostVersionRecords} from './CostVersionRecords';
import {resourceApi,type ResourceDto} from '../../resources/api';
import {clearRefCache} from '../../resources/RecordForm';
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:{companyId:1,id:1,permissions:{isCompanyAdmin:true,allow:['*'],deny:[]}},can:()=>true})}));
vi.mock('../../resources/api',async orig=>({...await orig<typeof import('../../resources/api')>(),resourceApi:{list:vi.fn(),get:vi.fn(),create:vi.fn(),update:vi.fn(),export:vi.fn()}}));
const resource=(type:string,id:number,title:string,data:Record<string,unknown>):ResourceDto=>({id,type,title,data,status:'active',statusReason:null,createdAt:'',updatedAt:'',secretConfigured:{},files:{},refLabels:{}});
const a=resource('finance-cost-aux-types',11,'合成采购类型',{typeName:'合成采购类型',costBucket:'purchase',unitName:'元/斤',allowBucketOverride:false});
const b=resource('finance-cost-aux-types',12,'合成可改类型',{typeName:'合成可改类型',costBucket:'express',unitName:'元/件',allowBucketOverride:true});
const aux=resource('finance-cost-auxiliary',21,'合成辅助项目',{versionId:1,auxTypeId:11,costName:'合成辅助项目',costBucket:'purchase',unitName:'历史单位',amount:100});
beforeEach(()=>{
  vi.mocked(resourceApi.list).mockImplementation(async type=>({items:type==='finance-cost-aux-types'?[a,b]:type==='finance-cost-versions'?[resource(type,1,'合成版本',{})]:[],total:type==='finance-cost-aux-types'?2:type==='finance-cost-versions'?1:0,page:1,pageSize:20}));
  vi.mocked(resourceApi.get).mockImplementation(async (_type,id)=>id===11?a:b);vi.mocked(resourceApi.create).mockResolvedValue(aux);vi.mocked(resourceApi.update).mockResolvedValue(aux);
});
afterEach(()=>{cleanup();clearRefCache();vi.clearAllMocks();});
const open=()=>{render(<MemoryRouter><CostVersionRecords type="finance-cost-auxiliary" versionId={1} locked={false}/></MemoryRouter>);fireEvent.click(screen.getByRole('button',{name:'新增辅助成本'}));return screen.getByRole('dialog');};
const choose=async(dialog:HTMLElement,id:number)=>{const select=within(dialog).getByLabelText('辅助类型') as HTMLSelectElement;await waitFor(()=>expect(select.disabled).toBe(false));fireEvent.change(select,{target:{value:String(id)}});};
describe('辅助成本选择类型后的默认值与科目锁定',()=>{
  it('从类型带入真实科目与默认单位，不允许改科目的类型只读，统一API保存正确值',async()=>{
    const dialog=open();await choose(dialog,11);
    await waitFor(()=>expect((within(dialog).getByLabelText(/归集科目/) as HTMLInputElement).readOnly).toBe(true));
    expect((within(dialog).getByLabelText(/归集科目/) as HTMLInputElement).value).toBe('采购成本');
    expect((within(dialog).getByLabelText('计价单位') as HTMLInputElement).value).toBe('元/斤');
    fireEvent.change(within(dialog).getByLabelText(/成本名称/),{target:{value:'合成新增辅助'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(resourceApi.create).toHaveBeenCalledWith('finance-cost-auxiliary',expect.objectContaining({versionId:1,auxTypeId:11,costBucket:'purchase',unitName:'元/斤'}),'active'));
  });
  it('切类型拒绝迟到回填，保留手填单位；允许改科目时保留可选控件',async()=>{
    let finish!:(value:ResourceDto)=>void;
    vi.mocked(resourceApi.get).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue(b);
    const dialog=open();fireEvent.change(within(dialog).getByLabelText('计价单位'),{target:{value:'人工单位'}});await choose(dialog,11);
    await waitFor(()=>expect(finish).toBeTruthy());expect((within(dialog).getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled).toBe(true);
    await choose(dialog,12);await waitFor(()=>expect((within(dialog).getByLabelText(/归集科目/) as HTMLSelectElement).value).toBe('express'));
    finish(a);await waitFor(()=>expect((within(dialog).getByLabelText(/归集科目/) as HTMLSelectElement).value).toBe('express'));
    expect(within(dialog).getByLabelText(/归集科目/).tagName).toBe('SELECT');expect((within(dialog).getByLabelText('计价单位') as HTMLInputElement).value).toBe('人工单位');
  });
  it('引用读取失败禁止保存，可原窗重试；编辑原项目不覆盖历史单位',async()=>{
    vi.mocked(resourceApi.get).mockRejectedValueOnce(new Error('合成引用失败')).mockResolvedValue(a);
    const dialog=open();await choose(dialog,11);await within(dialog).findByText('合成引用失败');
    expect((within(dialog).getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button',{name:'重试引用资料'}));
    await waitFor(()=>expect((within(dialog).getByLabelText('计价单位') as HTMLInputElement).value).toBe('元/斤'));
    cleanup();clearRefCache();
    vi.mocked(resourceApi.list).mockResolvedValue({items:[aux],total:1,page:1,pageSize:20});
    render(<MemoryRouter><CostVersionRecords type="finance-cost-auxiliary" versionId={1} locked={false}/></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button',{name:'编辑'}));
    await waitFor(()=>expect((screen.getByLabelText(/归集科目/) as HTMLInputElement).readOnly).toBe(true));
    expect((screen.getByLabelText('计价单位') as HTMLInputElement).value).toBe('历史单位');
    fireEvent.change(screen.getByLabelText(/成本名称/),{target:{value:'合成项目改名'}});fireEvent.click(screen.getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(resourceApi.update).toHaveBeenCalledWith('finance-cost-auxiliary',21,expect.objectContaining({unitName:'历史单位',costBucket:'purchase'})));
  });
});
