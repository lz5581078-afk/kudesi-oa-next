import { createHash } from 'crypto';
import { ExternalOutcomeUnknown, JsonRow } from './jushuitan.client';
export class FeishuClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}
  async request(path: string, body?: JsonRow, token?: string): Promise<JsonRow> {
    const directory = !body && /^(contact\/v3\/departments\/0\/children|contact\/v3\/users\/find_by_department)\?/.test(path);
    if (!directory && !['auth/v3/tenant_access_token/internal', 'authen/v2/oauth/token', 'authen/v1/user_info', 'im/v1/messages?receive_id_type=open_id', 'im/v1/messages?receive_id_type=union_id', 'message/v4/batch_send/'].includes(path)) throw new Error('未允许的飞书接口');
    const sending = path.startsWith('im/') || path === 'message/v4/batch_send/';
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
  private async batchRecipients(token: string, departmentIds: string[]) {
    if (!departmentIds.length) throw new Error('飞书群发缺少部门范围');
    let departments = [...new Set(departmentIds)];
    const users: string[] = [];
    if (departments.includes('0')) {
      // Root 0 means all employees in our configuration, but Feishu batch_send
      // explicitly rejects it. Resolve top-level departments plus root users.
      departments = [];
      const collect = async (path: string, query: Record<string, string>, visit: (item: JsonRow) => void) => {
        const seen = new Set<string>();
        let pageToken = '';
        for (let page = 0; page < 1000; page++) {
          const params = new URLSearchParams({ ...query, page_size: '50', ...(pageToken ? { page_token: pageToken } : {}) });
          const result = await this.request(`${path}?${params}`, undefined, token);
          const data = result.data;
          if (!data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean') throw new Error('飞书通讯录范围响应不完整，未发送消息');
          data.items.forEach(visit);
          if (!data.has_more) return;
          if (!data.page_token || seen.has(String(data.page_token))) throw new Error('飞书通讯录分页异常，未发送消息');
          pageToken = String(data.page_token);
          seen.add(pageToken);
        }
        throw new Error('飞书通讯录分页超过上限，未发送消息');
      };
      await collect('contact/v3/departments/0/children', { department_id_type: 'department_id', fetch_child: 'false' }, item => {
        if (!item.department_id || String(item.department_id) === '0') throw new Error('飞书部门标识异常，未发送消息');
        if (!item.status?.is_deleted) departments.push(String(item.department_id));
      });
      await collect('contact/v3/users/find_by_department', { department_id: '0', department_id_type: 'department_id', user_id_type: 'open_id' }, item => {
        if (item.status?.is_resigned || item.status?.is_exited || item.status?.is_frozen || item.status?.is_unjoin) return;
        if (!item.open_id) throw new Error('飞书成员标识缺失，未发送消息');
        users.push(String(item.open_id));
      });
    }
    departments = [...new Set(departments)];
    const openIds = [...new Set(users)];
    if (!departments.length && !openIds.length) throw new Error('飞书通讯录未返回可发送范围');
    if (departments.length > 200 || openIds.length > 200) throw new Error('飞书群发范围超过单次限制，请联系管理员调整');
    return { ...(departments.length ? { department_ids: departments } : {}), ...(openIds.length ? { open_ids: openIds } : {}) };
  }
  async checkBatchScope(app: { appId: string; appSecret: string }, departmentIds: string[]) {
    const recipients = await this.batchRecipients(await this.tenantToken(app), departmentIds);
    return { departments: recipients.department_ids?.length ?? 0, directUsers: recipients.open_ids?.length ?? 0 };
  }
  async batchSend(app: { appId: string; appSecret: string }, departmentIds: string[], text: string) {
    const token = await this.tenantToken(app);
    const recipients = await this.batchRecipients(token, departmentIds);
    const result = await this.request('message/v4/batch_send/', { ...recipients, msg_type: 'text', content: { text } }, token);
    if (!result.data?.message_id || result.data?.invalid_department_ids?.length || result.data?.invalid_open_ids?.length) throw new ExternalOutcomeUnknown('批量消息提交结果不完整，请到飞书核查');
    return String(result.data.message_id);
  }
}
