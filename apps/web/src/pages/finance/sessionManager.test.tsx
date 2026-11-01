import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createChecker } from '@kudesi/shared';
import { MaintenancePage } from './MaintenancePage';
import { StoreWithdrawalPage } from './StoreWithdrawalPage';
import { ShopCredentials } from './ShopCredentials';
import { ShopStatusCells } from './ShopStatusCells';
import type { SessionClient,ShopRow } from './sessionApi';

const apiMock=vi.hoisted(()=>vi.fn());
let admin=true;
vi.mock('../../api/client',()=>({api:apiMock,ApiError:class extends Error{},tokenStore:{get:()=>null}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({can:createChecker({isCompanyAdmin:admin,allow:['resource.company-store-maintenance.view'],deny:[]})})}));
const shop:ShopRow={id:1,storeId:11,storeName:'合成甲店',platform:'pdd',platformStoreId:'DEMO-101',deviceId:2,deviceName:'DEMO-PC',deviceStatus:'offline',loginAccount:'synthetic-old',hasPassword:true,autoLogin:false,loginState:'none',lastVerifiedAt:null,activeRequest:null,storeStatus:'normal'};
const device={id:2,name:'DEMO-PC',remark:'01-维护',deviceNo:'DEMO-DEVICE',os:'Windows',agentVersion:'1.1.1',status:'active',online:false,lastSeenAt:null,shopCount:1};
beforeEach(()=>{
  admin=true;apiMock.mockReset();
  apiMock.mockImplementation(async(path:string,init?:{body?:unknown})=>{
    if(path.includes('/remote/devices'))return {canManage:admin,canRemote:admin,devices:[],limits:{minMinutes:5,hardCapMinutes:60},globalDisabled:false,iceConfigured:false};
    if(path.includes('/remote/shops'))return {shops:[],canRemote:admin,globalDisabled:false};
    if(path.endsWith('/devices'))return [device];
    if(path.endsWith('/agent-releases'))return [];
    if(path.includes('/overview'))return {canManage:admin,total:1,page:1,pageSize:50,pageCount:1,shops:[shop]};
    if(path.endsWith('/abnormal-reasons'))return [{id:8,reason:'合成待核验'}];
    if(path.endsWith('/audit'))return [];
    if(path.endsWith('/history'))return [];
    if(path.endsWith('/bind-codes'))return {code:'DEMOABCD',expiresAt:'2026-10-31T12:00:00+08:00'};
    if(init?.body)return {ok:true};
    return [];
  });
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});
const root=(component:React.ReactNode)=>render(<MemoryRouter>{component}</MemoryRouter>);

