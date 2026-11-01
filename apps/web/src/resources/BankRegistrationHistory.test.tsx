import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { resourceApi,type ResourceDto } from './api';

const auth={user:{permissions:{isCompanyAdmin:true,allow:[],deny:[]}}};
vi.mock('../auth/AuthContext',()=>({useAuth:()=>auth}));
vi.mock('./RecordForm',()=>({RecordForm:()=>null,ReasonDialog:()=>null,loadRefOptions:async()=>[],clearRefCache:()=>undefined}));
vi.mock('./api',async original=>{const mod=await original<typeof import('./api')>();return {...mod,resourceApi:{...mod.resourceApi,list:vi.fn()}};});
import { ChildPanel } from './RecordDetail';

const row=(type:string,data:Record<string,unknown>):ResourceDto=>({id:2,type,title:'原同号登记',status:type==='bank-account-history'?'recorded':'normal',statusReason:null,data,secretConfigured:{},refLabels:{keeperUserId:'原第二保管人'},files:{},archived:null,createdAt:'2026-11-01',updatedAt:'2026-11-01'});
beforeEach(()=>{vi.clearAllMocks();});afterEach(cleanup);
describe('账户下的原登记查看',()=>{
  it('管理员只能展开原值，显示原精确余额0与原时间，不显示内部证据或编辑按钮',async()=>{
    vi.mocked(resourceApi.list).mockResolvedValue({items:[row('bank-account-history',{sourceId:'42',bankAccountId:1,kind:'store_public',accountName:'原户名',bank:'原银行',accountNo:'6222000011112222',keeperUserId:20,reconcileCycle:'quarterly',originalBalance:0,sourceCreatedAt:'2026-08-01 10:00:00',note:'原对账说明',_legacySourceHash:'internal-source-proof'})],total:1,page:1,pageSize:100});
    render(<MemoryRouter><ChildPanel parentDef={getResourceDef('bank-accounts')!} parent={{...row('bank-accounts',{}),id:1}} childType="bank-account-history" field="bankAccountId"/></MemoryRouter>);
    const summary=await screen.findByText('查看原登记');fireEvent.click(summary);
    expect(screen.getByText('原对账说明')).toBeTruthy();expect(screen.getByText('2026-08-01 10:00:00')).toBeTruthy();
    expect(screen.getByText('原登记余额').nextElementSibling?.textContent).toContain('0.00');
    expect(screen.queryByText('internal-source-proof')).toBeNull();expect(screen.queryByRole('button',{name:'编辑'})).toBeNull();expect(screen.queryByRole('button',{name:/新增|删除/})).toBeNull();
    expect(document.querySelector('input,textarea,select')).toBeNull();
  });
  it('普通可编辑子记录仍按原权限显示新增和编辑，不混入原登记专用查看',async()=>{
    vi.mocked(resourceApi.list).mockResolvedValue({items:[row('bank-store-links',{label:'店铺收款',bankAccountId:1})],total:1,page:1,pageSize:100});
    render(<MemoryRouter><ChildPanel parentDef={getResourceDef('bank-accounts')!} parent={{...row('bank-accounts',{}),id:1}} childType="bank-store-links" field="bankAccountId"/></MemoryRouter>);
    expect(await screen.findByRole('button',{name:'编辑'})).toBeTruthy();expect(screen.getByRole('button',{name:/新增/})).toBeTruthy();expect(screen.queryByText('查看原登记')).toBeNull();
  });
});
