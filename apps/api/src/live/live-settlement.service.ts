import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LIVE_ROLE_LABEL, liveBuildSettlement, liveRefundKey, liveToday, liveMonthBounds } from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { FlowService } from '../flow/flow.service';
import { loadLiveAccess, requireManage } from './live-access';
import { LiveOrderSource, type LiveRefund } from './live-order-source';
import { Row, liveClock, liveFail, lockCompany, num, text, wallNow } from './live-core';
import { SETTLEMENT_STATUS } from './live-settlement-core';
import {
  checkOverlap,
  payrollPeriod,
  payrollSources,
  PERIOD_FROM,
  PERIOD_TO,
  sourcesFingerprint,
} from './live-payroll-core';

const SELECT = `SELECT s.*,DATE_FORMAT(s.period_from,'%Y-%m-%d') from_text,DATE_FORMAT(s.period_to,'%Y-%m-%d') to_text,
  DATE_FORMAT(s.refunds_checked_at,'%Y-%m-%d %H:%i:%s') checked_text,DATE_FORMAT(s.submitted_at,'%Y-%m-%d %H:%i:%s') submitted_text,DATE_FORMAT(s.approved_at,'%Y-%m-%d %H:%i:%s') approved_text,u.name creator_name FROM live_settlements s LEFT JOIN users u ON u.company_id=s.company_id AND u.id=s.created_by`;
