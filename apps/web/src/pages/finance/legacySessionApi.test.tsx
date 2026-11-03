import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { fireEvent,render,screen,waitFor,cleanup } from '@testing-library/react';
import { api,ApiError } from '../../api/client';
import { makeSessionApi,type ShopRow } from './sessionApi';
import { InlineDevice } from './ShopInline';
import { makeRemoteApi } from './remote/remoteApi';
import { legacyRemoteTransport } from './remote/legacy/legacyTransport';
import { RemoteDeviceSettings } from './remote/RemotePanels';
import type { RemoteApi } from './remote/remoteApi';
import { SessionDevices } from './SessionDevices';

const fixture=vi.hoisted(()=>({identity:'employee-A',api:vi.fn()}));
vi.mock('../../api/client',()=>({api:fixture.api,ApiError:class extends Error{constructor(public status:number,message:string){super(message);}},tokenStore:{get:()=>fixture.identity}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({can:()=>true})}));
const request=vi.mocked(api);
const uuid='2ca45b83-4f67-427a-889e-d81293010306';
const oldShop={id:101,name:'合成店铺',platformCode:'pdd',storeCode:'OLD-101',loginStatus:'pending',assignedDeviceId:uuid,assignedDeviceName:'测试电脑',assignedDeviceStatus:'active',assignedDeviceOnline:true,assignedDeviceAgentVersion:'0.3.44',withdrawalLoginAccount:'withdraw-account',hasWithdrawalLoginPassword:true,autoLoginEnabled:true,request:{id:'6eb6463d-0272-49ac-a6c9-a013ac914b5b',status:'waiting_human',progress:70,currentStep:'waiting_login'}};
const context={engine:'legacy',canManage:true,canRemote:true,stores:[{id:101,resourceStoreId:901,loginAccount:'withdraw-account',hasPassword:true}],remoteStates:[{shopId:101,remoteEnabled:true,allowControl:true,maxMinutes:10,deviceOnline:true,live:null}]};
beforeEach(()=>{
  fixture.identity='employee-A';request.mockReset();
  request.mockImplementation(async(path:string)=>{
    if(path.endsWith('/engine'))return {engine:'legacy'} as never;
    if(path.includes('/oa-context'))return context as never;
    if(path.includes('/overview'))return {shops:[oldShop],total:1,page:1,pageSize:50,pageCount:1} as never;
    if(path.includes('/shops/101'))return {shop:oldShop} as never;
    if(path.includes('/devices'))return {devices:[{id:uuid,name:'测试电脑',deviceCode:'DEVICE101',platform:'win32',arch:'x64',agentVersion:'0.3.44',status:'active',online:true,shopCount:1}]} as never;
    return {ok:true} as never;
  });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('新版页面契约连接原会话模块',()=>{
  it('两个店铺ID保持分离，等待人工验证与UUID任务均保留',async()=>{
    const data=await makeSessionApi('/session').overview();
    expect(data).toMatchObject({engine:'legacy',canManage:true,total:1});
    expect(data.shops[0]).toMatchObject({id:101,storeId:901,storeNo:'OLD-101',loginState:'none',deviceId:uuid,deviceStatus:'online',activeRequest:{id:oldShop.request.id},request:{percent:70,step:'waiting_login'}});
    expect(request).toHaveBeenCalledWith(expect.stringContaining('workspaceKey=finance_withdrawal'),expect.anything());
  });
  it('提现登记按新版资料ID精确取得旧店铺，不能受默认50条分页影响',async()=>{
    const data=await makeSessionApi('/session').overview({storeId:901});
    expect(data.shops[0]).toMatchObject({id:101,storeId:901});
    expect(request).toHaveBeenCalledWith('/session-manager/shops/101?workspaceKey=finance_withdrawal',{method:'GET'});
    expect(request.mock.calls.some(([path])=>path.includes('/overview'))).toBe(false);
  });
  it('资料映射缺失停止结果，不把旧ID当新版资料ID',async()=>{
    request.mockImplementation(async(path:string)=>path.endsWith('/engine')?{engine:'legacy'} as never:path.includes('oa-context')?{...context,stores:[]} as never:{shops:[oldShop]} as never);
    await expect(makeSessionApi('/session').overview()).rejects.toThrow('映射缺失');
  });
  it('只清密码保留当前账号；空密码按旧接口语义提交；不同工作区不串用',async()=>{
    const client=makeSessionApi('/store-maintenance');
    await client.updateShop(101,{clearPassword:true});
    expect(request).toHaveBeenCalledWith('/session-manager/managed-shops/101/login-credentials?workspaceKey=company_store_maintenance',{method:'PATCH',body:{account:'withdraw-account',clearPassword:true}});
    await client.updateShop(101,{loginAccount:'maintenance',loginPassword:''});
    expect(request).toHaveBeenLastCalledWith('/session-manager/managed-shops/101/login-credentials?workspaceKey=company_store_maintenance',{method:'PATCH',body:{account:'maintenance',password:''}});
  });
  it('拒绝无法原子完成的混合设置，不产生半次保存',async()=>{
    await expect(makeSessionApi('/session').updateShop(101,{deviceId:uuid,loginAccount:'account'})).rejects.toThrow('分别保存');
    expect(request.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(false);
  });
  it('界面选择UUID电脑时不Number转换，发送预期电脑防止覆盖后来的分配',async()=>{
    const client=makeSessionApi('/session');
    vi.spyOn(window,'confirm').mockReturnValue(true);
    render(<InlineDevice client={client} shop={{id:101,storeName:'合成店铺',deviceId:null} as ShopRow} devices={[{id:uuid,name:'测试电脑',deviceNo:'X',os:null,agentVersion:null,status:'active',online:true,lastSeenAt:null,shopCount:0}]} onChanged={()=>undefined} onError={()=>undefined}/>);
    fireEvent.change(screen.getByRole('combobox'),{target:{value:uuid}});
    await waitFor(()=>expect(request).toHaveBeenCalledWith('/session-manager/managed-shops/101/assigned-device?workspaceKey=finance_withdrawal',{method:'PATCH',body:{deviceId:uuid,expectedDeviceId:null}}));
    expect(request.mock.calls.some(([path])=>path.includes('/shops/101'))).toBe(false);
  });
  it('页面原值为UUID时原样作为CAS条件，未提供原值拒绝发出分配',async()=>{
    const client=makeSessionApi('/session');
    const target='3ce0da39-ecb6-46d3-9136-7690b06bce7e';
    await client.updateShop(101,{deviceId:target,expectedDeviceId:uuid});
    expect(request).toHaveBeenLastCalledWith('/session-manager/managed-shops/101/assigned-device?workspaceKey=finance_withdrawal',{method:'PATCH',body:{deviceId:target,expectedDeviceId:uuid}});
    request.mockClear();
    await expect(client.updateShop(101,{deviceId:target})).rejects.toThrow('页面原负责电脑');
    expect(request).not.toHaveBeenCalled();
  });
  it('页面看到未分配但别人已分配C时保留409，不刷新原值后覆盖C',async()=>{
    const client=makeSessionApi('/session'),changed=vi.fn(),error=vi.fn();
    const original=request.getMockImplementation()!;
    let savedDevice:unknown=uuid;
    request.mockImplementation(async(path,init)=>{
      if(path.includes('/assigned-device')){
        const body=init?.body as {expectedDeviceId:unknown;deviceId:unknown};
        if(body.expectedDeviceId!==savedDevice)throw new ApiError(409,'负责电脑已被其他人修改，请刷新');
        savedDevice=body.deviceId;return {ok:true} as never;
      }
      return original(path,init);
    });
    const target='3ce0da39-ecb6-46d3-9136-7690b06bce7e';
    vi.spyOn(window,'confirm').mockReturnValue(true);
    render(<InlineDevice client={client} shop={{id:101,storeName:'合成店铺',deviceId:null} as ShopRow} devices={[{id:target,name:'目标电脑',deviceNo:'X',os:null,agentVersion:null,status:'active',online:true,lastSeenAt:null,shopCount:0}]} onChanged={changed} onError={error}/>);
    fireEvent.change(screen.getByRole('combobox'),{target:{value:target}});
    await waitFor(()=>expect(error).toHaveBeenCalledWith('负责电脑已被其他人修改，请刷新'));
    expect(changed).not.toHaveBeenCalled();expect(savedDevice).toBe(uuid);
    expect(request.mock.calls.some(([path])=>path.includes('/shops/101'))).toBe(false);
  });
  it('取消任务及截图使用旧协议，凭证文件仍使用新版受控接口',async()=>{
    const client=makeSessionApi('/session');
    await client.cancel(oldShop.request.id);await client.capture(101);await client.docVouchers(19);
    expect(request).toHaveBeenCalledWith(`/session-manager/open-requests/${oldShop.request.id}?workspaceKey=finance_withdrawal`,{method:'DELETE'});
    expect(request).toHaveBeenCalledWith('/session-manager/oa-capture/101?workspaceKey=finance_withdrawal',{method:'POST',body:{}});
    expect(request).toHaveBeenLastCalledWith('/session/docs/19/vouchers');
  });
  it('旧引擎的远程权限与状态来自当前工作区，不调用新版信令接口',async()=>{
    const client=makeRemoteApi('/store-maintenance/remote');
    expect((await client.shops()).shops).toEqual(context.remoteStates);
    await expect(client.setDevice(uuid,{enabled:true,allowControl:false,maxMinutes:10})).rejects.toThrow('仅支持');
    await client.setDevice(uuid,{enabled:true,allowControl:true,maxMinutes:10});
    expect(request).toHaveBeenLastCalledWith(`/session-manager/oa-remote/devices/${uuid}?workspaceKey=company_store_maintenance`,{method:'POST',body:{enabled:true,allowControl:true,maxMinutes:10}});
    await expect(client.request(101,{mode:'view',reason:'test'})).rejects.toThrow('旧版远程窗口');
  });
  it('旧助手设置不展示无法保证的只观看、切换模式或改时长操作',async()=>{
    const remote={engine:vi.fn().mockResolvedValue('legacy'),devices:vi.fn().mockResolvedValue({globalDisabled:false,iceConfigured:true,canManage:true,canRemote:true,limits:{minMinutes:10,hardCapMinutes:10},devices:[{deviceId:uuid,enabled:true,allowControl:true,maxMinutes:10}]})} as unknown as RemoteApi;
    render(<RemoteDeviceSettings client={remote} deviceNames={{[uuid]:'测试电脑'}}/>);
    await screen.findByText('测试电脑');
    await waitFor(()=>expect(screen.queryByRole('button',{name:'改为只观看'})).toBeNull());
    expect(screen.queryByRole('button',{name:'改时长'})).toBeNull();
    expect(screen.getByText(/仅支持可操作/)).toBeTruthy();
  });
  it('旧引擎透传服务端全局停止状态，不伪报为启用',async()=>{
    const original=request.getMockImplementation()!;
    request.mockImplementation(async(path,init)=>path.includes('/oa-context')?{...context,globalDisabled:true,remoteStates:[]} as never:original(path,init));
    expect(await makeRemoteApi('/session/remote').shops()).toMatchObject({globalDisabled:true,shops:[]});
  });
  it('只有安装EXE而缺自动更新包时可下载安装，不能点远程升级',async()=>{
    const original=request.getMockImplementation()!;
    request.mockImplementation(async(path,init)=>{
      if(path.includes('/releases/windows/latest'))return {version:'0.3.44',sha256:'a'.repeat(64),size:512,updateAvailable:false} as never;
      if(path.startsWith('/session-manager/devices?'))return {devices:[{id:uuid,name:'旧版测试电脑',deviceCode:'DEVICE101',platform:'win32',arch:'x64',agentVersion:'0.3.0',status:'active',online:true,shopCount:1}]} as never;
      return original(path,init);
    });
    const client=makeSessionApi('/session');
    expect((await client.releases())[0].updateAvailable).toBe(false);
    const remote={engine:vi.fn().mockResolvedValue('legacy'),devices:vi.fn().mockResolvedValue({globalDisabled:false,iceConfigured:true,canManage:true,canRemote:true,limits:{minMinutes:10,hardCapMinutes:10},devices:[]})} as unknown as RemoteApi;
    render(<SessionDevices client={client} remoteClient={remote} manage managePermission="finance.session.manage" onChanged={()=>undefined}/>);
    await screen.findByText('安装包可下载，自动更新包尚未发布');
    expect((screen.getByRole('button',{name:'更新全部电脑'}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button',{name:/^升级$/}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button',{name:'下载 Windows 助手安装程序'}) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:/^升级$/}));
    expect(request.mock.calls.some(([path])=>path.includes(`/devices/${uuid}/update`))).toBe(false);
    expect(screen.getByText('安装包 SHA-256')).toBeTruthy();
  });
});

describe('引擎选择与身份边界',()=>{
  it('native路径保持原有请求，旧服务只有明确404才回到native',async()=>{
    request.mockRejectedValueOnce(new ApiError(404,'missing')).mockResolvedValue({ok:true} as never);
    await makeSessionApi('/session').remarkDevice(2,'备注');
    expect(request).toHaveBeenLastCalledWith('/session/devices/2/remark',{method:'POST',body:{remark:'备注'}});
    request.mockReset();request.mockRejectedValue(new ApiError(403,'forbidden'));
    await expect(makeSessionApi('/session').removeShop(101)).rejects.toThrow('forbidden');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('native分配不发送仅供legacy的CAS字段给原DTO',async()=>{
    request.mockImplementation(async(path)=>path.endsWith('/engine')?{engine:'native'} as never:{ok:true} as never);
    await makeSessionApi('/session').updateShop(7,{deviceId:3,expectedDeviceId:2});
    expect(request).toHaveBeenLastCalledWith('/session/shops/7',{method:'POST',body:{deviceId:3}});
  });
  it('切换用户会重新查询引擎；等待期间切换身份不能继续写操作',async()=>{
    const client=makeSessionApi('/session');
    await client.devices();fixture.identity='employee-B';await client.devices();
    expect(request.mock.calls.filter(([path])=>path==='/session/engine')).toHaveLength(2);
    let finish!:(value:never)=>void;request.mockReset();request.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=makeSessionApi('/session').removeShop(101);fixture.identity='employee-C';finish({engine:'legacy'} as never);
    await expect(pending).rejects.toThrow('登录身份已变化');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('两段凭据保存中间切换身份，不把上一用户查到的账号提交给下一用户',async()=>{
    const original=request.getMockImplementation()!;
    request.mockImplementation(async(path,init)=>{
      const result=await original(path,init);
      if(path.includes('/oa-context'))fixture.identity='employee-B';
      return result;
    });
    await expect(makeSessionApi('/session').updateShop(101,{clearPassword:true})).rejects.toThrow('登录身份已变化');
    expect(request.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(false);
  });
  it('原远程组件传输保留AbortSignal，只携带新版令牌与指定工作区',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true}),{status:200}));vi.stubGlobal('fetch',fetcher);
    const controller=new AbortController();
    await legacyRemoteTransport('company_store_maintenance').requestJson('/api/session-manager/remote-sessions',{method:'POST',body:'{}',signal:controller.signal});
    const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('/api/session-manager/remote-sessions?workspaceKey=company_store_maintenance');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer employee-A');expect(init.signal).toBe(controller.signal);
    await expect(legacyRemoteTransport('company_store_maintenance').requestJson('https://example.com/api/session-manager/remote-sessions')).rejects.toThrow('目标无效');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('远程窗口打开店铺标记remote用途，普通登录仍不携带该标记',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({id:'synthetic-opening'}),{status:201}));vi.stubGlobal('fetch',fetcher);
    await legacyRemoteTransport('finance_withdrawal').requestJson('/api/session-manager/open-requests',{method:'POST',body:JSON.stringify({storeId:101,deviceId:uuid})});
    const [,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({storeId:101,deviceId:uuid,purpose:'remote'});
    await makeSessionApi('/session').open(101);
    expect(request).toHaveBeenLastCalledWith('/session-manager/open-requests?workspaceKey=finance_withdrawal',{method:'POST',body:{storeId:101,deviceId:uuid}});
  });
});
