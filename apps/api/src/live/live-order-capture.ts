import { EntityManager } from 'typeorm';
import { liveFromText } from '@kudesi/shared';
import { Row, wallNow } from './live-core';
import { channelsOf, channelStores } from './live-platforms';
import { LiveOrderSource, LiveTurnoverOrder, LiveRefund } from './live-order-source';

export type CapturedOrder = LiveTurnoverOrder & { shopId: string; storeId: number; platform: string; accountIds:number[]; refund: LiveRefund };
/** Orders are identified by shop + external order number, never by number alone. */
export async function captureOrders(source: LiveOrderSource, companyId: number, s: Row, endAt: string) {
  const orders: CapturedOrder[] = [];
  const seen = new Set<string>();
  const lines = [];
  for (const store of channelStores(channelsOf(s))) {
    const shopId = store.jstShopId;
    if (!shopId) throw new Error(`${store.name}没有聚水潭店铺编号`);
    const result = await source.turnoverOrders(companyId, { id: Number(s.id), shopId, startAt: s.start_text, endAt });
    if (!result.available || result.truncated) throw new Error(result.reason || '本场订单查询不完整');
    const batch = result.orders.filter(o => {
      const key = `${shopId}:${o.orderId}`, time = liveFromText(o.orderTime);
      if (!time || +time < +liveFromText(s.start_text)! || +time >= +liveFromText(endAt)! || seen.has(key)) return false;
      seen.add(key); return true;
    });
    const paid = batch.filter(o => o.paid && o.amountCents > 0);
    const refunds = await source.refunds(companyId, shopId, paid);
    for (const o of batch) {
      const refund = o.cancelled ? { cents: o.amountCents, source: 'cancelled' as const, details: [] } : !o.paid ? { cents: 0, source: 'none' as const, details: [] } : refunds.get(o.orderId);
      if (!refund || !Number.isSafeInteger(refund.cents) || refund.cents < 0) throw new Error(`订单 ${o.orderId} 的退款状态未核实`);
      orders.push({ ...o, shopId, storeId: store.id, platform: store.platform, accountIds:channelsOf(s).filter(c=>c.storeIds.includes(store.id)).map(c=>c.accountId), refund });
    }
    const own = orders.filter(o => o.storeId === store.id && o.paid);
    const sales = own.reduce((n, o) => n + Math.max(0, o.amountCents - o.refund.cents), 0);
    lines.push({ storeId: store.id, platform: store.platform, salesCents: sales, adSpendCents: 0, ordersTotalCents: sales, orderIds: own.map(o => o.orderId), verified: true, reason: '' });
  }
  if (!lines.length) throw new Error('本场没有可归集的店铺');
  return { orders, lines, sales: lines.reduce((n, l) => n + l.salesCents, 0) };
}
export async function persistCapture(em: EntityManager, companyId: number, sessionId: number, capture: Awaited<ReturnType<typeof captureOrders>>, at: Date) {
  await em.query('DELETE FROM live_session_order_snapshots WHERE company_id=? AND session_id=?', [companyId, sessionId]);
  for(let offset=0;offset<capture.orders.length;offset+=200){
    const batch=capture.orders.slice(offset,offset+200),pairs=batch.map(()=>'(?,?)').join(','),keys=batch.flatMap(o=>[o.shopId,o.orderId]);
    for(const table of ['live_session_order_snapshots','live_session_orders']){
      const [duplicate]=await em.query(`SELECT order_id FROM ${table} WHERE company_id=? AND session_id<>? AND (shop_id,order_id) IN (${pairs}) LIMIT 1`,[companyId,sessionId,...keys]);
      if(duplicate)throw new Error(`订单 ${duplicate.order_id} 已归属于其他场次，请核对时间范围`);
    }
    await em.query(`INSERT INTO live_session_order_snapshots
      (company_id,session_id,store_id,platform,account_ids_json,shop_id,order_id,inner_order_id,order_at,pay_time,paid,amount_cents,refund_cents,order_status,refund_json,captured_at)
      VALUES ${batch.map(()=>'(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,batch.flatMap(o=>[companyId,sessionId,o.storeId,o.platform,JSON.stringify(o.accountIds),o.shopId,o.orderId,o.innerId||null,o.orderTime,o.payTime,o.paid?1:0,o.amountCents,o.refund.cents,o.status,JSON.stringify(o.refund),wallNow(at)]));
  }
  // A failed checkout may have saved the clock with explicitly pending figures.
  // Once the read recovers, reconcile only those automatic reports, never an operator's manual report.
  const reports:Row[]=await em.query("SELECT * FROM live_session_reports WHERE company_id=? AND session_id=? AND role IN ('anchor','control') AND order_basis_json IS NULL AND manual_actor_id IS NULL",[companyId,sessionId]);
  for(const r of reports){
    const previous=typeof r.store_lines_json==='string'?JSON.parse(r.store_lines_json):r.store_lines_json??[];
    const lines=capture.lines.map(l=>({...l,adSpendCents:previous.find((v:Row)=>Number(v.storeId)===l.storeId)?.adSpendCents??0}));
    await em.query('UPDATE live_session_reports SET sales_cents=?,orders_total_cents=?,order_count=?,store_lines_json=?,order_basis_json=?,revision=revision+1 WHERE company_id=? AND id=?',[capture.sales,capture.sales,capture.orders.length,JSON.stringify(lines),JSON.stringify(capture.orders.map(o=>({shopId:o.shopId,orderId:o.orderId,refundCents:o.refund.cents}))),companyId,r.id]);
  }
  await em.query("UPDATE live_sessions SET orders_capture_status='ready',orders_capture_error=NULL,orders_captured_at=? WHERE company_id=? AND id=?",[wallNow(at),companyId,sessionId]);
}
