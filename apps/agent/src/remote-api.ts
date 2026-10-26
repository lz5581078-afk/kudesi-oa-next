import { call } from './api';
import type { AgentConfig } from './config';
import type { IceServer } from './remote-rtc';

export interface RemoteOffer {
  id: number;
  mode: 'view' | 'control';
  reason: string;
  requestedByName: string;
  store: { id: number; name: string; platform: string };
  maxMinutes: number;
  waitSeconds: number;
}
export interface RemoteSignalIn { id: number; kind: string; payload: Record<string, unknown> }
export interface ExchangeResult { status: 'requested' | 'active' | 'ended'; endReason: string | null; mode: 'view' | 'control'; expiresAt: string | null; signals: RemoteSignalIn[]; rejected: number }

/** 远程协助的助手接口（设备令牌）。服务端见 apps/api/src/session/remote.controller.ts */
export interface RemoteApi {
  claim(): Promise<{ enabled: boolean; session: RemoteOffer | null }>;
  accept(id: number): Promise<{ id: number; mode: 'view' | 'control'; expiresAt: string; iceServers: IceServer[] }>;
  decline(id: number, note?: string): Promise<{ ok: boolean }>;
  exchange(id: number, body: { send?: Array<{ kind: string; payload: Record<string, unknown> }>; after?: number; inputs?: number }): Promise<ExchangeResult>;
  end(id: number, body: { reason?: 'completed' | 'error'; note?: string; inputs?: number }): Promise<{ ok: boolean }>;
}

export const makeRemoteApi = (c: AgentConfig): RemoteApi => ({
  claim: () => call(c, '/api/agent/remote/claim', { json: {} }),
  accept: (id) => call(c, `/api/agent/remote/sessions/${id}/accept`, { json: {} }),
  decline: (id, note) => call(c, `/api/agent/remote/sessions/${id}/decline`, { json: note ? { note } : {} }),
  exchange: (id, body) => call(c, `/api/agent/remote/sessions/${id}/exchange`, { json: body }),
  end: (id, body) => call(c, `/api/agent/remote/sessions/${id}/end`, { json: body }),
});
