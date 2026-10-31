import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LIVE_ROLE_LABEL, liveBuildSettlement, liveIsMonth, liveRefundKey, liveToday } from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { FlowService } from '../flow/flow.service';
import { loadLiveAccess, requireManage } from './live-access';
import { LiveOrderSource, type LiveRefund } from './live-order-source';
import { Row, closedMonth, liveClock, liveFail, lockCompany, num, text, wallNow } from './live-core';
import { SETTLEMENT_STATUS, markSubmitted } from './live-settlement-core';

const HEAD = `SELECT st.*, DATE_FORMAT(st.refunds_checked_at,'%Y-%m-%d %H:%i:%s') checked_text, DATE_FORMAT(st.submitted_at,'%Y-%m-%d %H:%i:%s') submitted_text, DATE_FORMAT(st.approved_at,'%Y-%m-%d %H:%i:%s') approved_text,
  c.name creator_name FROM live_settlements st LEFT JOIN users c ON c.id = st.created_by AND c.company_id = st.company_id`;

const head = (r: Row) => ({
  id: Number(r.id), month: r.month, status: r.status, statusLabel: SETTLEMENT_STATUS[r.status] ?? r.status, recordCount: Number(r.record_count), commissionTotalCents: num(r.commission_total_cents),
  refundTotalCents: num(r.refund_total_cents), deductionTotalCents: num(r.deduction_total_cents), payableTotalCents: num(r.payable_total_cents), refundsCheckedAt: r.checked_text ?? null,
  note: r.note ?? '', returnReason: r.return_reason ?? null, flowRunId: r.flow_run_id ? Number(r.flow_run_id) : null, creatorName: r.creator_name ?? '', submittedAt: r.submitted_text ?? null, approvedAt: r.approved_text ?? null, revision: Number(r.revision),
});

