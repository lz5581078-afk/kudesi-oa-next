import { api } from '../../api/client';

export interface ShopRow {
  storeStatus?: string; abnormalReason?: string; id: number; storeId: number; storeName: string; platform: string; deviceId: number | null; deviceName: string; deviceStatus: 'online' | 'offline' | 'revoked' | 'none';
  loginAccount: string; hasPassword: boolean; autoLogin: boolean; loginState: 'none' | 'valid' | 'expired' | 'error'; lastVerifiedAt: string | null; activeRequest: { id: number; kind: string; status: string } | null;
  storeNo?: string; platformStoreId?: string; platformLabel?: string; operatorName?: string; lastOpenedAt?: string | null;
  request?: { id: number; kind: string; status: string; percent: number; step: string; errorText: string | null; at: string } | null;
}
export interface DeviceRow {
  id: number; name: string; deviceNo: string; os: string | null; agentVersion: string | null; status: 'active' | 'revoked'; online: boolean; lastSeenAt: string | null; shopCount: number;
  outdated?: boolean; latestVersion?: string | null; update?: { target: string | null; status: 'queued' | 'downloading' | 'verifying' | 'staged' | 'applying' | 'restarting' | 'succeeded' | 'failed' | 'rolled_back'; requestedAt: string | null; error?: string | null } | null;
}
export interface AgentRelease { id: number; version: string; sha256: string; size: number; notes: string | null; createdAt: string; withdrawnAt: string | null; createdByName: string | null; isLatest: boolean }
export interface ShopQuery { storeId?: number; keyword?: string; loginState?: string; storeStatus?: string; deviceId?: string; sort?: string; page?: number; pageSize?: number }
export interface ShopList { canManage: boolean; total: number; page: number; pageSize: number; pageCount: number; shops: ShopRow[] }
const qs = (o: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};
export interface HistoryRow { id: number; kind: string; status: string; errorCode: string | null; errorText: string | null; createdAt: string; finishedAt: string | null; deviceName: string; requestedByName: string }
export interface AuditRow { id: number; eventType: string; summary: string; createdAt: string; actorName: string | null; deviceName: string | null }
export interface VoucherFile { id: number; name: string; mime: string; size: number }
export interface CaptureStatus { id: number; kind: string; status: string; errorText: string | null; file: VoucherFile | null }
const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });

export const makeSessionApi = (base: string) => ({
  overview: (p: ShopQuery = {}) => api<ShopList>(`${base}/overview${qs({ ...p })}`),
  available: (keyword?: string) => api<Array<{ id: number; name: string; platform: string }>>(`${base}/available-stores${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`),
  addShops: (storeIds: number[], deviceId: number) => post(`${base}/shops`, { storeIds, deviceId }),
  updateShop: (id: number, b: { deviceId?: number | null; loginAccount?: string; loginPassword?: string; clearPassword?: boolean; autoLogin?: boolean }) => post(`${base}/shops/${id}`, b),
  removeShop: (id: number) => post(`${base}/shops/${id}/remove`),
  reveal: (id: number) => post<{ account: string; password: string }>(`${base}/shops/${id}/reveal`),
  open: (id: number) => post<{ id: number; kind: string }>(`${base}/shops/${id}/open`),
  cancel: (requestId: number) => post(`${base}/requests/${requestId}/cancel`),
  history: (id: number) => api<HistoryRow[]>(`${base}/shops/${id}/history`),
  devices: () => api<DeviceRow[]>(`${base}/devices`),
  bindCode: () => post<{ code: string; expiresAt: string }>(`${base}/bind-codes`),
  rename: (id: number, name: string) => post(`${base}/devices/${id}/name`, { name }),
  setStatus: (id: number, status: 'active' | 'revoked') => post(`${base}/devices/${id}/status`, { status }),
  updateDevice: (id: number) => post<{ queued: boolean; alreadyCurrent?: boolean; target: string }>(`${base}/devices/${id}/update`),
  updateAllDevices: () => post<{ queued: number; target: string }>(`${base}/devices/update-all`),
  deleteDevice: (id: number) => post(`${base}/devices/${id}/delete`),
  capture: (shopId: number) => post<{ id: number }>(`${base}/shops/${shopId}/capture`),
  requestStatus: (id: number) => api<CaptureStatus>(`${base}/requests/${id}`),
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
});
export const sessionApi = makeSessionApi('/session');
export type SessionClient = ReturnType<typeof makeSessionApi>;
