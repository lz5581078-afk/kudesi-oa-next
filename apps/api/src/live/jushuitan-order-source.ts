import { Injectable } from '@nestjs/common';
import { liveFromText, liveToText } from '@kudesi/shared';
import { ExternalConfigService } from '../integrations/external-config.service';
import { JushuitanClient, JsonRow } from '../integrations/jushuitan.client';
import { LiveOrderCandidates, LiveOrderSource, LiveRefund, LiveSourceStatus } from './live-order-source';
function cents(v: unknown): number { const n = Math.round(Number(v) * 100); if (!Number.isSafeInteger(n) || n < 0) throw new Error('聚水潭金额不合法，不能结算'); return n; }
export function refundFor(orderAmount: number, order: JsonRow, rows: JsonRow[]): LiveRefund {
  if (order.status === 'Cancelled') return { cents: orderAmount, source: 'cancelled', details: [{ kind: 'order', status: 'Cancelled' }] };
  const seen = new Map<string, string>(); let sum = 0;
  const details: JsonRow[] = [];
  for (const r of rows) {
    if (r.as_id == null) throw new Error('售后单缺少唯一编号，不能确认退款');
    const fingerprint = JSON.stringify([r.status, r.shop_status, r.type, r.refund ?? r.refund_amount ?? r.payment]);
    if (seen.has(String(r.as_id))) { if (seen.get(String(r.as_id)) !== fingerprint) throw new Error('同一售后单返回冲突状态'); continue; }
    seen.set(String(r.as_id), fingerprint);
    const amount = cents(r.refund ?? r.refund_amount ?? r.payment ?? 0);
    const counted = !['Cancelled', 'Merged'].includes(r.status) && !/换货|补发|维修/.test(String(r.type ?? '')) && (r.status === 'Confirmed' || /SUCCESS|成功|已退款|退款完成/i.test(String(r.shop_status ?? '')));
    if (counted) sum += amount;
    details.push({ kind: 'refund', asId: String(r.as_id), status: r.status, counted, cents: amount });
  }
  return { cents: Math.min(orderAmount, sum), source: sum > 0 ? 'refund' : 'none', details };
}
@Injectable()
export class JushuitanOrderSource extends LiveOrderSource {
  constructor(private readonly settings: ExternalConfigService) { super(); }
  /** 只检查授权配置（不调用聚水潭）：未配置应用/未授权账户/授权过期分别给出明确提示。 */
  async status(companyId: number): Promise<LiveSourceStatus> {
    try { await this.settings.jst(companyId); return { ready: true, code: 'ready', message: '' }; }
    catch (e) {
      const m = (e as Error).message;
      if (/过期/.test(m)) return { ready: false, code: 'expired', message: '聚水潭授权已过期。管理员需要在“接口接入”里为本公司续期授权后，才能查询订单和退款。' };
      if (/正式应用/.test(m)) return { ready: false, code: 'unconfigured', message: '聚水潭正式应用还没有配置。管理员需要先在平台“接口应用”里配置，再为本公司授权。' };
      if (/唯一的聚水潭公司授权/.test(m)) return { ready: false, code: 'unauthorized', message: '本公司还没有完成聚水潭授权（或授权账户不唯一）。管理员需要在“接口接入”里授权聚水潭后，才能查询订单和退款。' };
      return { ready: false, code: 'error', message: `聚水潭接口配置读取失败：${m}` };
    }
  }
  private async client(companyId: number, shopId: string) {
    if (!/^\d+$/.test(shopId) || !Number.isSafeInteger(Number(shopId))) throw new Error('聚水潭店铺编号不合法');
    const cfg = await this.settings.jst(companyId);
    const client = new JushuitanClient(cfg);
    const shops = await client.pages('/open/shops/query', {}, 'datas');
    if (!shops.some(s => String(s.shop_id) === shopId && String(s.co_id) === String(cfg.coid))) throw new Error('聚水潭店铺不属于当前授权公司');
    return client;
  }
  async candidates(companyId: number, session: { id: number; shopId: string | null; startAt: string; endAt: string | null }): Promise<LiveOrderCandidates> {
    const unavailable = (reason: string): LiveOrderCandidates => ({ available: false, reason, window: null, orders: [], truncated: false });
    const start = liveFromText(session.startAt), end = session.endAt ? liveFromText(session.endAt) : null;
    if (!session.shopId) return unavailable('店铺尚未填写聚水潭店铺编号');
    if (!start || !end || +end <= +start || +end - +start > 48 * 3600000) return unavailable('直播时间窗不完整或超过 48 小时');
    try {
      const client = await this.client(companyId, session.shopId);
      const rows = await client.pages('/open/orders/single/query', { shop_id: Number(session.shopId), date_type: 1, modified_begin: session.startAt, modified_end: session.endAt }, 'orders');
      const byId = new Map<string, LiveOrderCandidates['orders'][number]>();
      for (const r of rows) {
        if (String(r.shop_id) !== session.shopId) throw new Error('查询返回了其他店铺订单');
        const at = r.pay_date ?? r.order_date, t = liveFromText(String(at ?? ''));
        if (!t || +t < +start || +t > +end) continue;
        const id = String(r.so_id ?? ''); if (!id) throw new Error('聚水潭订单缺少平台订单号');
        if (byId.has(id)) throw new Error('同一平台订单号对应多条订单，请先核对拆单');
        byId.set(id, { orderId: id, innerId: String(r.o_id ?? ''), payTime: liveToText(t), paid: Boolean(r.pay_date), amountCents: cents(r.paid_amount ?? r.pay_amount ?? r.amount ?? 0), status: String(r.status), statusLabel: String(r.status), cancelled: r.status === 'Cancelled' });
      }
      return { available: true, reason: '', shopId: session.shopId, window: { start: session.startAt, end: session.endAt! }, orders: [...byId.values()], truncated: false, queriedAt: new Date().toISOString() };
    } catch (e) { return unavailable((e as Error).message); }
  }
  async refunds(companyId: number, shopId: string, orders: Array<{ orderId: string; amountCents: number }>): Promise<Map<string, LiveRefund>> {
    const result = new Map<string, LiveRefund>(); if (!orders.length) return result;
    const client = await this.client(companyId, shopId);
    for (let i = 0; i < orders.length; i += 20) {
      const batch = orders.slice(i, i + 20), biz = { shop_id: Number(shopId), so_ids: batch.map(o => o.orderId) };
      const current = await client.pages('/open/orders/single/query', biz, 'orders');
      const refunds = await client.pages('/open/refund/single/query', biz, 'datas');
      if ([...current, ...refunds].some(r => String(r.shop_id) !== shopId)) throw new Error('退款核对返回了其他店铺的数据');
      for (const o of batch) {
        const hits = current.filter(r => String(r.so_id) === o.orderId);
        if (hits.length !== 1) throw new Error('订单查询缺失或存在拆单，不能生成不完整结算');
        result.set(o.orderId, refundFor(o.amountCents, hits[0], refunds.filter(r => String(r.so_id) === o.orderId)));
      }
    }
    return result;
  }
}
