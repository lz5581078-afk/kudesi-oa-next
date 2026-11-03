import { api, ApiError, tokenStore } from '../../api/client';
import { makeSessionEngineResolver, type SessionEngine, type SessionId } from './sessionEngine';
import { makeLegacySessionApi } from './legacySessionApi';
export type { SessionId } from './sessionEngine';

export interface ShopRow {
  legacy?: Record<string, any>;
  requiresAgentUpgrade?: boolean; storeStatus?: string; abnormalReasonId?: number | null; abnormalReason?: string; deviceRemark?: string; id: number; storeId: number; storeName: string; platform: string; deviceId: SessionId | null; deviceName: string; deviceStatus: 'online' | 'offline' | 'revoked' | 'none';
  loginAccount: string; hasPassword: boolean; autoLogin: boolean; loginState: 'none' | 'synced' | 'valid' | 'expired' | 'error'; lastVerifiedAt: string | null; activeRequest: { id: SessionId; kind: string; status: string } | null;
  storeNo?: string; platformStoreId?: string; platformLabel?: string; operatorName?: string; lastOpenedAt?: string | null;
  request?: { id: SessionId; kind: string; status: string; percent: number; step: string; errorText: string | null; at: string } | null;
}
export interface DeviceRow {
  id: SessionId; name: string; remark?: string; deviceNo: string; os: string | null; agentVersion: string | null; status: 'active' | 'revoked'; online: boolean; lastSeenAt: string | null; shopCount: number;
  outdated?: boolean; latestVersion?: string | null; update?: { target: string | null; status: 'queued' | 'downloading' | 'verifying' | 'staged' | 'applying' | 'restarting' | 'succeeded' | 'failed' | 'rolled_back'; requestedAt: string | null; error?: string | null } | null;
}
export interface AgentRelease { id: number; version: string; sha256: string; size: number; notes: string | null; createdAt: string; withdrawnAt: string | null; createdByName: string | null; isLatest: boolean; updateAvailable?: boolean }
export interface ShopQuery { storeId?: number; keyword?: string; loginState?: string; storeStatus?: string; deviceId?: string; sort?: string; page?: number; pageSize?: number }
export interface UpdateSessionShop { deviceId?: SessionId | null; expectedDeviceId?: SessionId | null; loginAccount?: string; loginPassword?: string; clearPassword?: boolean; autoLogin?: boolean }
export interface ShopList { engine?: SessionEngine; canManage: boolean; total: number; page: number; pageSize: number; pageCount: number; shops: ShopRow[] }
const qs = (o: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};
export interface HistoryRow { id: SessionId; kind: string; status: string; errorCode: string | null; errorText: string | null; createdAt: string; finishedAt: string | null; deviceName: string; requestedByName: string }
export interface AuditRow { id: number; eventType: string; summary: string; createdAt: string; actorName: string | null; deviceName: string | null; storeName?: string | null }
export interface StoreCandidate { id: number; name: string; platform: string; storeNo?: string; platformStoreId?: string; operatorName?: string }
export interface VoucherFile { id: number; name: string; mime: string; size: number }
export interface CaptureStatus { id: SessionId; kind: string; status: string; errorText: string | null; file: VoucherFile | null }
const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });

