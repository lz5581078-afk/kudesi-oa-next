import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { liveFromText } from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { loadLiveAccess, requireView } from './live-access';
import { liveClock, lockCompany, sessionRow, wallNow } from './live-core';
import { channelsOf, channelStores } from './live-platforms';
import { LiveOrderSource } from './live-order-source';

type Store = { id: number; name: string; platform: string; jstShopId: string };
const emptyAmounts = { orderCount: null, turnoverCents: null, grossCents: null, refundCents: null };
const add = (a: number, b: number) => { const n = a + b; if (!Number.isSafeInteger(n) || n < 0) throw new Error('订单合计金额不合法'); return n; };

@Injectable()
export class LiveTurnoverService implements OnModuleInit, OnModuleDestroy {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly source: LiveOrderSource) {}
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly log = new Logger(LiveTurnoverService.name);

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.LIVE_TURNOVER_WORKER === 'off') return;
    this.timer = setInterval(() => void this.scheduled(), 15_000);
    this.timer.unref();
    void this.scheduled();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private async scheduled() {
    if (this.running) return;
    this.running = true;
    try { await this.scan(); }
    catch { this.log.error('营业额统一快照扫描失败，将自动重试'); }
    finally { this.running = false; }
  }
  private payload(value: any): any { return typeof value === 'string' ? JSON.parse(value) : value; }

  /** Browsers only read the persisted shared snapshot; a GET never calls an external source. */
  async read(user: AuthUser, id: number) {
    const a = await loadLiveAccess(this.ds.manager, user); requireView(a);
    const s = await sessionRow(this.ds.manager, a.companyId, id);
    const [row] = await this.ds.query('SELECT payload_json,locked_at,last_error FROM live_turnover_snapshots WHERE company_id=? AND session_id=?', [a.companyId, id]);
    const data = this.payload(row?.payload_json);
    const active = s.status === 'live' && !s.end_text;
    if (data) return { ...data, live: active, locked: !!row.locked_at || !active, refreshError: row.last_error || null };
    return { sessionId: id, roomName: s.room_name, startAt: s.start_text, endAt: s.end_text || s.start_text, live: active,
      queriedAt: '', locked: !active, available: false, ...emptyAmounts, stores: [], refreshError: row?.last_error || null,
      reason: active ? '服务器正在统一统计营业额' : '已停止销售查询，未保存可用销售数据' };
  }

  /** Independent of visitors, notifications and browser visibility. Leases coordinate API replicas. */
  async scan() {
    const now = wallNow(liveClock.now());
    // Only currently broadcasting sessions can request external sales data. Never backfill ended sessions.
    const due: Array<{id:number;company_id:number}> = await this.ds.query(`SELECT s.id,s.company_id FROM live_sessions s
      JOIN companies c ON c.id=s.company_id AND c.status='active'
      LEFT JOIN live_turnover_snapshots t ON t.company_id=s.company_id AND t.session_id=s.id
      WHERE s.status='live' AND s.end_at IS NULL AND t.locked_at IS NULL
        AND (t.lease_until IS NULL OR t.lease_until<=?)
        AND (t.next_refresh_at IS NULL OR t.next_refresh_at<=?)
      ORDER BY COALESCE(t.next_refresh_at,'1970-01-01'),s.id DESC LIMIT 6`, [now, now]);
    for (let i = 0; i < due.length; i += 2) await Promise.all(due.slice(i, i + 2).map(async s => {
      try { await this.update(Number(s.company_id), Number(s.id)); }
      catch { this.log.error(`营业额快照处理失败 #${s.id}，将自动重试`); }
    }));
    return due.length;
  }

  async update(companyId: number, id: number) {
    const token = randomUUID();
    const s = await this.ds.transaction(async em => {
      await lockCompany(em, companyId);
      const session = await sessionRow(em, companyId, id, true);
      if (session.status !== 'live' || session.end_text) return null;
      await em.query('INSERT IGNORE INTO live_turnover_snapshots(company_id,session_id) VALUES (?,?)', [companyId, id]);
      const [row] = await em.query(`SELECT *,DATE_FORMAT(lease_until,'%Y-%m-%d %H:%i:%s') lease_text,DATE_FORMAT(next_refresh_at,'%Y-%m-%d %H:%i:%s') next_text FROM live_turnover_snapshots WHERE company_id=? AND session_id=? FOR UPDATE`, [companyId, id]);
      const now = wallNow(liveClock.now());
      if (row.locked_at || (row.lease_text && row.lease_text > now)) return null;
      if (row.next_text > now) return null;
      await em.query('UPDATE live_turnover_snapshots SET lease_token=?,lease_until=? WHERE company_id=? AND session_id=?',
        [token, wallNow(new Date(+liveClock.now() + 300_000)), companyId, id]);
      return session;
    });
    if (!s) return;
    // External I/O is outside the company transaction. Never hold company locks while waiting on an API.
    let value: Awaited<ReturnType<LiveTurnoverService['calculate']>>;
    try { value = await this.calculate(companyId, s); }
    catch { value = { sessionId:id,roomName:s.room_name,startAt:s.start_text,endAt:s.end_text||wallNow(liveClock.now()),live:!s.end_text,
      queriedAt:wallNow(liveClock.now()),available:false,reason:'营业额查询失败，服务器将自动重试',...emptyAmounts,stores:[] }; }
    await this.ds.transaction(async em => {
      await lockCompany(em, companyId);
      const latest = await sessionRow(em, companyId, id, true);
      const [row] = await em.query(`SELECT *,DATE_FORMAT(lease_until,'%Y-%m-%d %H:%i:%s') lease_text FROM live_turnover_snapshots WHERE company_id=? AND session_id=? FOR UPDATE`, [companyId, id]);
      const now = wallNow(liveClock.now());
      if (row.locked_at || row.lease_token !== token || row.lease_text <= now) return;
      const sameBounds = latest.start_text === s.start_text && latest.end_text === s.end_text && JSON.stringify(channelsOf(latest)) === JSON.stringify(channelsOf(s));
      if (!sameBounds || latest.status !== 'live' || latest.end_text) {
        await em.query('UPDATE live_turnover_snapshots SET lease_token=NULL,lease_until=NULL,next_refresh_at=? WHERE company_id=? AND session_id=? AND lease_token=?', [now,companyId,id,token]);
        return;
      }
      const prior = this.payload(row.payload_json);
      const failures = value.available ? 0 : Number(row.failures) + 1;
      const next = wallNow(new Date(+liveClock.now() + (value.available ? 60_000 : Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)))));
      const payload = !value.available && prior?.available ? prior : value;
      await em.query(`UPDATE live_turnover_snapshots SET payload_json=?,locked_at=?,next_refresh_at=?,last_error=?,failures=?,lease_token=NULL,lease_until=NULL
        WHERE company_id=? AND session_id=? AND lease_token=? AND locked_at IS NULL`,
        [JSON.stringify(payload), null, next, value.available ? null : value.reason.slice(0,500), failures, companyId, id, token]);
    });
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
    const base = { sessionId: Number(s.id), roomName: s.room_name, startAt: s.start_text as string, endAt: endAt as string, live: !s.end_text };
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
