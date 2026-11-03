import { api, tokenStore } from '../../../api/client';
import type { RemoteInput, RemoteMode } from '@kudesi/shared';
import { makeSessionEngineResolver, sessionWorkspaceFor, type SessionId } from '../sessionEngine';
import { legacySessionPath, type LegacyContext } from '../legacySessionApi';

export interface IceServer { urls: string[]; username?: string; credential?: string }
export interface RemoteSession {
  id: SessionId; status: 'requested' | 'active' | 'ended'; mode: RemoteMode; reason: string; mine: boolean;
  storeName: string; deviceName: string; requestedByName: string;
  requestedAt: string; acceptedAt: string | null; expiresAt: string | null; endedAt: string | null;
  secondsLeft: number; endReason: string | null; endReasonLabel: string | null; endNote: string | null; canExtend: boolean; durationSeconds: number;
  iceServers?: IceServer[];
}
export interface RemoteSignal { id: number; kind: string; payload: Record<string, unknown> }
export interface RemoteShopState {
  shopId: number; remoteEnabled: boolean; allowControl: boolean; maxMinutes: number; deviceOnline: boolean;
  live: { id: SessionId; status: 'requested' | 'active'; mode: RemoteMode; mine: boolean; requestedByName: string } | null;
}
export interface RemoteDevicesInfo {
  globalDisabled: boolean; iceConfigured: boolean; canManage: boolean; canRemote: boolean; limits: { minMinutes: number; hardCapMinutes: number };
  devices: Array<{ deviceId: SessionId; enabled: boolean; allowControl: boolean; maxMinutes: number }>;
}
export interface RemoteHistoryRow {
  id: SessionId; storeName: string; deviceName: string; requestedByName: string; mode: RemoteMode; reason: string; status: string;
  endReason: string | null; endReasonLabel: string | null; endedByName: string; requestedAt: string; acceptedAt: string | null; endedAt: string | null;
  durationSeconds: number; inputCount: number; extendCount: number;
}

const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });

const makeNativeRemoteApi = (base: string) => ({
  shops: () => api<{ canRemote: boolean; globalDisabled: boolean; shops: RemoteShopState[] }>(`${base}/shops`),
  devices: () => api<RemoteDevicesInfo>(`${base}/devices`),
  setDevice: (id: SessionId, b: { enabled: boolean; allowControl?: boolean; maxMinutes?: number }) => post(`${base}/devices/${id}`, b),
  stopAll: () => post<{ ended: number; disabledDevices: number }>(`${base}/stop-all`),
  request: (shopId: number, b: { mode: RemoteMode; reason: string }) => post<{ id: SessionId; status: 'requested'; waitSeconds: number }>(`${base}/shops/${shopId}/request`, b),
  get: (id: SessionId) => api<RemoteSession>(`${base}/sessions/${id}`),
  poll: (id: SessionId, after: number) => api<RemoteSession & { signals: RemoteSignal[] }>(`${base}/sessions/${id}/poll?after=${after}`),
  signal: (id: SessionId, kind: string, payload: Record<string, unknown> = {}) => post(`${base}/sessions/${id}/signal`, { kind, payload }),
  extend: (id: SessionId) => post<RemoteSession>(`${base}/sessions/${id}/extend`),
  end: (id: SessionId) => post(`${base}/sessions/${id}/end`),
  history: () => api<RemoteHistoryRow[]>(`${base}/history`),
});
export function makeRemoteApi(base:string){
  const native=makeNativeRemoteApi(base),sessionBase=base.replace(/\/remote$/,'');
  const workspace=sessionWorkspaceFor(sessionBase),engine=makeSessionEngineResolver(sessionBase);
  const call=<T,>(path:string,body?:unknown)=>api<T>(legacySessionPath(workspace,path),body===undefined?{}:{method:'POST',body});
  const unsupported=async()=>{throw new Error('请通过当前店铺的旧版远程窗口操作');};
  const legacy:ReturnType<typeof makeNativeRemoteApi>={
    shops:async()=>{const ctx=await call<LegacyContext>('/oa-context');return {canRemote:ctx.canRemote,globalDisabled:!!ctx.globalDisabled,shops:ctx.remoteStates??[]};},
    devices:()=>call<RemoteDevicesInfo>('/oa-remote/devices'),
    setDevice:(id,body)=>{
      if(body.enabled&&(body.allowControl!==true||(body.maxMinutes!==undefined&&body.maxMinutes!==10)))return Promise.reject(new Error('此助手仅支持可操作远程协助，会话有效期固定10分钟并自动续期'));
      return call(`/oa-remote/devices/${id}`,body);
    },
    stopAll:()=>call<{ended:number;disabledDevices:number}>('/oa-remote/stop-all',{}),
    history:()=>call<RemoteHistoryRow[]>('/oa-remote/history'),
    request:unsupported,get:unsupported,poll:unsupported,signal:unsupported,extend:unsupported,end:unsupported,
  };
  const selected=Object.fromEntries(Object.keys(native).map(key=>[key,async(...args:unknown[])=>{
    const identity=tokenStore.get();
    const implementation=await engine()==='legacy'?legacy:native;
    if(tokenStore.get()!==identity)throw new Error('登录身份已变化，请重新打开远程协助');
    return (implementation[key as keyof typeof native] as (...values:unknown[])=>Promise<unknown>)(...args);
  }])) as ReturnType<typeof makeNativeRemoteApi>;
  return {...selected,engine};
}
export const remoteApi = makeRemoteApi('/session/remote');
export const maintenanceRemoteApi = makeRemoteApi('/store-maintenance/remote');
export type RemoteApi = typeof remoteApi;
export type { RemoteInput };
