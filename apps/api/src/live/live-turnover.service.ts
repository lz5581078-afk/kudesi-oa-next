import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { liveFromText } from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { loadLiveAccess, requireView } from './live-access';
import { liveClock, sessionRow, wallNow } from './live-core';
import { channelsOf, channelStores } from './live-platforms';
import { LiveOrderSource } from './live-order-source';

type Store = { id: number; name: string; platform: string; jstShopId: string };
const emptyAmounts = { orderCount: null, turnoverCents: null, grossCents: null, refundCents: null };
const add = (a: number, b: number) => { const n = a + b; if (!Number.isSafeInteger(n) || n < 0) throw new Error('订单合计金额不合法'); return n; };

@Injectable()
export class LiveTurnoverService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly source: LiveOrderSource) {}
  private readonly cache = new Map<string, { expires: number; value: Promise<ReturnType<LiveTurnoverService['calculate']> extends Promise<infer T> ? T : never> }>();

  async read(user: AuthUser, id: number) {
    const a = await loadLiveAccess(this.ds.manager, user); requireView(a);
    // 每次读取均先校验公司与权限，缓存不能绕过鉴权。
    const s = await sessionRow(this.ds.manager, a.companyId, id);
    const key = JSON.stringify([a.companyId, id, s.start_text, s.end_text, s.status, s.channels_json, s.store_id, s.jst_shop_id]);
    const time = +liveClock.now();
    const old = this.cache.get(key);
    if (old && old.expires > time) return old.value;
    for (const [k, v] of this.cache) if (v.expires <= time) this.cache.delete(k);
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    const entry = { expires: Number.POSITIVE_INFINITY, value: this.calculate(a.companyId, s) };
    this.cache.set(key, entry);
    try {
      const value = await entry.value;
      // 从查询完成时计时，合并慢查询的并发请求；失败短暂缓存，避免外部接口重试风暴。
      entry.expires = +liveClock.now() + (value.available ? 30_000 : 10_000);
      return value;
    } catch (e) { this.cache.delete(key); throw e; }
  }

  private async store(companyId: number, sessionId: number, store: Store, startAt: string, endAt: string) {
    const base = { storeId: store.id, storeName: store.name, platform: store.platform };
    try {
      if (!store.jstShopId) throw new Error('该店铺未绑定聚水潭店铺');
      const found = await this.source.turnoverOrders(companyId, { id: sessionId, shopId: store.jstShopId, startAt, endAt });
      if (!found.available || found.truncated) throw new Error(found.reason || '订单查询不完整，暂不能确认营业额');
      // 二次核对归属时间；即使来源误带历史订单，也不允许将其退款用于本场。
      const seen = new Set<string>();
      const orders = found.orders.filter(o => {
        const t = liveFromText(o.orderTime);
        if (!t || +t < +liveFromText(startAt)! || +t >= +liveFromText(endAt)!) return false;
        if (!o.orderId || seen.has(o.orderId)) throw new Error('订单编号缺失或重复，不能确认营业额');
        seen.add(o.orderId);
        if (!Number.isSafeInteger(o.amountCents) || o.amountCents < 0) throw new Error('订单金额不合法');
        return o.paid && !o.cancelled && o.amountCents > 0;
      });
      const refunds = await this.source.refunds(companyId, store.jstShopId, orders);
      let orderCount = 0, grossCents = 0, refundCents = 0;
      for (const o of orders) {
        const refund = refunds.get(o.orderId);
        if (!refund || !Number.isSafeInteger(refund.cents) || refund.cents < 0 || refund.cents > o.amountCents) throw new Error('本场订单售后核对不完整');
        grossCents = add(grossCents, o.amountCents); refundCents = add(refundCents, refund.cents);
        if (o.amountCents > refund.cents) orderCount++;
      }
      return { ...base, available: true, reason: '', orderCount, grossCents, refundCents, turnoverCents: grossCents - refundCents };
    } catch (e) { return { ...base, available: false, reason: (e as Error).message, ...emptyAmounts }; }
  }

  private async calculate(companyId: number, s: Record<string, any>) {
    const now = wallNow(liveClock.now());
    const endAt = s.end_text || now;
    const base = { sessionId: Number(s.id), roomName: s.room_name, startAt: s.start_text as string, endAt: endAt as string, live: s.status === 'live' };
    const stores: Store[] = channelStores(channelsOf(s));
    if (!stores.length && s.store_id) stores.push({ id: Number(s.store_id), name: s.store_name || '本场店铺', jstShopId: s.jst_shop_id || '', platform: 'douyin' });
    const byShop = new Map<string, Store>();
    for (const store of stores) { const key = store.jstShopId || `local:${store.id}`; if (!byShop.has(key)) byShop.set(key, store); }
    const uniqueStores = [...byShop.values()];
    const results: Awaited<ReturnType<LiveTurnoverService['store']>>[] = [];
    // 限制每个场次同时请求的店铺数，多个账号关联同一店铺只统计一次。
    for (let i = 0; i < uniqueStores.length; i += 3) results.push(...await Promise.all(uniqueStores.slice(i, i + 3).map(store => this.store(companyId, Number(s.id), store, s.start_text, endAt))));
    const available = results.length > 0 && results.every(r => r.available);
    return { ...base, queriedAt: wallNow(liveClock.now()), available, reason: !stores.length ? '本场没有关联店铺' : available ? '' : '部分店铺查询失败，合计暂不可用',
      ...emptyAmounts, ...(available ? { orderCount: results.reduce((n,r) => n + r.orderCount!,0), turnoverCents: results.reduce((n,r) => add(n,r.turnoverCents!),0), grossCents: results.reduce((n,r) => add(n,r.grossCents!),0), refundCents: results.reduce((n,r) => add(n,r.refundCents!),0) } : {}), stores: results };
  }
}