function head(r: Row) {
  return {
    id: Number(r.id),
    month: r.month,
    from: r.from_text ?? `${r.month}-01`,
    to: r.to_text ?? payrollPeriod(r.month).to,
    status: r.status,
    statusLabel: SETTLEMENT_STATUS[r.status],
    recordCount: Number(r.record_count),
    commissionTotalCents: num(r.commission_total_cents),
    wageTotalCents: num(r.wage_total_cents),
    refundTotalCents: num(r.refund_total_cents),
    deductionTotalCents: num(r.deduction_total_cents),
    payableTotalCents: num(r.payable_total_cents),
    refundsCheckedAt: r.checked_text,
    note: r.note ?? '',
    returnReason: r.return_reason,
    flowRunId: r.flow_run_id ? Number(r.flow_run_id) : null,
    creatorName: r.creator_name,
    submittedAt: r.submitted_text,
    approvedAt: r.approved_text,
    revision: Number(r.revision),
  };
}
@Injectable()
export class LiveSettlementService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly flow: FlowService,
    private readonly source: LiveOrderSource,
  ) {}
  private get em() {
    return this.ds.manager;
  }
  async list(user: AuthUser) {
    const a = await loadLiveAccess(this.em, user);
    if (!a.canManage && !a.canViewAll) liveFail('没有查看工资结算的权限', 403);
    const rows: Row[] = await this.em.query(`${SELECT} WHERE s.company_id=? ORDER BY s.id DESC`, [a.companyId]);
    const today = liveToday(liveClock.now()),
      b = liveMonthBounds(today.slice(0, 7));
    return {
      canManage: a.canManage,
      defaultMonth: Number(today.slice(8, 10)) <= 10 ? b.previousFrom.slice(0, 7) : today.slice(0, 7),
      rows: rows.map(head),
    };
  }
  async detail(user: AuthUser, id: number) {
    const a = await loadLiveAccess(this.em, user);
    if (!a.canManage && !a.canViewAll) liveFail('没有查看工资结算的权限', 403);
    const [row]: Row[] = await this.em.query(`${SELECT} WHERE s.company_id=? AND s.id=?`, [a.companyId, id]);
    if (!row) liveFail('结算单不存在', 404);
    const lines: Row[] = await this.em.query(
      `SELECT l.*,c.platform,c.rule_snapshot,u.name user_name,s.room_name,s.report_source,s.manual_reason,DATE_FORMAT(l.session_date,'%Y-%m-%d') day,DATE_FORMAT(s.start_at,'%H:%i') start_text FROM live_settlement_lines l JOIN live_commission_records c ON c.company_id=l.company_id AND c.id=l.commission_record_id JOIN users u ON u.company_id=l.company_id AND u.id=l.user_id JOIN live_sessions s ON s.company_id=l.company_id AND s.id=l.session_id WHERE l.company_id=? AND l.settlement_id=? ORDER BY l.session_date,l.id`,
      [a.companyId, id],
    );
    const refunds: Row[] = await this.em.query(
      `SELECT *,DATE_FORMAT(checked_at,'%Y-%m-%d %H:%i:%s') checked_text FROM live_settlement_refunds WHERE company_id=? AND settlement_id=? ORDER BY session_id,order_id`,
      [a.companyId, id],
    );
    const byPerson = new Map<string, Row>();
    const counted=new Set<string>();
    for (const l of lines) {
      const key = `${l.user_id}:${l.role}`;
      const p = byPerson.get(key) ?? {
        userId: Number(l.user_id),
        name: l.user_name,
        role: l.role,
        roleLabel: LIVE_ROLE_LABEL[l.role],
        commissionCents: 0,
        wageCents: 0,
        minutes: 0,
        deductionCents: 0,
        payableCents: 0,
        sessions: 0,
      };
      p.commissionCents += num(l.commission_cents);
      p.wageCents += num(l.wage_cents);
      p.minutes += num(l.wage_minutes);
      p.deductionCents += num(l.deduction_cents);
      p.payableCents += num(l.payable_cents);
      const sessionKey=`${key}:${l.session_id}`;if(!counted.has(sessionKey)){p.sessions++;counted.add(sessionKey);}
      byPerson.set(key, p);
    }
    return {
      ...head(row),
      canManage: a.canManage,
      byPerson: [...byPerson.values()],
      lines: lines.map((l) => ({
        platform:l.platform,
        unverifiedStores: (typeof l.rule_snapshot==='string'?JSON.parse(l.rule_snapshot):l.rule_snapshot)?.unverifiedStores??[],
        id: Number(l.id),
        sessionId: Number(l.session_id),
        userId: Number(l.user_id),
        userName: l.user_name,
        role: l.role,
        roleLabel: LIVE_ROLE_LABEL[l.role],
        date: l.day,
        roomName: l.room_name,
        startTime: l.start_text,
        finalSalesCents: num(l.final_sales_cents),
        rateUnits: Number(l.rate_units),
        commissionCents: num(l.commission_cents),
        wageCents: num(l.wage_cents),
        minutes: num(l.wage_minutes),
        hourlyRateCents: num(l.hourly_rate_cents),
        orderCount: Number(l.order_count),
        ordersTotalCents: num(l.orders_total_cents),
        refundCents: num(l.refund_cents),
        deductionCents: num(l.deduction_cents),
        payableCents: num(l.payable_cents),
        source: l.report_source,
        manualReason: l.manual_reason,
      })),
      refunds: refunds.map((r) => ({
        sessionId: Number(r.session_id),
        shopId:r.shop_id,platform:r.platform,
        orderId: r.order_id,
        orderAmountCents: num(r.order_amount_cents),
        refundCents: num(r.refund_cents),
        source: r.refund_source,
        details: typeof r.detail_json === 'string' ? JSON.parse(r.detail_json) : r.detail_json,
        checkedAt: r.checked_text,
      })),
    };
  }
  private hasReviewedUnverifiedStores(record: Row): boolean {
    const snapshot = typeof record.rule_snapshot === 'string' ? JSON.parse(record.rule_snapshot) : record.rule_snapshot;
    const stores = snapshot?.unverifiedStores;
    return Array.isArray(stores) && stores.length > 0 && stores.every(store => typeof store?.reason === 'string' && store.reason.trim());
  }
  async generate(user: AuthUser, monthIn: string, note?: string, range?: { from?: string; to?: string }) {
    const a = await loadLiveAccess(this.em, user);
    requireManage(a);
    const p = payrollPeriod(monthIn, range?.from, range?.to),
      c = a.companyId;
    if (p.from > liveToday(liveClock.now())) liveFail('不能结算还没有开始的日期范围', 400);
    const find = async (em: import('typeorm').EntityManager) => {
      const [r] = await em.query(
        `SELECT id,status FROM live_settlements WHERE company_id=? AND ${PERIOD_FROM}=? AND ${PERIOD_TO}=?`,
        [c, p.from, p.to],
      );
      return r as Row | undefined;
    };
    const existing = await find(this.em);
    if (existing && !['draft', 'returned'].includes(existing.status))
      liveFail(existing.status === 'approved' ? '这个月已经结算完成，不能重新生成' : '结算单正在审批中，不能重新生成');
    await checkOverlap(this.em, c, p.from, p.to, existing?.id);
    const first = await payrollSources(this.em, c, p.from, p.to);
    if (!first.records.length) liveFail('所选范围没有已审核的提成记录，不需要结算');
    for (const w of first.wages)
      if (
        !first.records.some(
          (r) =>
            Number(r.session_id) === Number(w.session_id) &&
            r.role === w.role &&
            Number(r.user_id) === Number(w.user_id),
        )
      )
        liveFail('计时工资缺少对应业绩记录，请先核对');
    for (const r of first.records)
      if (
        num(r.final_sales_cents) > 0 &&
        !first.orders.some((o) => Number(o.session_id) === Number(r.session_id) && (!r.platform || o.platform===r.platform)) &&
        !(r.report_source === 'manual' && text(r.manual_reason)) &&
        !this.hasReviewedUnverifiedStores(r)
      )
        liveFail(`场次 #${r.session_id} 有销售额但没有订单，请人事补报并注明特殊原因后审核`);
    const seen = new Map<string, { shopId: string; orderId: string; amountCents: number }>();
    for (const o of first.orders) {
      const k = liveRefundKey(o.shop_id, o.order_id);
      if (seen.has(k) && seen.get(k)!.amountCents !== num(o.amount_cents)) liveFail('同一订单存在不同金额，请先核对');
      seen.set(k, { shopId: String(o.shop_id), orderId: String(o.order_id), amountCents: num(o.amount_cents) });
    }
    const refunds = new Map<string, LiveRefund>(),
      byShop = new Map<string, Array<{ orderId: string; amountCents: number }>>();
    for (const o of seen.values()) {
      const list = byShop.get(o.shopId) ?? [];
      list.push(o);
      byShop.set(o.shopId, list);
    }
    if (byShop.size) {
      const st = await this.source.status(c);
      if (!st.ready) liveFail(`不能生成结算单：${st.message}`, 409);
    }
    for (const [shopId, list] of byShop) {
      try {
        const got = await this.source.refunds(c, shopId, list);
        for (const o of list) {
          const r = got.get(o.orderId);
          if (!r) throw new Error(`订单 ${o.orderId} 缺少售后结果`);
          refunds.set(liveRefundKey(shopId, o.orderId), r);
        }
      } catch (e) {
        liveFail(`聚水潭店铺 ${shopId} 的退款暂时查不到，没有生成结算单：${(e as Error).message}`);
      }
    }
    const sessionOrders = new Map<number, Array<{ orderId: string; shopId: string; amountCents: number; platform?:string }>>();
    for (const o of first.orders) {
      const list = sessionOrders.get(Number(o.session_id)) ?? [];
      list.push({ orderId: String(o.order_id), shopId: String(o.shop_id), amountCents: num(o.amount_cents),platform:o.platform });
      sessionOrders.set(Number(o.session_id), list);
    }
    const built = liveBuildSettlement(
      first.records.map((r) => ({
        platform:r.platform,
        id: Number(r.id),
        sessionId: Number(r.session_id),
        role: r.role,
        amountCents: num(r.amount_cents),
        rateUnits: Number(r.rate_units),
      })),
      sessionOrders,
      refunds,
    );
    return this.ds.transaction(async (tx) => {
      await lockCompany(tx, c);
      const cur = await find(tx);
      if (cur && !['draft', 'returned'].includes(cur.status)) liveFail('结算状态已变化，请刷新');
      await checkOverlap(tx, c, p.from, p.to, cur?.id);
      const again = await payrollSources(tx, c, p.from, p.to);
      if (sourcesFingerprint(again) !== sourcesFingerprint(first)) liveFail('核对期间收入或订单发生变化，请重新核对');
      const at = wallNow(liveClock.now()),
        t = built.totals,
        wageTotal = first.wages.reduce((n, w) => n + num(w.amount_cents), 0);
      let id: number;
      if (cur) {
        id = Number(cur.id);
        await tx.query('DELETE FROM live_settlement_lines WHERE company_id=? AND settlement_id=?', [c, id]);
        await tx.query('DELETE FROM live_settlement_refunds WHERE company_id=? AND settlement_id=?', [c, id]);
        await tx.query(
          `UPDATE live_settlements SET status='draft',record_count=?,commission_total_cents=?,wage_total_cents=?,refund_total_cents=?,deduction_total_cents=?,payable_total_cents=?,refunds_checked_at=?,note=?,return_reason=NULL,flow_run_id=NULL,period_from=?,period_to=?,updated_by=?,revision=revision+1 WHERE company_id=? AND id=?`,
          [
            t.count,
            t.commissionCents,
            wageTotal,
            t.refundCents,
            t.deductionCents,
            t.payableCents + wageTotal,
            at,
            text(note) || null,
            p.from,
            p.to,
            a.userId,
            c,
            id,
          ],
        );
      } else {
        const ins = await tx.query(
          `INSERT INTO live_settlements(company_id,month,period_from,period_to,record_count,commission_total_cents,wage_total_cents,refund_total_cents,deduction_total_cents,payable_total_cents,refunds_checked_at,note,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            c,
            p.month,
            p.from,
            p.to,
            t.count,
            t.commissionCents,
            wageTotal,
            t.refundCents,
            t.deductionCents,
            t.payableCents + wageTotal,
            at,
            text(note) || null,
            a.userId,
          ],
        );
        id = Number(ins.insertId);
      }
      const usedWages=new Set<number>();
      for (const l of built.lines) {
        const r = first.records.find((r) => Number(r.id) === l.record.id)!;
        const w = first.wages.find(
          (w) =>
            !usedWages.has(Number(w.id)) && Number(w.session_id) === l.record.sessionId && w.role === r.role && Number(w.user_id) === Number(r.user_id),
        );
        if(w)usedWages.add(Number(w.id));
        await tx.query(
          `INSERT INTO live_settlement_lines(company_id,settlement_id,commission_record_id,session_id,user_id,role,session_date,final_sales_cents,rate_units,commission_cents,order_count,orders_total_cents,refund_cents,deduction_cents,payable_cents,wage_record_id,wage_cents,wage_minutes,hourly_rate_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            c,
            id,
            l.record.id,
            l.record.sessionId,
            r.user_id,
            r.role,
            r.day,
            r.final_sales_cents,
            r.rate_units,
            l.commissionCents,
            l.orderCount,
            l.ordersCents,
            l.refundCents,
            l.deductionCents,
            l.payableCents + num(w?.amount_cents),
            w?.id ?? null,
            num(w?.amount_cents),
            num(w?.minutes),
            num(w?.hourly_rate_cents),
          ],
        );
      }
      for (const o of first.orders) {
        const r = refunds.get(liveRefundKey(o.shop_id, o.order_id))!;
        await tx.query(
          `INSERT INTO live_settlement_refunds(company_id,settlement_id,session_id,order_id,order_amount_cents,refund_cents,refund_source,detail_json,checked_at,shop_id,platform) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [c, id, o.session_id, o.order_id, o.amount_cents, r.cents, r.source, JSON.stringify(r.details), at,o.shop_id,o.platform??''],
        );
      }
      return { id };
    });
  }
  async submit(user: AuthUser, id: number) {
    const a = await loadLiveAccess(this.em, user);
    requireManage(a);
    const [r] = await this.em.query('SELECT status,flow_run_id FROM live_settlements WHERE company_id=? AND id=?', [
      a.companyId,
      id,
    ]);
    if (!r) liveFail('结算单不存在', 404);
    if (r.status === 'returned' && r.flow_run_id) {
      const [run] = await this.em.query('SELECT revision FROM flow_runs WHERE company_id=? AND id=?', [
        a.companyId,
        r.flow_run_id,
      ]);
      if (run) {
        const v = await this.flow.resubmit(user, Number(r.flow_run_id), {
          revision: Number(run.revision),
          payload: { settlementId: id },
        });
        return { runId: v.id };
      }
    }
    const v = await this.flow.start(user, 'live-settlement', { settlementId: id }, undefined, { internal: true });
    return { runId: v.id };
  }
}
