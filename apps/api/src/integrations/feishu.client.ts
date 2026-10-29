import { createHash } from 'crypto';
import { ExternalOutcomeUnknown, JsonRow } from './jushuitan.client';
export class FeishuClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}
  async request(path: string, body?: JsonRow, token?: string): Promise<JsonRow> {
    if (!['auth/v3/tenant_access_token/internal', 'authen/v2/oauth/token', 'authen/v1/user_info', 'im/v1/messages?receive_id_type=open_id', 'im/v1/messages?receive_id_type=union_id'].includes(path)) throw new Error('未允许的飞书接口');
    const sending = path.startsWith('im/');
    let r: Response;
    try { r = await this.fetchFn('https://open.feishu.cn/open-apis/' + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw sending ? new ExternalOutcomeUnknown('飞书发送结果未知，请回查后再决定是否重试') : new Error('飞书接口暂时无法连接'); }
    let data: JsonRow;
    try { data = await r.json() as JsonRow; } catch { throw sending ? new ExternalOutcomeUnknown('飞书发送响应无法确认') : new Error('飞书返回格式异常'); }
    if (!r.ok || (data.code != null && Number(data.code) !== 0) || data.error) {
      if (sending && (r.status >= 500 || data.code == null)) throw new ExternalOutcomeUnknown('飞书发送结果未知，请人工回查');
      throw new Error(`飞书接口被拒绝（HTTP ${r.status}，code ${Number.isFinite(Number(data.code)) ? Number(data.code) : 'unknown'}）`);
    }
    return data;
  }
  async tenantToken(app: { appId: string; appSecret: string }) {
    const b = await this.request('auth/v3/tenant_access_token/internal', { app_id: app.appId, app_secret: app.appSecret });
    if (!b.tenant_access_token) throw new Error('飞书未返回租户令牌');
    return String(b.tenant_access_token);
  }
  async identity(app: { appId: string; appSecret: string }, code: string, redirectUri: string) {
    const b = await this.request('authen/v2/oauth/token', { grant_type: 'authorization_code', client_id: app.appId, client_secret: app.appSecret, code, redirect_uri: redirectUri });
    const token = b.access_token ?? b.data?.access_token;
    if (!token) throw new Error('飞书授权未返回用户令牌');
    const info = await this.request('authen/v1/user_info', undefined, token);
    const user = info.data;
    if (!user?.open_id || !user.tenant_key) throw new Error('飞书授权未返回完整企业身份');
    return { openId: String(user.open_id), unionId: user.union_id ? String(user.union_id) : null, tenantKey: String(user.tenant_key) };
  }
  async send(app: { appId: string; appSecret: string }, receiveId: string, kind: 'open_id' | 'union_id', text: string, idempotencyKey: string) {
    const token = await this.tenantToken(app);
    await this.request('im/v1/messages?receive_id_type=' + kind, { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }), uuid: createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 48) }, token);
  }
}
