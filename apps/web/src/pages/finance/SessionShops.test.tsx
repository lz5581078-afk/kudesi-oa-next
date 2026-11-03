import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Shops } from './SessionShops';
import type { SessionClient, ShopRow } from './sessionApi';

const fixture=vi.hoisted(()=>({canRemote:true,permissions:[] as string[],remoteShops:vi.fn(),legacy:vi.fn()}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({can:(permission:string)=>{fixture.permissions.push(permission);return permission.endsWith('.remote')?fixture.canRemote:false;}})}));
vi.mock('./remote/remoteApi',()=>({remoteApi:{shops:fixture.remoteShops},maintenanceRemoteApi:{shops:fixture.remoteShops}}));
vi.mock('./remote/legacy/LegacyRemoteAssistDialog',()=>({LegacyRemoteAssistDialog:(props:{shop:ShopRow;onClose:()=>void})=>{fixture.legacy(props.shop);return <div role="dialog" aria-label="旧版远程控制"><button onClick={props.onClose}>关闭远程</button></div>;}}));
vi.mock('./remote/RemoteAssistDialog',()=>({RemoteAssistDialog:()=> <div role="dialog" aria-label="原生远程控制"/>}));
const baseShop:ShopRow={id:101,storeId:901,storeName:'合成店铺',platform:'pdd',deviceId:'synthetic-device',deviceName:'合成电脑',deviceStatus:'online',loginAccount:'',hasPassword:false,autoLogin:false,loginState:'none',lastVerifiedAt:null,activeRequest:null};
function client(shop:ShopRow,canManage=true){return {overview:vi.fn().mockResolvedValue({shops:[shop],canManage,total:1,page:1,pageSize:50,pageCount:1}),devices:vi.fn().mockResolvedValue([{id:shop.deviceId,name:'合成电脑',status:'active',online:true}]),abnormalReasons:vi.fn().mockResolvedValue([]),open:vi.fn().mockResolvedValue({id:'request'})} as unknown as SessionClient;}
beforeEach(()=>{fixture.canRemote=true;fixture.permissions=[];fixture.remoteShops.mockReset().mockResolvedValue({shops:[]});fixture.legacy.mockReset();});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

describe('两个模块登录复用远程窗口',()=>{
  it.each([false,true])('旧核心登录直接显示远程窗口、不重复下发普通任务 maintenance=%s',async maintenance=>{
    const shop={...baseShop,legacy:{workspace:maintenance?'company_store_maintenance':'finance_withdrawal'}},api=client(shop);
    render(<Shops client={api} maintenance={maintenance}/>);
    fireEvent.click(await screen.findByRole('button',{name:'首次登录'}));
    expect(screen.getByRole('dialog',{name:'旧版远程控制'})).toBeTruthy();
    expect(api.open).not.toHaveBeenCalled();
    expect(fixture.legacy).toHaveBeenLastCalledWith(shop);
    expect(fixture.permissions).toContain(maintenance?'resource.company-store-maintenance.remote':'finance.session.remote');
    fireEvent.click(screen.getByRole('button',{name:'关闭远程'}));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.overview).toHaveBeenCalledTimes(2);
  });
  it('远程状态列表失败不再把旧远程弹窗隐藏',async()=>{
    fixture.remoteShops.mockRejectedValue(new Error('合成状态列表失败'));
    const api=client({...baseShop,legacy:{workspace:'finance_withdrawal'}});
    render(<Shops client={api}/>);
    fireEvent.click(await screen.findByRole('button',{name:'首次登录'}));
    expect(screen.getByRole('dialog',{name:'旧版远程控制'})).toBeTruthy();
    expect(api.open).not.toHaveBeenCalled();
  });
  it.each([false,true])('没有远程权限保留普通登录、不会升级权限 maintenance=%s',async maintenance=>{
    fixture.canRemote=false;const api=client({...baseShop,legacy:{workspace:maintenance?'company_store_maintenance':'finance_withdrawal'}});
    render(<Shops client={api} maintenance={maintenance}/>);
    fireEvent.click(await screen.findByRole('button',{name:'首次登录'}));
    await waitFor(()=>{expect(api.open).toHaveBeenCalledTimes(1);expect(api.open).toHaveBeenCalledWith(101);});
    expect(screen.queryByRole('dialog')).toBeNull();expect(fixture.remoteShops).not.toHaveBeenCalled();
  });
  it('原生核心登录继续下发原任务',async()=>{
    const api=client(baseShop);render(<Shops client={api}/>);
    fireEvent.click(await screen.findByRole('button',{name:'首次登录'}));
    await waitFor(()=>{expect(api.open).toHaveBeenCalledTimes(1);expect(api.open).toHaveBeenCalledWith(101);});expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('离线电脑不可打开远程或下发任务',async()=>{
    const api=client({...baseShop,deviceStatus:'offline',legacy:{workspace:'finance_withdrawal'}});render(<Shops client={api}/>);
    const button=await screen.findByRole('button',{name:'助手离线'});expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(button);
    expect(api.open).not.toHaveBeenCalled();expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('没有管理权限不会出现登录入口',async()=>{
    render(<Shops client={client({...baseShop,legacy:{workspace:'finance_withdrawal'}},false)}/>);
    await screen.findByText('合成店铺');expect(screen.queryByRole('button',{name:'首次登录'})).toBeNull();expect(screen.queryByRole('dialog')).toBeNull();
  });
});
