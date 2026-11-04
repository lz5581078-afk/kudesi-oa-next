import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { getResourceDef,type FieldDef } from '@kudesi/shared';
import { clearRefCache,RefSelect } from './RecordForm';
import { resourceApi,type ResourceDto } from './api';
vi.mock('../auth/AuthContext',()=>({useAuth:()=>({user:{id:1,companyId:1,permissions:{isCompanyAdmin:true,allow:[],deny:[]}},can:()=>true})}));
const row=(type:string,id:number,title:string,data:Record<string,unknown>,refLabels:Record<string,string>={}):ResourceDto=>({type,id,title,data,refLabels,status:'normal',statusReason:null,secretConfigured:{},files:{},createdAt:'2026-10-31T00:00:00Z',updatedAt:'2026-10-31T00:00:00Z'});
afterEach(()=>{cleanup();clearRefCache();vi.restoreAllMocks();});
describe('同号登记选择',()=>{
  it('同号的不同认证人/套餐分别可选，提交被选登记的真实身份',async()=>{
    vi.spyOn(resourceApi,'list').mockResolvedValue({total:2,page:1,pageSize:50,items:[row('phones',11,'13800138000',{certifiedName:'认证甲',plan:'甲套餐'}),row('phones',12,'13800138000',{certifiedName:'认证乙',plan:'乙套餐'})]});
    const changed=vi.fn();render(<RefSelect field={{key:'phoneId',label:'关联手机号',type:'ref',ref:'phones',group:'关联'} as FieldDef} value={11} onChange={changed}/>);
    const second=await screen.findByRole('option',{name:'13800138000 · 认证乙 · 乙套餐 · 登记 #12'});
    expect(screen.getByRole('option',{name:'13800138000 · 认证甲 · 甲套餐 · 登记 #11'})).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'),{target:{value:(second as HTMLOptionElement).value}});expect(changed).toHaveBeenCalledWith(12);
  });
  it('同户名银行登记显示银行/保管人和独立编号，不将选择器标签覆盖成业务户名',async()=>{
    vi.spyOn(resourceApi,'list').mockResolvedValue({total:2,page:1,pageSize:50,items:[row('bank-accounts',21,'同户名',{bank:'银行甲'},{keeperUserId:'保管甲'}),row('bank-accounts',22,'同户名',{bank:'银行甲'},{keeperUserId:'保管乙'})]});
    const field=getResourceDef('bank-store-links')!.fields.find(f=>f.key==='bankAccountId')!;
    render(<RefSelect field={field} value={22} onChange={()=>{}}/>);
    expect(await screen.findByRole('option',{name:'同户名 · 银行甲 · 保管乙 · 登记 #22'})).toBeTruthy();
    expect(screen.getByRole('option',{name:'同户名 · 银行甲 · 保管甲 · 登记 #21'})).toBeTruthy();
  });
});