/** 月底提成结算：人事按月生成（只读核对聚水潭退款），提交走流程中心审批，通过后锁定。 */
@Injectable()
export class LiveSettlementService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly flow: FlowService, private readonly source: LiveOrderSource) {}
  private get em() { return this.ds.manager; }

  private async access(user: AuthUser) {
    const a = await loadLiveAccess(this.em, user);
    if (!a.canViewAll && !a.canManage) liveFail('没有查看提成月结的权限', 403);
    return a;
  }

  async list(user: AuthUser) {
    const a = await this.access(user);
    const rows: Row[] = await this.em.query(`${HEAD} WHERE st.company_id = ? ORDER BY st.month DESC LIMIT 60`, [a.companyId]);
    return { canManage: a.canManage, defaultMonth: this.defaultMonth(), rows: rows.map(head) };
  }
  /** 月初 10 天默认结算上个月，其余时间默认本月。 */
  private defaultMonth() {
    const today = liveToday(liveClock.now());
    if (Number(today.slice(8, 10)) > 10) return today.slice(0, 7);
    const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  }

  async detail(user: AuthUser, id: number) {
    const a = await this.access(user);
    const [row] = await this.em.query(`${HEAD} WHERE st.company_id = ? AND st.id = ?`, [a.companyId, id]);
    if (!row) liveFail('结算单不存在', 404);
    const lines: Row[] = await this.em.query(
      `SELECT l.*, DATE_FORMAT(l.session_date,'%Y-%m-%d') day, e.name user_name, s.room_name, DATE_FORMAT(s.start_at,'%H:%i') start_text FROM live_settlement_lines l
         JOIN users e ON e.id = l.user_id AND e.company_id = l.company_id JOIN live_sessions s ON s.id = l.session_id AND s.company_id = l.company_id
        WHERE l.company_id = ? AND l.settlement_id = ? ORDER BY l.session_date, l.session_id, l.id`, [a.companyId, id]);
    const refunds: Row[] = await this.em.query(
      `SELECT r.*, DATE_FORMAT(r.checked_at,'%Y-%m-%d %H:%i:%s') checked_text FROM live_settlement_refunds r WHERE r.company_id = ? AND r.settlement_id = ? AND r.refund_cents > 0 ORDER BY r.session_id, r.order_id`, [a.companyId, id]);
    const byPerson = new Map<string, { userId: number; name: string; role: string; roleLabel: string; commissionCents: number; deductionCents: number; payableCents: number; sessions: number }>();
    for (const l of lines) {
      const key = `${l.user_id}:${l.role}`;
      const p = byPerson.get(key) ?? { userId: Number(l.user_id), name: l.user_name, role: l.role, roleLabel: LIVE_ROLE_LABEL[l.role], commissionCents: 0, deductionCents: 0, payableCents: 0, sessions: 0 };
      p.commissionCents += num(l.commission_cents); p.deductionCents += num(l.deduction_cents); p.payableCents += num(l.payable_cents); p.sessions += 1; byPerson.set(key, p);
    }
    return {
      ...head(row), canManage: a.canManage, byPerson: [...byPerson.values()],
      lines: lines.map((l) => ({ id: Number(l.id), sessionId: Number(l.session_id), userId: Number(l.user_id), userName: l.user_name, role: l.role, roleLabel: LIVE_ROLE_LABEL[l.role], date: l.day, roomName: l.room_name, startTime: l.start_text,
        finalSalesCents: num(l.final_sales_cents), rateUnits: Number(l.rate_units), commissionCents: num(l.commission_cents), orderCount: Number(l.order_count), ordersTotalCents: num(l.orders_total_cents), refundCents: num(l.refund_cents), deductionCents: num(l.deduction_cents), payableCents: num(l.payable_cents) })),
      refunds: refunds.map((r) => ({ sessionId: Number(r.session_id), orderId: r.order_id, orderAmountCents: num(r.order_amount_cents), refundCents: num(r.refund_cents), source: r.refund_source, details: typeof r.detail_json === 'string' ? JSON.parse(r.detail_json) : r.detail_json, checkedAt: r.checked_text })),
    };
  }

  /** 生成（或重新核对）某月的结算单：所有场次必须已审核；退款只读核对聚水潭，任一店铺查不到就不生成。 */
  async generate(user: AuthUser, monthIn: string, note?: string) {
    const a = await loadLiveAccess(this.em, user); requireManage(a);
    if (!liveIsMonth(monthIn)) liveFail('请选择结算月份', 400);
    const month = monthIn;
    if (month > liveToday(liveClock.now()).slice(0, 7)) liveFail('不能结算还没有开始的月份', 400);
    const c = a.companyId, em = this.em;
    const [existing] = await em.query('SELECT id, status FROM live_settlements WHERE company_id = ? AND month = ?', [c, month]);
    if (existing && !['draft', 'returned'].includes(existing.status)) liveFail(existing.status === 'approved' ? '这个月已经结算完成，不能重新生成' : '这个月的结算单正在审批中，退回后才能重新核对');
    const gather = async () => {
      const unfinished: Row[] = await em.query("SELECT id FROM live_sessions WHERE company_id = ? AND DATE_FORMAT(session_date,'%Y-%m') = ? AND status <> 'approved' LIMIT 1", [c, month]);
      if (unfinished.length) liveFail('本月还有场次没有审核完成（直播中、待提交、待审核或已退回），请先处理完再生成结算单');
      const records: Row[] = await em.query("SELECT id, session_id, user_id, role, session_date, final_sales_cents, rate_units, amount_cents FROM live_commission_records WHERE company_id = ? AND DATE_FORMAT(session_date,'%Y-%m') = ? ORDER BY id", [c, month]);
      if (!records.length) liveFail('本月没有已审核的提成记录，不需要结算');
      const ids = [...new Set(records.map((r) => Number(r.session_id)))];
      const orders: Row[] = await em.query(`SELECT DISTINCT session_id, order_id, shop_id, amount_cents FROM live_session_orders WHERE company_id = ? AND session_id IN (${ids.map(() => '?').join(',')}) ORDER BY session_id, order_id`, [c, ...ids]);
      return { records, ids, orders };
    };
    const first = await gather();
    // 正销售额必须有保存的订单（用来核对退款）；没有的历史场次直接拒绝
    for (const r of first.records) {
      if (num(r.final_sales_cents) > 0 && !first.orders.some((o) => Number(o.session_id) === Number(r.session_id))) liveFail(`场次 #${r.session_id} 有销售额但没有保存勾选订单，无法核对退款，请联系管理员补录`);
    }
    // 去重后按聚水潭店铺逐个只读查询退款（一个订单可能被主播、中控都勾选）
    const seen = new Map<string, { shopId: string; orderId: string; amountCents: number }>();
    for (const o of first.orders) { const k = liveRefundKey(o.shop_id, o.order_id); if (!seen.has(k)) seen.set(k, { shopId: String(o.shop_id), orderId: String(o.order_id), amountCents: num(o.amount_cents) }); }
    const byShop = new Map<string, Array<{ orderId: string; amountCents: number }>>();
    for (const o of seen.values()) { const l = byShop.get(o.shopId) ?? []; l.push(o); byShop.set(o.shopId, l); }
    const refunds = new Map<string, LiveRefund>();
    if (byShop.size) { const st = await this.source.status(c); if (!st.ready) liveFail(`不能生成结算单：${st.message}`, 409); }
    for (const [shopId, list] of byShop) {
      try { for (const [orderId, r] of await this.source.refunds(c, shopId, list)) refunds.set(liveRefundKey(shopId, orderId), r); }
      catch (e) { liveFail(`聚水潭店铺 ${shopId} 的退款暂时查不到，没有生成结算单：${(e as Error).message}`); }
      for (const o of list) if (!refunds.has(liveRefundKey(shopId, o.orderId))) liveFail(`聚水潭店铺 ${shopId} 的订单 ${o.orderId} 没有查到退款结果，没有生成结算单`);
    }
    const sessionOrders = new Map<number, Array<{ orderId: string; shopId: string; amountCents: number }>>();
    for (const o of first.orders) { const l = sessionOrders.get(Number(o.session_id)) ?? []; l.push({ orderId: String(o.order_id), shopId: String(o.shop_id), amountCents: num(o.amount_cents) }); sessionOrders.set(Number(o.session_id), l); }
    const built = liveBuildSettlement(first.records.map((r) => ({ id: Number(r.id), sessionId: Number(r.session_id), role: r.role, amountCents: num(r.amount_cents), rateUnits: Number(r.rate_units) })), sessionOrders, refunds);
    const now = wallNow(liveClock.now());
    const id = await this.ds.transaction(async (tx) => {
      await lockCompany(tx, c);
      if (await closedMonth(tx, c, month, true)) liveFail('这个月的结算单已提交或已结算，不能重新生成');
      const again = await gatherIn(tx, c, month);
      if (again.length !== first.records.length || again.some((v, i) => v !== Number(first.records[i].id))) liveFail('核对期间本月提成记录有变化，请重新生成');
      let sid: number;
      const [cur] = await tx.query('SELECT id, status FROM live_settlements WHERE company_id = ? AND month = ? FOR UPDATE', [c, month]);
      const t = built.totals;
      if (cur) {
        sid = Number(cur.id);
        await tx.query('DELETE FROM live_settlement_lines WHERE company_id = ? AND settlement_id = ?', [c, sid]);
        await tx.query('DELETE FROM live_settlement_refunds WHERE company_id = ? AND settlement_id = ?', [c, sid]);
        await tx.query(`UPDATE live_settlements SET status = 'draft', record_count = ?, commission_total_cents = ?, refund_total_cents = ?, deduction_total_cents = ?, payable_total_cents = ?, refunds_checked_at = ?,
          note = ?, return_reason = NULL, flow_run_id = NULL, updated_by = ?, revision = revision + 1 WHERE company_id = ? AND id = ?`, [t.count, t.commissionCents, t.refundCents, t.deductionCents, t.payableCents, now, text(note) || null, a.userId, c, sid]);
      } else {
        const ins = await tx.query(`INSERT INTO live_settlements (company_id, month, status, record_count, commission_total_cents, refund_total_cents, deduction_total_cents, payable_total_cents, refunds_checked_at, note, created_by)
          VALUES (?,?,'draft',?,?,?,?,?,?,?,?)`, [c, month, t.count, t.commissionCents, t.refundCents, t.deductionCents, t.payableCents, now, text(note) || null, a.userId]);
        sid = Number(ins.insertId);
      }
      for (const l of built.lines) {
        await tx.query(`INSERT INTO live_settlement_lines (company_id, settlement_id, commission_record_id, session_id, user_id, role, session_date, final_sales_cents, rate_units, commission_cents, order_count, orders_total_cents, refund_cents, deduction_cents, payable_cents)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [c, sid, l.record.id, l.record.sessionId, first.records.find((r) => Number(r.id) === l.record.id)!.user_id, l.record.role, first.records.find((r) => Number(r.id) === l.record.id)!.session_date, num(first.records.find((r) => Number(r.id) === l.record.id)!.final_sales_cents), l.record.rateUnits, l.commissionCents, l.orderCount, l.ordersCents, l.refundCents, l.deductionCents, l.payableCents]);
      }
      for (const o of first.orders) {
        const r = refunds.get(liveRefundKey(o.shop_id, o.order_id))!;
        await tx.query('INSERT INTO live_settlement_refunds (company_id, settlement_id, session_id, order_id, order_amount_cents, refund_cents, refund_source, detail_json, checked_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [c, sid, o.session_id, o.order_id, num(o.amount_cents), r.cents, r.source, JSON.stringify(r.details ?? []), now]);
      }
      return sid;
    });
    return { id };
  }

  /** 提交月结审批（走流程中心「直播提成月结审批」）；被退回的单重新提交。 */
  async submit(user: AuthUser, id: number) {
    const a = await loadLiveAccess(this.em, user); requireManage(a);
    const [row] = await this.em.query('SELECT status, flow_run_id FROM live_settlements WHERE company_id = ? AND id = ?', [a.companyId, id]);
    if (!row) liveFail('结算单不存在', 404);
    if (row.status === 'returned' && row.flow_run_id) {
      const [run] = await this.em.query('SELECT revision FROM flow_runs WHERE company_id = ? AND id = ?', [a.companyId, row.flow_run_id]);
      if (run) { const r = await this.flow.resubmit(user, Number(row.flow_run_id), { revision: Number(run.revision), payload: { settlementId: id } }); return { runId: r.id }; }
    }
    const detail = await this.flow.start(user, 'live-settlement', { settlementId: id }, undefined, { internal: true });
    return { runId: detail.id };
  }
}

async function gatherIn(em: import('typeorm').EntityManager, companyId: number, month: string): Promise<number[]> {
  const rows: Row[] = await em.query("SELECT id FROM live_commission_records WHERE company_id = ? AND DATE_FORMAT(session_date,'%Y-%m') = ? ORDER BY id", [companyId, month]);
  const pending: Row[] = await em.query("SELECT id FROM live_sessions WHERE company_id = ? AND DATE_FORMAT(session_date,'%Y-%m') = ? AND status <> 'approved' LIMIT 1", [companyId, month]);
  if (pending.length) liveFail('核对期间本月出现了未审核的场次，请重新生成');
  return rows.map((r) => Number(r.id));
}
