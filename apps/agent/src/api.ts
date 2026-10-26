import type { AgentConfig } from './config';

export class AgentApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'AgentApiError'; }
}

const TIMEOUT_MS = 25_000;

export async function call<T>(c: Pick<AgentConfig, 'serverUrl' | 'deviceToken'>, p: string, init: RequestInit & { json?: unknown; form?: FormData } = {}): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'x-device-token': c.deviceToken };
    let body: BodyInit | undefined;
    if (init.form) body = init.form;
    else if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json); }
    const res = await fetch(new URL(p, c.serverUrl), { method: init.method ?? 'POST', headers, body, signal: ctl.signal });
    const data = (await res.json().catch(() => ({}))) as { message?: string | string[] } & T;
    if (!res.ok) throw new AgentApiError(Array.isArray(data.message) ? data.message.join('；') : data.message ?? `服务器请求失败（${res.status}）`, res.status);
    return data as T;
  } finally { clearTimeout(timer); }
}

export interface OpenRequest {
  id: number;
  kind: 'first' | 'now' | 'capture';
  store: { id: number; name: string; platform: string; url: string };
  credentials: { account: string; password: string } | null;
}

export const api = {
  heartbeat: (c: AgentConfig, agentVersion: string) => call<{ ok: boolean; pending: number; update?: { targetVersion: string; sha256?: string; size?: number } | null }>(c, '/api/agent/heartbeat', { json: { agentVersion } }),
  claim: (c: AgentConfig) => call<{ request: OpenRequest | null }>(c, '/api/agent/claim', { json: {} }),
  report: (c: AgentConfig, id: number, body: { status: 'succeeded' | 'failed'; errorCode?: string; errorText?: string }) => call<{ ok: boolean }>(c, `/api/agent/requests/${id}/report`, { json: body }),
  upload: (c: AgentConfig, id: number, png: Buffer, name: string) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), name);
    return call<{ ok: boolean; fileId: number }>(c, `/api/agent/requests/${id}/upload`, { form });
  },
};

/** 绑定：不带令牌，用网页上生成的 8 位绑定码换设备令牌。 */
export async function registerWithCode(serverUrl: string, body: { code: string; name: string; os: string; agentVersion: string }) {
  const res = await fetch(new URL('/api/agent/register', serverUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { message?: string | string[]; deviceId?: number; deviceNo?: string; token?: string };
  if (!res.ok) throw new AgentApiError(Array.isArray(data.message) ? data.message.join('；') : data.message ?? '电脑绑定失败', res.status);
  return data as { deviceId: number; deviceNo: string; token: string };
}