describe('维护/提现完整页签与权限',()=>{
  it('维护的授权电脑、绑定、备注、日志全部使用维护接口',async()=>{
    vi.spyOn(window,'prompt').mockReturnValue('演示维护电脑');
    root(<MaintenancePage/>);
    expect(await screen.findByRole('columnheader',{name:'主账号'})).toBeTruthy();
    expect(screen.getByRole('columnheader',{name:'异常原因'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'授权电脑'}));
    expect(await screen.findByText('01-维护')).toBeTruthy();
    expect((screen.getByRole('button',{name:'下载 Windows 助手安装程序'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'生成绑定码'}));
    expect(await screen.findByText('DEMOABCD')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'修改备注'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/store-maintenance/devices/2/remark',{method:'POST',body:{remark:'演示维护电脑'}}));
    fireEvent.click(screen.getByRole('button',{name:'操作日志'}));
    expect(await screen.findByText('暂无操作日志')).toBeTruthy();
    expect(apiMock.mock.calls.some(([p])=>String(p).startsWith('/session/'))).toBe(false);
  });
  it('提现使用运营账号标签，保留提现记录入口',async()=>{
    root(<StoreWithdrawalPage/>);
    expect(await screen.findByRole('columnheader',{name:'提现运营账号'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'提现记录'})).toBeTruthy();
    expect(screen.queryByRole('columnheader',{name:'店铺状态'})).toBeNull();
  });
  it('只读用户看不到写入操作，不能编辑密码或绑定电脑',async()=>{
    admin=false;root(<MaintenancePage/>);
    const account=await screen.findByRole('textbox',{name:'合成甲店主账号'});
    expect((account as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button',{name:'添加店铺'})).toBeNull();
    expect(screen.queryByRole('button',{name:'移除'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'授权电脑'}));
    await screen.findByText('01-维护');
    expect(screen.queryByRole('button',{name:'生成绑定码'})).toBeNull();
    expect(screen.queryByRole('button',{name:'修改备注'})).toBeNull();
  });
});

describe('行内保存与轮询的竞争',()=>{
  const renderCredentials=(client:SessionClient)=>render(<table><tbody><tr><ShopCredentials client={client} shop={shop} maintenance canManage onChanged={()=>undefined} onError={()=>undefined}/></tr></tbody></table>);
  it('从账号移到密码继续输入时，不会自动保存尚未输完的密码',async()=>{
    vi.useFakeTimers();
    const update=vi.fn().mockResolvedValue({ok:true});
    renderCredentials({updateShop:update} as unknown as SessionClient);
    const account=screen.getByLabelText('合成甲店主账号'), password=screen.getByLabelText('合成甲店主账号密码');
    fireEvent.change(account,{target:{value:'synthetic-new'}});fireEvent.blur(account);fireEvent.focus(password);
    fireEvent.change(password,{target:{value:'incomplete'}});
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(password,{target:{value:'Synthetic-Complete-Secret'}});fireEvent.blur(password);
    await act(async()=>{await vi.advanceTimersByTimeAsync(800);});
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(1,{loginAccount:'synthetic-new',loginPassword:'Synthetic-Complete-Secret'});
  });
  it('账号、密码一起保存；留空密码不覆盖旧密码',async()=>{
    const update=vi.fn().mockResolvedValue({ok:true}),client={updateShop:update} as unknown as SessionClient;
    renderCredentials(client);
    fireEvent.change(screen.getByLabelText('合成甲店主账号'),{target:{value:'synthetic-new'}});
    fireEvent.change(screen.getByLabelText('合成甲店主账号密码'),{target:{value:'Synthetic-Local-Secret'}});
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(update).toHaveBeenCalledWith(1,{loginAccount:'synthetic-new',loginPassword:'Synthetic-Local-Secret'}));
    await screen.findByRole('button',{name:'已保存'});
    fireEvent.change(screen.getByLabelText('合成甲店主账号'),{target:{value:'synthetic-next'}});
    fireEvent.keyDown(screen.getByLabelText('合成甲店主账号'),{key:'Enter'});
    await waitFor(()=>expect(update).toHaveBeenLastCalledWith(1,{loginAccount:'synthetic-next'}));
  });
  it('保存中的后续输入不会被旧响应清掉，保存按钮恢复可用',async()=>{
    let finish!:()=>void;
    const update=vi.fn().mockImplementationOnce(()=>new Promise<void>(r=>{finish=r;})).mockResolvedValue({ok:true});
    renderCredentials({updateShop:update} as unknown as SessionClient);
    const input=screen.getByLabelText('合成甲店主账号');
    fireEvent.change(input,{target:{value:'first'}});fireEvent.click(screen.getByRole('button',{name:'保存'}));
    fireEvent.change(input,{target:{value:'newer'}});finish();
    await waitFor(()=>expect((screen.getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled).toBe(false));
    expect((input as HTMLInputElement).value).toBe('newer');
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(update).toHaveBeenLastCalledWith(1,{loginAccount:'newer'}));
  });
  it('修改为异常时先选原因，再一次保存；失败恢复原状态',async()=>{
    const update=vi.fn().mockRejectedValue(new Error('保存失败'));
    render(<table><tbody><tr><ShopStatusCells client={{setStoreStatus:update} as unknown as SessionClient} shop={shop} reasons={[{id:8,reason:'合成待核验'}]} canManage onChanged={()=>undefined} onError={()=>undefined}/></tr></tbody></table>);
    fireEvent.change(screen.getByLabelText('合成甲店店铺状态'),{target:{value:'abnormal'}});
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('合成甲店异常原因'),{target:{value:'8'}});
    await waitFor(()=>expect(update).toHaveBeenCalledWith(1,{status:'abnormal',abnormalReasonId:8}));
    await waitFor(()=>expect((screen.getByLabelText('合成甲店店铺状态') as HTMLSelectElement).value).toBe('normal'));
  });
});
