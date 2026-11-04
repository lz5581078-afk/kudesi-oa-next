import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {MemoryRouter} from 'react-router-dom';
import {CostVersionRecords} from './CostVersionRecords';
import {resourceApi,type ResourceDto} from '../../resources/api';
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:{companyId:1,id:1,permissions:{isCompanyAdmin:true,allow:['*'],deny:[]}},can:()=>true})}));
vi.mock('../../resources/api',async orig=>({...await orig<typeof import('../../resources/api')>(),resourceApi:{list:vi.fn(),create:vi.fn(),update:vi.fn(),export:vi.fn()}}));
const row:ResourceDto={id:8,type:'finance-cost-aux-types',title:'合成公斤类型',status:'active',statusReason:null,data:{typeCode:'KG-SYN',typeName:'合成公斤类型',costBucket:'production',unitName:'元/公斤',calculationMethod:'per_kg',allowBucketOverride:false,note:''},createdAt:'',updatedAt:'',secretConfigured:{},files:{},refLabels:{}};
beforeEach(()=>{vi.mocked(resourceApi.list).mockResolvedValue({items:[row],total:1,page:1,pageSize:20});vi.mocked(resourceApi.create).mockResolvedValue(row);vi.mocked(resourceApi.update).mockResolvedValue(row);});
afterEach(()=>{cleanup();vi.clearAllMocks();});
const open=()=>render(<MemoryRouter><CostVersionRecords type="finance-cost-aux-types" versionId={0} locked={false}/></MemoryRouter>);
describe('辅助成本类型原新增与既有模式',()=>{
  it('新增窗口固定显示固定单价×数量，并用fixed_per_item真实提交',async()=>{
    open();await screen.findByText('合成公斤类型');fireEvent.click(screen.getByRole('button',{name:'新增辅助成本类型'}));
    const dialog=screen.getByRole('dialog');const mode=within(dialog).getByLabelText(/计算方式/) as HTMLInputElement;
    expect(mode.readOnly).toBe(true);expect(mode.value).toBe('固定单价 × 数量');
    fireEvent.change(within(dialog).getByLabelText(/类型编码/),{target:{value:'SYN-FIXED'}});
    fireEvent.change(within(dialog).getByLabelText(/类型名称/),{target:{value:'合成固定类型'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(resourceApi.create).toHaveBeenCalledWith('finance-cost-aux-types',expect.objectContaining({calculationMethod:'fixed_per_item',typeCode:'SYN-FIXED'}),'active'));
  });
  it('编辑既有per_kg显示真实模式，修改名称保存不会改成fixed_per_item',async()=>{
    open();await screen.findByText('合成公斤类型');fireEvent.click(screen.getByRole('button',{name:'编辑'}));
    const dialog=screen.getByRole('dialog');const mode=within(dialog).getByLabelText(/计算方式/) as HTMLSelectElement;
    expect(mode.disabled).toBe(false);expect(mode.value).toBe('per_kg');expect(within(mode).getByRole('option',{name:'按公斤'})).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/类型名称/),{target:{value:'合成公斤类型修订'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(resourceApi.update).toHaveBeenCalledWith('finance-cost-aux-types',8,expect.objectContaining({calculationMethod:'per_kg',typeName:'合成公斤类型修订'})));
  });
});
