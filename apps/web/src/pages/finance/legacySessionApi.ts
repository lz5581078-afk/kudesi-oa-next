import { api, ApiError, tokenStore } from '../../api/client';
import type { AgentRelease, AuditRow, CaptureStatus, DeviceRow, HistoryRow, ShopList, ShopQuery, ShopRow, SessionNativeClient, UpdateSessionShop } from './sessionApi';
import type { RemoteShopState } from './remote/remoteApi';
import { sessionWorkspaceFor, type SessionId, type SessionWorkspace } from './sessionEngine';

export interface LegacyContext {
  engine: 'legacy'; canManage: boolean; canRemote: boolean; globalDisabled?: boolean;
  stores: Array<{ id: number; resourceStoreId: number; abnormalReasonId?: number | null; loginAccount?: string; hasPassword?: boolean; autoLogin?: boolean }>;
  remoteStates?: RemoteShopState[];
}
const parameters = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key,value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key,String(value));
  return params;
};
export const legacySessionPath = (workspace: SessionWorkspace, path: string) => `/session-manager${path}${path.includes('?') ? '&' : '?'}workspaceKey=${workspace}`;

export function makeLegacySessionApi(base: string, native: SessionNativeClient, identity=tokenStore.get()) {
  const workspace = sessionWorkspaceFor(base);
  const checkIdentity=()=>{if(tokenStore.get()!==identity)throw new Error('登录身份已变化，请刷新后重试');};
  const call = async <T,>(path: string, method = 'GET', body?: unknown) => {
    checkIdentity();
    const result=await api<T>(legacySessionPath(workspace,path),{method,...(body === undefined ? {} : {body})});
    checkIdentity();return result;
  };
  const context = () => call<LegacyContext>('/oa-context');
  const detail = (id: number) => call<{shop:Record<string,any>}>(`/shops/${id}`);
  return {
    ...native,
    overview: async (query: ShopQuery = {}): Promise<ShopList> => {
      const filter = parameters({ keyword:query.keyword,loginStatus:query.loginState === 'none' ? 'pending' : query.loginState,storeStatus:query.storeStatus,
        assignedDeviceId:query.deviceId === 'none' ? 'unassigned' : query.deviceId, sort:query.sort,page:query.page,pageSize:query.pageSize });
      const ctx=await context();
      const selected=query.storeId?ctx.stores.find(row=>row.resourceStoreId===query.storeId):undefined;
      const result=query.storeId
        ? {shops:selected?[(await detail(selected.id)).shop]:[],total:selected?1:0,page:1,pageSize:query.pageSize??50,pageCount:1}
        : await call<any>(`/overview?${filter}`);
      const identities = new Map(ctx.stores.map(row=>[row.id,row]));
      const shops: ShopRow[] = result.shops.map((row: any) => {
        const identity = identities.get(Number(row.id));
        if (!identity?.resourceStoreId) throw new Error('店铺资料映射缺失，已停止显示以避免误用店铺');
        const request = row.request;
        const active = request && !['completed','failed','cancelled','expired'].includes(request.status);
        return {
          id:Number(row.id),storeId:identity.resourceStoreId,storeName:row.name,platform:row.platformCode ?? row.platform,
          platformLabel:row.platformName,platformStoreId:row.platformStoreId,storeNo:row.storeCode,operatorName:row.operatorName,
          deviceId:row.assignedDeviceId || null,deviceName:row.assignedDeviceName || '',deviceRemark:row.assignedDeviceRemark || '',
          deviceStatus:!row.assignedDeviceId?'none':row.assignedDeviceStatus !== 'active'?'revoked':row.assignedDeviceOnline?'online':'offline',
          loginAccount:row.withdrawalLoginAccount ?? identity.loginAccount ?? '',hasPassword:!!(row.hasWithdrawalLoginPassword ?? identity.hasPassword),autoLogin:!!(row.autoLoginEnabled ?? identity.autoLogin),
          loginState:row.loginStatus === 'pending'?'none':row.loginStatus,lastVerifiedAt:row.lastVerifiedAt,lastOpenedAt:row.lastOpenedAt,
          storeStatus:row.storeStatus,abnormalReason:row.abnormalReason,abnormalReasonId:identity.abnormalReasonId,
          activeRequest:active?{id:request.id,kind:'now',status:request.status}:null,
          request:request?{id:request.id,kind:'now',status:request.status,percent:request.progress,step:request.currentStep,errorText:request.errorMessage || null,at:request.updatedAt ?? ''}:null,
          legacy:{...row,workspace},
        };
      });
      return {engine:'legacy',canManage:ctx.canManage,total:result.total,page:result.page,pageSize:result.pageSize,pageCount:result.pageCount,shops};
    },
    available: async (keyword?: string) => (await call<{shops:any[]}>(`/shop-candidates?${parameters({keyword})}`)).shops.map(row=>({id:Number(row.id),name:row.name,platform:row.platformCode ?? row.platform,storeNo:row.storeCode,platformStoreId:row.platformStoreId,operatorName:row.operatorName})),
    addShops: (storeIds:number[],deviceId:SessionId) => call('/managed-shops','POST',{storeIds,assignedDeviceId:deviceId}),
    updateShop: async (id:number,body:UpdateSessionShop) => {
      // Current forms submit credentials, assignment and the switch independently.
      // Refuse mixed groups rather than partially save a multi-action request.
      const credentials = body.loginAccount !== undefined || body.loginPassword !== undefined || body.clearPassword !== undefined;
      if (Number(credentials)+Number(body.deviceId !== undefined)+Number(body.autoLogin !== undefined)>1) throw new Error('请分别保存账号密码、负责电脑或自动登录设置');
      if (body.deviceId !== undefined) {
        if(body.expectedDeviceId===undefined)throw new Error('缺少页面原负责电脑，请刷新后重试');
        return call(`/managed-shops/${id}/assigned-device`,'PATCH',{deviceId:body.deviceId,expectedDeviceId:body.expectedDeviceId});
      }
      if (body.autoLogin !== undefined) return call(`/managed-shops/${id}/auto-login`,'PATCH',{enabled:body.autoLogin});
      const storedAccount=body.loginAccount===undefined?(await context()).stores.find(row=>row.id===id)?.loginAccount:undefined;
      if(body.loginAccount===undefined&&storedAccount===undefined)throw new Error('未取得当前账号，已停止保存以避免清空凭据');
      const account = body.loginAccount ?? storedAccount!;
      return call(`/managed-shops/${id}/login-credentials`,'PATCH',{account,...(body.loginPassword === undefined?{}:{password:body.loginPassword}),...(body.clearPassword === undefined?{}:{clearPassword:body.clearPassword})});
    },
    removeShop:(id:number)=>call(`/managed-shops/${id}`,'DELETE'),
    reveal:async(id:number)=>{const result=await call<{credentials:{account:string;password:string}}>(`/shops/${id}/credentials/reveal`,'POST',{purpose:'view'});return result.credentials;},
    open:async(id:number)=>{
      const current=(await detail(id)).shop;
      const result=await call<{id:string}>('/open-requests','POST',{storeId:id,deviceId:current.assignedDeviceId});
      return {id:result.id,kind:current.loginStatus==='valid'?'now':'first'};
    },
    cancel:(id:SessionId)=>call(`/open-requests/${id}`,'DELETE'),
    history:async(id:number):Promise<HistoryRow[]> => ((await detail(id)).shop.openHistory ?? []).map((row:any)=>({id:row.id,kind:row.actionType==='first_login'?'first':'now',status:row.status==='completed'?'succeeded':row.status,errorCode:row.errorCode || null,errorText:row.errorMessage || null,createdAt:row.completedAt,finishedAt:row.completedAt,deviceName:row.deviceName,requestedByName:row.requestedByName ?? ''})),
    devices:async():Promise<DeviceRow[]> => {
      const rows=await call<{devices:any[]}>('/devices');
      return rows.devices.map(row=>({id:row.id,name:row.name,remark:row.remark,deviceNo:row.deviceCode,os:[row.platform,row.arch].filter(Boolean).join(' / '),agentVersion:row.agentVersion,status:row.status,online:row.online,lastSeenAt:row.lastSeenAt,shopCount:row.shopCount,
        update:row.updateJob?{target:row.updateJob.targetVersion,status:row.updateJob.status,requestedAt:row.updateJob.requestedAt,error:row.updateJob.errorMessage || null}:null}));
    },
    bindCode:()=>call<{code:string;expiresAt:string}>('/pairings','POST',{}),
    rename:(id:SessionId,name:string)=>call(`/oa-devices/${id}/name`,'PATCH',{name}),
    remarkDevice:(id:SessionId,remark:string)=>call(`/devices/${id}/remark`,'PATCH',{remark}),
    setStatus:(id:SessionId,status:'active'|'revoked')=>call(`/devices/${id}/${status==='active'?'restore':'revoke'}`,'PATCH',{}),
    updateDevice:async(id:SessionId)=>{const value=await call<any>(`/devices/${id}/update`,'POST',{});return {queued:!!value.queued,alreadyCurrent:value.alreadyCurrent,target:value.targetVersion ?? value.job?.targetVersion ?? ''};},
    updateAllDevices:()=>call<{queued:number;target:string}>('/devices/update-all','POST',{}),
    deleteDevice:(id:SessionId)=>call(`/devices/${id}`,'DELETE'),
    capture:(id:number)=>call<{id:SessionId;kind:string}>(`/oa-capture/${id}`,'POST',{}),
    requestStatus:(id:SessionId)=>call<CaptureStatus>(`/oa-requests/${id}`),
    abnormalReasons:async()=> (await call<{reasons:Array<{id:number;reason:string}>}>('/store-abnormal-reasons')).reasons,
    setStoreStatus:(id:number,body:{status:string;abnormalReasonId?:number;reason?:string})=>call(`/shops/${id}/archive-status`,'PATCH',body),
    audit:async():Promise<AuditRow[]> => (await call<{logs:any[]}>('/audit-logs')).logs.map(row=>({id:row.id,eventType:row.event_type,summary:row.summary,createdAt:row.created_at,actorName:row.actor_name ?? null,deviceName:row.device_name,storeName:row.store_name})),
    releases:async():Promise<AgentRelease[]>=>{
      const release=await call<{version:string;sha256:string;size:number;updateAvailable?:boolean}>('/releases/windows/latest');
      return [{id:0,version:release.version,sha256:release.sha256,size:release.size,notes:null,createdAt:'',withdrawnAt:null,createdByName:null,isLatest:true,updateAvailable:release.updateAvailable}];
    },
    publishRelease:async(_file:File,_options:{sha256?:string;notes?:string}):Promise<{version:string;sha256:string;size:number}>=>{throw new Error('此助手版本由安装资产发布，不接受新版升级包');},
    withdrawRelease:async(_id:number)=>{throw new Error('此助手安装资产不能从新版升级包面板撤回');},
    downloadInstaller:async()=>{
      const release=await call<{installer?:{sha256:string;fileName:string};sha256?:string;fileName?:string}>('/releases/windows/latest');
      const expected=release.installer?.sha256 ?? release.sha256;
      const filename=release.installer?.fileName ?? release.fileName;
      if(!expected||!filename||!/^[\w.-]+\.exe$/.test(filename))throw new Error('助手安装资产信息不完整');
      checkIdentity();
      const token=tokenStore.get();
      const response=await fetch(`/api${legacySessionPath(workspace,'/releases/windows/download')}`,{headers:token?{authorization:`Bearer ${token}`}:{}});
      if(!response.ok)throw new ApiError(response.status,'助手安装程序下载失败');
      const bytes=await response.arrayBuffer();
      checkIdentity();
      const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
      if(actual!==expected.toLowerCase())throw new Error('安装包完整性校验失败，请重新下载');
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
      const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),30_000);
      return filename;
    },
  };
}