const makeNativeSessionApi = (base: string) => ({
  overview: (p: ShopQuery = {}) => api<ShopList>(`${base}/overview${qs({ ...p })}`),
  available: (keyword?: string) => api<StoreCandidate[]>(`${base}/available-stores${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`),
  addShops: (storeIds: number[], deviceId: SessionId) => post(`${base}/shops`, { storeIds, deviceId }),
  updateShop: (id: number, b: UpdateSessionShop) => {
    const {expectedDeviceId:_expectedDeviceId,...payload}=b;
    return post(`${base}/shops/${id}`,payload);
  },
  removeShop: (id: number) => post(`${base}/shops/${id}/remove`),
  reveal: (id: number) => post<{ account: string; password: string }>(`${base}/shops/${id}/reveal`),
  open: (id: number) => post<{ id: SessionId; kind: string }>(`${base}/shops/${id}/open`),
  cancel: (requestId: SessionId) => post(`${base}/requests/${requestId}/cancel`),
  history: (id: number) => api<HistoryRow[]>(`${base}/shops/${id}/history`),
  devices: () => api<DeviceRow[]>(`${base}/devices`),
  bindCode: () => post<{ code: string; expiresAt: string }>(`${base}/bind-codes`),
  rename: (id: SessionId, name: string) => post(`${base}/devices/${id}/name`, { name }),
  remarkDevice: (id: SessionId, remark: string) => post(`${base}/devices/${id}/remark`, { remark }),
  setStatus: (id: SessionId, status: 'active' | 'revoked') => post(`${base}/devices/${id}/status`, { status }),
  updateDevice: (id: SessionId) => post<{ queued: boolean; alreadyCurrent?: boolean; target: string }>(`${base}/devices/${id}/update`),
  updateAllDevices: () => post<{ queued: number; target: string }>(`${base}/devices/update-all`),
  deleteDevice: (id: SessionId) => post(`${base}/devices/${id}/delete`),
  capture: (shopId: number) => post<{ id: SessionId }>(`${base}/shops/${shopId}/capture`),
  requestStatus: (id: SessionId) => api<CaptureStatus>(`${base}/requests/${id}`),
  uploadVoucher: (file: File) => { const form = new FormData(); form.append('file', file); return api<VoucherFile>(`${base}/vouchers`, { form }); },
  voucherUrl: (id: number) => api<{ url: string; name: string; mime: string }>(`${base}/vouchers/${id}/url`),
  docVouchers: (docId: number) => api<VoucherFile[]>(`${base}/docs/${docId}/vouchers`),
  bindVouchers: (docId: number, fileIds: number[]) => post<VoucherFile[]>(`${base}/docs/${docId}/vouchers`, { fileIds }),
  abnormalReasons: () => api<Array<{ id: number; reason: string }>>(`${base}/abnormal-reasons`),
  setStoreStatus: (id: number, b: { status: string; abnormalReasonId?: number; reason?: string }) => post(`${base}/shops/${id}/store-status`, b),
  audit: () => api<AuditRow[]>(`${base}/audit`),
  releases: () => api<AgentRelease[]>(`${base}/agent-releases`),
  publishRelease: (file: File, o: { sha256?: string; notes?: string }) => { const form = new FormData(); if (o.sha256) form.append('sha256', o.sha256); if (o.notes) form.append('notes', o.notes); form.append('file', file); return api<{ version: string; sha256: string; size: number }>(`${base}/agent-releases`, { form }); },
  withdrawRelease: (id: number) => post(`${base}/agent-releases/${id}/withdraw`),
  downloadInstaller: async () => {
    const token = tokenStore.get();
    const response = await fetch(`/api${base}/installer`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!response.ok) { const r = await response.json().catch(() => ({})); throw new ApiError(response.status, r.message || '安装包下载失败'); }
    const expected = response.headers.get('X-Checksum-SHA256')?.toLowerCase();
    const bytes = await response.arrayBuffer();
    const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (!expected || !/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error('安装包完整性校验失败，请重新下载');
    const filename = /filename="([\w.-]+\.(?:exe|zip))"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'kudesi-assistant-windows.zip';
    const url = URL.createObjectURL(new Blob([bytes], { type: filename.endsWith('.exe') ? 'application/octet-stream' : 'application/zip' }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return filename;
  },
});
export type SessionNativeClient = ReturnType<typeof makeNativeSessionApi>;
export function makeSessionApi(base: string) {
  const native = makeNativeSessionApi(base);
  const engine = makeSessionEngineResolver(base);
  const selected = Object.fromEntries(Object.keys(native).map(key=>[key,async(...args:unknown[])=>{
    const identity=tokenStore.get(),kind=await engine();
    if(tokenStore.get()!==identity)throw new Error('登录身份已变化，请刷新后重试');
    const implementation = kind === 'legacy' ? makeLegacySessionApi(base,native,identity) : native;
    return (implementation[key as keyof typeof native] as (...values:unknown[])=>Promise<unknown>)(...args);
  }])) as SessionNativeClient;
  return {...selected,engine};
}
export const sessionApi = makeSessionApi('/session');
export const maintenanceApi = makeSessionApi('/store-maintenance');
export type SessionClient = ReturnType<typeof makeSessionApi>;
