import { createHash } from 'crypto';
export type JsonRow = Record<string, any>;
export class ExternalOutcomeUnknown extends Error { readonly outcomeUnknown = true; }
export function jstSign(secret: string, params: Record<string, string>): string {
  return createHash('md5').update(secret + Object.keys(params).filter(k => k !== 'sign').sort().map(k => k + params[k]).join('')).digest('hex');
}
export const JST_READ_PATHS = ['/open/shops/query', '/open/sku/query', '/open/combine/sku/query', '/open/category/query', '/open/orders/single/query', '/open/refund/single/query'] as const;
const writes = ['/open/jushuitan/itemsku/upload', '/open/item/combinesku/upload', '/open/webapi/itemapi/category/addorupdate'];
export class JushuitanClient {
  constructor(readonly config: { appKey: string; appSecret: string; accessToken: string; baseUrl: string }, private readonly fetchFn: typeof fetch = fetch) {
    const u = new URL(config.baseUrl);
    if (u.protocol !== 'https:' || !['openapi.jushuitan.com', 'dev-api.jushuitan.com'].includes(u.hostname) || u.username || u.password || u.search || u.port || u.pathname !== '/') throw new Error('聚水潭接口地址不在官方白名单');
  }
  async call(path: string, biz: JsonRow): Promise<JsonRow> {
    const write = writes.includes(path);
    if (!write && !(JST_READ_PATHS as readonly string[]).includes(path)) throw new Error('未允许的聚水潭接口');
    const p: Record<string, string> = { app_key: this.config.appKey, access_token: this.config.accessToken, timestamp: String(Math.floor(Date.now() / 1000)), charset: 'utf-8', version: '2', biz: JSON.stringify(biz) };
    p.sign = jstSign(this.config.appSecret, p);
    let r: Response;
    try { r = await this.fetchFn(this.config.baseUrl.replace(/\/$/, '') + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: new URLSearchParams(p), redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw write ? new ExternalOutcomeUnknown('聚水潭写入响应未确认，请先回查，禁止自动重发') : new Error('聚水潭查询连接失败，请稍后重试'); }
    let body: JsonRow;
    try { body = await r.json() as JsonRow; } catch { throw write ? new ExternalOutcomeUnknown('聚水潭写入返回格式异常，请先回查') : new Error('聚水潭查询返回格式异常'); }
    if (!r.ok || Number(body.code) !== 0) {
      if (write && (r.status >= 500 || body.code == null)) throw new ExternalOutcomeUnknown('聚水潭写入结果未知，请先回查');
      // 不返回上游正文：可能包含请求中的密钥或客户资料。
      throw new Error(`聚水潭接口被拒绝（HTTP ${r.status}，code ${Number.isFinite(Number(body.code)) ? Number(body.code) : 'unknown'}）`);
    }
    if (write) {
      const data = body.data, rows = body.datas ?? data?.datas ?? data?.items ?? (Array.isArray(data) ? data : []);
      const receipts = [body, ...(data && !Array.isArray(data) ? [data] : []), ...(Array.isArray(rows) ? rows : [])];
      if (receipts.some(r => r && (['is_success', 'issuccess', 'success'].some(k => r[k] === false || r[k] === 'false') || (r.code != null && Number(r.code) !== 0)))) throw new Error('聚水潭明确拒绝了该条写入，请核对资料后重试');
    }
    return body.data ?? body;
  }
  async pages(path: string, biz: JsonRow, key: string, maxPages = 30): Promise<JsonRow[]> {
    const all: JsonRow[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const b = await this.call(path, { ...biz, page_index: page, page_size: 50 });
      const rows = b[key] ?? b.datas ?? (Array.isArray(b) ? b : b.data);
      if (!Array.isArray(rows) || ![true, false, 0, 1].includes(b.has_next)) throw new Error('聚水潭响应缺少完整列表或分页标记，不能确认查询结果');
      all.push(...rows);
      if (!b.has_next) return all;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw new Error('聚水潭结果超出分页上限，请缩小范围后重试');
  }
}
