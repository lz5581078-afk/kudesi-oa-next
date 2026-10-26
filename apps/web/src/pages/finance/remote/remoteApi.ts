import { api } from '../../../api/client';
import type { RemoteInput, RemoteMode } from '@kudesi/shared';

export interface IceServer { urls: string[]; username?: string; credential?: string }
export interface RemoteSession {
  id: number; status: 'requested' | 'active' | 'ended'; mode: RemoteMode; reason: string; mine: boolean;
  storeName: string; deviceName: string; requestedByName: string;
  requestedAt: string; acceptedAt: string | null; expiresAt: string | null; endedAt: string | null;
  secondsLeft: number; endReason: string | null; endReasonLabel: string | null; endNote: string | null; canExtend: boolean; durationSeconds: number;
  iceServers?: IceServer[];
}
export interface RemoteSignal { id: number; kind: string; payload: Record<string, unknown> }
export interface RemoteShopState {
  shopId: number; remoteEnabled: boolean; allowControl: boolean; maxMinutes: number; deviceOnline: boolean;
  live: { id: number; status: 'requested' | 'active'; mode: RemoteMode; mine: boolean; requestedByName: string } | null;
}
export interface RemoteDevicesInfo {
  globalDisabled: boolean; iceConfigured: boolean; canManage: boolean; canRemote: boolean; limits: { minMinutes: number; hardCapMinutes: number };
  devices: Array<{ deviceId: number; enabled: boolean; allowControl: boolean; maxMinutes: number }>;
}
export interface RemoteHistoryRow {
  id: number; storeName: string; deviceName: string; requestedByName: string; mode: RemoteMode; reason: string; status: string;
  endReason: string | null; endReasonLabel: string | null; endedByName: string; requestedAt: string; acceptedAt: string | null; endedAt: string | null;
  durationSeconds: number; inputCount: number; extendCount: number;
}

const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });

export const remoteApi = {
  shops: () => api<{ canRemote: boolean; globalDisabled: boolean; shops: RemoteShopState[] }>('/session/remote/shops'),
  devices: () => api<RemoteDevicesInfo>('/session/remote/devices'),
  setDevice: (id: number, b: { enabled: boolean; allowControl?: boolean; maxMinutes?: number }) => post(`/session/remote/devices/${id}`, b),
  stopAll: () => post<{ ended: number; disabledDevices: number }>('/session/remote/stop-all'),
  request: (shopId: number, b: { mode: RemoteMode; reason: string }) => post<{ id: number; status: 'requested'; waitSeconds: number }>(`/session/remote/shops/${shopId}/request`, b),
  get: (id: number) => api<RemoteSession>(`/session/remote/sessions/${id}`),
  poll: (id: number, after: number) => api<RemoteSession & { signals: RemoteSignal[] }>(`/session/remote/sessions/${id}/poll?after=${after}`),
  signal: (id: number, kind: string, payload: Record<string, unknown> = {}) => post(`/session/remote/sessions/${id}/signal`, { kind, payload }),
  extend: (id: number) => post<RemoteSession>(`/session/remote/sessions/${id}/extend`),
  end: (id: number) => post(`/session/remote/sessions/${id}/end`),
  history: () => api<RemoteHistoryRow[]>('/session/remote/history'),
};
export type RemoteApi = typeof remoteApi;
export type { RemoteInput };
