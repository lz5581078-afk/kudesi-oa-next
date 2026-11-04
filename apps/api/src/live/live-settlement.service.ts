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
  scopedPayrollSources, scopeOf, assertCommissionDate, type SettlementScope,
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
    legacy: !r.source_fingerprint&&!r.original_settlement_id,
    originalSettlementId: r.original_settlement_id?Number(r.original_settlement_id):null,
    kind: r.settlement_kind ?? 'mixed', userIds: scopeOf(r).userIds,
    paidTotalCents: num(r.paid_total_cents), voidReason: r.void_reason,
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
    const people: Row[] = await this.em.query(`SELECT DISTINCT u.id,u.name FROM users u WHERE u.company_id=? AND (u.status='active' OR EXISTS(SELECT 1 FROM live_wage_records w WHERE w.company_id=u.company_id AND w.user_id=u.id) OR EXISTS(SELECT 1 FROM live_commission_records r WHERE r.company_id=u.company_id AND r.user_id=u.id)) ORDER BY u.id`,[a.companyId]);
    return {
      people: people.map(p=>({id:Number(p.id),name:p.name})),
      canManage: a.canManage,
      defaultMonth: b.previousFrom.slice(0, 7),
      rows: rows.map(head),
    };
  }
  async detail(user: AuthUser, id: number) {
    const a = await loadLiveAccess(this.em, user);
    if (!a.canManage && !a.canViewAll) liveFail('没有查看工资结算的权限', 403);
    const [row]: Row[] = await this.em.query(`${SELECT} WHERE s.company_id=? AND s.id=?`, [a.companyId, id]);
    if (!row) liveFail('结算单不存在', 404);
    const lines: Row[] = await this.em.query(
      `SELECT l.*,c.platform,c.rule_snapshot,u.name user_name,COALESCE(s.room_name,'直播办公室 · 日常工作') room_name,s.report_source,s.manual_reason,DATE_FORMAT(l.session_date,'%Y-%m-%d') day,DATE_FORMAT(COALESCE(s.start_at,dw.actual_start),'%H:%i') start_text FROM live_settlement_lines l LEFT JOIN live_commission_records c ON c.company_id=l.company_id AND c.id=l.commission_record_id JOIN users u ON u.company_id=l.company_id AND u.id=l.user_id LEFT JOIN live_sessions s ON s.company_id=l.company_id AND s.id=l.session_id LEFT JOIN live_daily_work dw ON dw.company_id=l.company_id AND dw.id=l.daily_work_id WHERE l.company_id=? AND l.settlement_id=? ORDER BY l.session_date,l.id`,
      [a.companyId, id],
    );
    const refunds: Row[] = await this.em.query(
      `SELECT *,DATE_FORMAT(checked_at,'%Y-%m-%d %H:%i:%s') checked_text FROM live_settlement_refunds WHERE company_id=? AND settlement_id=? ORDER BY session_id,order_id`,
      [a.companyId, id],
    );
    for (const l of lines) {
      const snap = typeof l.display_snapshot==='string'?JSON.parse(l.display_snapshot):l.display_snapshot;
      if(snap) Object.assign(l,snap);
    }
    const events: Row[] = await this.em.query("SELECT e.*,u.name actor_name,DATE_FORMAT(e.created_at,'%Y-%m-%d %H:%i:%s') at FROM live_settlement_events e JOIN users u ON u.company_id=e.company_id AND u.id=e.actor_id WHERE e.company_id=? AND e.settlement_id=? ORDER BY e.id",[a.companyId,id]);
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
      const sessionKey=`${key}:${l.session_id}`;if(l.session_id&&!counted.has(sessionKey)){p.sessions++;counted.add(sessionKey);}
      byPerson.set(key, p);
    }
    return {
      ...head(row),
      adjustments:await this.em.query('SELECT id,status,payable_total_cents amountCents,note FROM live_settlements WHERE company_id=? AND original_settlement_id=? ORDER BY id',[a.companyId,id]),
      events:events.map(e=>{const detail=typeof e.detail_json==='string'?JSON.parse(e.detail_json):e.detail_json;const {sourceFingerprint,...visible}=detail;return {...e,detail_json:visible};}), excluded: typeof row.excluded_json==='string'?JSON.parse(row.excluded_json):row.excluded_json??[],
      canManage: a.canManage,
      byPerson: [...byPerson.values()],
      lines: lines.map((l) => ({
        platform:l.platform,
        unverifiedStores: (typeof l.rule_snapshot==='string'?JSON.parse(l.rule_snapshot):l.rule_snapshot)?.unverifiedStores??[],
        id: Number(l.id),
        sessionId: Number(l.session_id), dailyWorkId:l.daily_work_id?Number(l.daily_work_id):null,
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
  async preview(user:AuthUser,input:{month?:string;from?:string;to?:string}&SettlementScope){
    const a=await loadLiveAccess(this.em,user);requireManage(a);
    const p=payrollPeriod(input.month,input.from,input.to);
    const sources=await scopedPayrollSources(this.em,a.companyId,p.from,p.to,{kind:input.kind??'wage',userIds:input.userIds});
    const lines=[...sources.records.map(r=>({kind:'commission',userId:Number(r.user_id),sessionId:Number(r.session_id),date:r.day,amountCents:num(r.amount_cents)})),...sources.wages.map(r=>({kind:'wage',userId:Number(r.user_id),sessionId:Number(r.session_id),date:r.day,amountCents:num(r.amount_cents)})),...sources.dailyWork.map(r=>({kind:'wage',userId:Number(r.user_id),sessionId:null,date:r.day,amountCents:num(r.amount_cents)}))];
    return {lines,excluded:sources.excluded};
  }
  async generate(user: AuthUser, monthIn: string, note?: string, range?: { from?: string; to?: string } & SettlementScope) {
    const a = await loadLiveAccess(this.em, user);
    requireManage(a);
    const p = payrollPeriod(monthIn, range?.from, range?.to),
      c = a.companyId;
    if (p.from > liveToday(liveClock.now())) liveFail('不能结算还没有开始的日期范围', 400);
    const modern = !!range?.kind;
    const scope: SettlementScope = {kind:range?.kind??'mixed',userIds:[...new Set(range?.userIds??[])].sort((a,b)=>a-b),settlementId:range?.settlementId};
    if(!['wage','commission','mixed'].includes(scope.kind!)) liveFail('结算类型无效',400);
    const scopeKey = `${scope.kind}:${scope.userIds!.join(',')}`;
    const find = async (em: import('typeorm').EntityManager) => {
      const [r] = await em.query(
        `SELECT id,status FROM live_settlements WHERE company_id=? AND ${PERIOD_FROM}=? AND ${PERIOD_TO}=? AND scope_key=?${scope.settlementId?' AND id=?':modern?" AND status IN ('draft','returned')":''} ORDER BY id DESC LIMIT 1`,
        [c, p.from, p.to,modern?scopeKey:'legacy',...(scope.settlementId?[scope.settlementId]:[])],
      );
      return r as Row | undefined;
    };
    const existing = await find(this.em);
    if(scope.settlementId && !existing) liveFail('结算单不存在或结算范围已变化',409);
    scope.settlementId=existing?Number(existing.id):undefined;
    if (existing && !['draft', 'returned'].includes(existing.status))
      liveFail(existing.status === 'approved' ? '这个月已经结算完成，不能重新生成' : '结算单正在审批中，不能重新生成');
    if(!modern) await checkOverlap(this.em, c, p.from, p.to, existing?.id);
    const first = modern ? await scopedPayrollSources(this.em,c,p.from,p.to,scope) : await payrollSources(this.em, c, p.from, p.to);
    assertCommissionDate(first.records.map(r=>r.day),liveClock.now());
    if (!first.records.length && !first.dailyWork.length && !first.wages.length) liveFail('所选范围没有已审核的提成记录或可结算工资；可能已被占用、未到次月10日或尚未审核');
    for (const w of modern ? [] : first.wages)
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
    const incrementalRefunds=new Map(refunds);
    for(const o of first.orders){const key=liveRefundKey(o.shop_id,o.order_id),r=refunds.get(key);if(r&&o.baseline_refund_cents)incrementalRefunds.set(key,{...r,cents:Math.max(0,r.cents-num(o.baseline_refund_cents))});}
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
      incrementalRefunds,
    );
    return this.ds.transaction(async (tx) => {
      await lockCompany(tx, c);
      const cur = await find(tx);
      if (cur && !['draft', 'returned'].includes(cur.status)) liveFail('结算状态已变化，请刷新');
      if(!modern) await checkOverlap(tx, c, p.from, p.to, cur?.id);
      const again = modern ? await scopedPayrollSources(tx,c,p.from,p.to,{...scope,settlementId:cur?Number(cur.id):undefined}) : await payrollSources(tx, c, p.from, p.to);
      if (sourcesFingerprint(again) !== sourcesFingerprint(first)) liveFail('核对期间收入或订单发生变化，请重新核对');
      const at = wallNow(liveClock.now()),
        t = built.totals,
        wageTotal = [...first.wages,...first.dailyWork].reduce((n, w) => n + num(w.amount_cents), 0);
      let id: number;
      if (cur) {
        id = Number(cur.id);
        await tx.query('DELETE FROM live_settlement_lines WHERE company_id=? AND settlement_id=?', [c, id]);
        await tx.query('DELETE FROM live_settlement_refunds WHERE company_id=? AND settlement_id=?', [c, id]);
        await tx.query(
          `UPDATE live_settlements SET status=IF(flow_run_id IS NULL,'draft','returned'),record_count=?,commission_total_cents=?,wage_total_cents=?,refund_total_cents=?,deduction_total_cents=?,payable_total_cents=?,refunds_checked_at=?,note=?,return_reason=NULL,period_from=?,period_to=?,updated_by=?,revision=revision+1 WHERE company_id=? AND id=?`,
          [
            t.count + first.dailyWork.length,
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
          `INSERT INTO live_settlements(company_id,month,period_from,period_to,record_count,commission_total_cents,wage_total_cents,refund_total_cents,deduction_total_cents,payable_total_cents,refunds_checked_at,note,created_by,scope_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            c,
            p.month,
            p.from,
            p.to,
            t.count + first.dailyWork.length,
            t.commissionCents,
            wageTotal,
            t.refundCents,
            t.deductionCents,
            t.payableCents + wageTotal,
            at,
            text(note) || null,
            a.userId,
            modern?scopeKey:'legacy',
          ],
        );
        id = Number(ins.insertId);
      }
      const usedWages=new Set<number>();
      for (const l of built.lines) {
        const r = first.records.find((r) => Number(r.id) === l.record.id)!;
        const w = (modern ? [] : first.wages).find(
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
      if(modern) for(const w of first.wages) await tx.query(`INSERT INTO live_settlement_lines(company_id,settlement_id,commission_record_id,session_id,user_id,role,session_date,final_sales_cents,rate_units,commission_cents,payable_cents,wage_record_id,wage_cents,wage_minutes,hourly_rate_cents) VALUES(?,?,NULL,?,?,?,?,0,0,0,?,?,?,?,?)`,[c,id,w.session_id,w.user_id,w.role,w.day,w.amount_cents,w.id,w.amount_cents,w.minutes,w.hourly_rate_cents]);
      for(const work of first.dailyWork)await tx.query(`INSERT INTO live_settlement_lines(company_id,settlement_id,daily_work_id,commission_record_id,session_id,user_id,role,session_date,final_sales_cents,rate_units,commission_cents,payable_cents,wage_cents,wage_minutes,hourly_rate_cents) VALUES(?,?,?,NULL,NULL,?,?,?,0,0,0,?,?,?,?)`,[c,id,work.id,work.user_id,work.role,work.day,work.amount_cents,work.amount_cents,work.approved_minutes??work.minutes,work.hourly_rate_cents]);
      for (const o of first.orders) {
        const r = refunds.get(liveRefundKey(o.shop_id, o.order_id))!;
        await tx.query(
          `INSERT INTO live_settlement_refunds(company_id,settlement_id,session_id,order_id,order_amount_cents,refund_cents,refund_source,detail_json,checked_at,shop_id,platform) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [c, id, o.session_id, o.order_id, o.amount_cents, r.cents, r.source, JSON.stringify(o.baseline_refund_cents===undefined?r.details:{refunds:r.details,alreadyExcludedRefundCents:num(o.baseline_refund_cents),newRefundCents:Math.max(0,r.cents-num(o.baseline_refund_cents))}), at,o.shop_id,o.platform??''],
        );
      }
      if(modern) {
        await tx.query('UPDATE live_settlements SET settlement_kind=?,user_ids=?,scope_key=?,source_fingerprint=?,excluded_json=?,record_count=? WHERE company_id=? AND id=?',[scope.kind,JSON.stringify(scope.userIds),scopeKey,JSON.stringify({records:first.records,wages:first.wages,dailyWork:first.dailyWork,orders:first.orders}),JSON.stringify('excluded' in first?first.excluded:[]),first.records.length+first.wages.length+first.dailyWork.length,c,id]);
      }
      const display: Row[] = await tx.query(`SELECT l.id,u.name user_name,COALESCE(s.room_name,'直播办公室 · 日常工作') room_name,c.platform,c.rule_snapshot,s.report_source,s.manual_reason FROM live_settlement_lines l JOIN users u ON u.company_id=l.company_id AND u.id=l.user_id LEFT JOIN live_sessions s ON s.company_id=l.company_id AND s.id=l.session_id LEFT JOIN live_commission_records c ON c.company_id=l.company_id AND c.id=l.commission_record_id WHERE l.company_id=? AND l.settlement_id=?`,[c,id]);
      for(const l of display){const {id:lineId,...snap}=l;await tx.query('UPDATE live_settlement_lines SET display_snapshot=? WHERE company_id=? AND id=?',[JSON.stringify(snap),c,lineId]);}
      await tx.query(`INSERT INTO live_settlement_events(company_id,settlement_id,event_type,actor_id,detail_json) VALUES(?,?,'recheck',?,?)`,[c,id,a.userId,JSON.stringify({revision:cur?'regenerated':'created',totalCents:t.payableCents+wageTotal,sourceFingerprint:JSON.stringify({records:first.records,wages:first.wages,dailyWork:first.dailyWork,orders:first.orders})})]);
      return { id };
    });
  }
  private async verifyRefunds(c:number,id:number,row:Row){
    const p=payrollPeriod(row.month,row.period_from??undefined,row.period_to??undefined);
    const sources=row.source_fingerprint?await scopedPayrollSources(this.em,c,p.from,p.to,scopeOf(row)):await payrollSources(this.em,c,p.from,p.to);
    const saved:Row[]=await this.em.query('SELECT * FROM live_settlement_refunds WHERE company_id=? AND settlement_id=?',[c,id]);
    for(const shop of new Set(sources.orders.map(o=>String(o.shop_id)))){
      const orders=sources.orders.filter(o=>String(o.shop_id)===shop);
      let got:Map<string,LiveRefund>;
      try{got=await this.source.refunds(c,shop,orders.map(o=>({orderId:String(o.order_id),amountCents:num(o.amount_cents)})));}catch(e){liveFail(`退款复核失败，不能提交发放：${(e as Error).message}`,409);}
      for(const o of orders){const r=got!.get(String(o.order_id)),old=saved.find(v=>Number(v.session_id)===Number(o.session_id)&&v.shop_id===shop&&v.order_id===o.order_id);if(!r||!old||num(old.refund_cents)!==r.cents)liveFail('本期订单退款已变化，请重新生成结算单并核对金额后提交',409);}
    }
    await this.em.query('UPDATE live_settlements SET refunds_checked_at=? WHERE company_id=? AND id=?',[wallNow(liveClock.now()),c,id]);
  }
  async submit(user: AuthUser, id: number, expectedRevision?:number) {
    const a = await loadLiveAccess(this.em, user);
    requireManage(a);
    const [r] = await this.em.query("SELECT *,DATE_FORMAT(period_from,'%Y-%m-%d') period_from,DATE_FORMAT(period_to,'%Y-%m-%d') period_to FROM live_settlements WHERE company_id=? AND id=?", [
      a.companyId,
      id,
    ]);
    if (!r) liveFail('结算单不存在', 404);
    if(expectedRevision!==undefined&&Number(r.revision)!==expectedRevision)liveFail('结算单已重新核对，请刷新确认最新金额后提交',409);
    const settlementRevision=expectedRevision??Number(r.revision);
    if(!['draft','returned'].includes(r.status)) liveFail('结算单当前不能提交',409);
    if(!r.original_settlement_id)await this.verifyRefunds(a.companyId,id,r);
    if (r.status === 'returned' && r.flow_run_id) {
      const [run] = await this.em.query('SELECT revision FROM flow_runs WHERE company_id=? AND id=?', [
        a.companyId,
        r.flow_run_id,
      ]);
      if (run) {
        const v = await this.flow.resubmit(user, Number(r.flow_run_id), {
          revision: Number(run.revision),
          payload: { settlementId: id,settlementRevision },
        });
        return { runId: v.id };
      }
    }
    const v = await this.flow.start(user, 'live-settlement', { settlementId: id,settlementRevision }, undefined, { internal: true });
    return { runId: v.id };
  }
  async adjustment(user:AuthUser,id:number,input:{lineId:number;amountCents:number;reference:string;reason:string;kind?:'wage'|'commission'}) {
    const a=await loadLiveAccess(this.em,user);requireManage(a);
    if(!Number.isSafeInteger(input.amountCents)||input.amountCents===0||Math.abs(input.amountCents)>10_000_000_000||!text(input.reason)||!text(input.reference))liveFail('请填写非零调整金额、业务凭证编号和原因',400);
    return this.ds.transaction(async tx=>{
      await lockCompany(tx,a.companyId);
      const [original]:Row[]=await tx.query("SELECT l.*,s.status,s.settlement_kind,s.month,s.id original_settlement_id FROM live_settlement_lines l JOIN live_settlements s ON s.company_id=l.company_id AND s.id=l.settlement_id WHERE l.company_id=? AND l.settlement_id=? AND l.id=? FOR UPDATE",[a.companyId,id,input.lineId]);
      if(!original||original.status!=='approved'||original.original_line_id)liveFail('只能调整已确认结算单的原始明细',409);
      const adjustmentKind=input.kind??(original.commission_record_id?'commission':'wage');
      const cap=adjustmentKind==='commission'?num(original.commission_cents)-num(original.deduction_cents):num(original.wage_cents);
      if(adjustmentKind==='commission'&&!original.commission_record_id||adjustmentKind==='wage'&&!original.wage_record_id&&!original.daily_work_id)liveFail('原明细不包含该费用类型',400);
      const correctionKey=`${input.lineId}:${text(input.reference)}`;
      const [dup]:Row[]=await tx.query('SELECT id,payable_total_cents,note,source_fingerprint FROM live_settlements WHERE company_id=? AND correction_key=?',[a.companyId,correctionKey]);
      if(dup){if(num(dup.payable_total_cents)!==input.amountCents||dup.note!==text(input.reason)||JSON.parse(dup.source_fingerprint).kind!==adjustmentKind)liveFail('同一业务凭证已登记不同调整，请核对',409);return {id:Number(dup.id)};}
      if(input.amountCents<0){
        const [prior]:Row[]=await tx.query("SELECT COALESCE(SUM(l.payable_cents),0) amount FROM live_settlement_lines l JOIN live_settlements s ON s.company_id=l.company_id AND s.id=l.settlement_id WHERE l.company_id=? AND l.original_line_id=? AND l.payable_cents<0 AND s.status<>'voided' AND JSON_UNQUOTE(JSON_EXTRACT(s.source_fingerprint,'$.kind'))=?",[a.companyId,input.lineId,adjustmentKind]);
        if(-input.amountCents-num(prior.amount)>cap)liveFail('累计追扣不能超过该明细原应付金额',409);
      }
      const today=liveToday(liveClock.now()),period=payrollPeriod(today.slice(0,7),today,today);
      const snap=JSON.stringify({kind:adjustmentKind,originalLineId:input.lineId,reference:text(input.reference),reason:text(input.reason),amountCents:input.amountCents});
      const ins=await tx.query("INSERT INTO live_settlements(company_id,month,period_from,period_to,settlement_kind,scope_key,user_ids,source_fingerprint,record_count,payable_total_cents,note,created_by,original_settlement_id,correction_key) VALUES(?,?,?,?,'adjustment','adjustment',?,?,1,?,?,?,?,?)",[a.companyId,period.month,today,today,JSON.stringify([Number(original.user_id)]),snap,input.amountCents,text(input.reason),a.userId,id,correctionKey]);
      const adjustmentId=Number(ins.insertId);
      await tx.query('INSERT INTO live_settlement_lines(company_id,settlement_id,original_line_id,session_id,user_id,role,session_date,final_sales_cents,rate_units,commission_cents,payable_cents,display_snapshot) VALUES(?,?,?,?,?,?,?,0,0,0,?,?)',[a.companyId,adjustmentId,input.lineId,original.session_id,original.user_id,original.role,original.session_date,input.amountCents,original.display_snapshot?typeof original.display_snapshot==='string'?original.display_snapshot:JSON.stringify(original.display_snapshot):null]);
      await tx.query("INSERT INTO live_settlement_events(company_id,settlement_id,event_type,actor_id,detail_json) VALUES(?,?,'adjustment',?,?)",[a.companyId,adjustmentId,a.userId,snap]);
      return {id:adjustmentId};
    });
  }
  async payment(user:AuthUser,id:number,input:{userId:number;amountCents:number;requestKey:string;reference:string;note?:string}) {
    const a=await loadLiveAccess(this.em,user);requireManage(a);
    if(!Number.isSafeInteger(input.amountCents)||input.amountCents===0||Math.abs(input.amountCents)>10_000_000_000||!text(input.reference)||!text(input.requestKey)) liveFail('请填写付款金额和凭证编号',400);
    return this.ds.transaction(async tx=>{
      await lockCompany(tx,a.companyId);
      const [row]:Row[]=await tx.query('SELECT * FROM live_settlements WHERE company_id=? AND id=? FOR UPDATE',[a.companyId,id]);
      if(!row||row.status!=='approved') liveFail('只能登记已结算单的付款',409);
      const [dup]:Row[]=await tx.query('SELECT * FROM live_settlement_events WHERE company_id=? AND request_key=?',[a.companyId,input.requestKey]);
      if(dup){if(Number(dup.settlement_id)!==id||Number(dup.user_id)!==input.userId||num(dup.amount_cents)!==input.amountCents||JSON.parse(typeof dup.detail_json==='string'?dup.detail_json:JSON.stringify(dup.detail_json)).reference!==text(input.reference))liveFail('付款请求编号已被其他操作使用',409);return {id:Number(dup.id)};}
      const [sameReference]:Row[]=await tx.query('SELECT id FROM live_settlement_events WHERE company_id=? AND business_key=?',[a.companyId,`${input.userId}:${text(input.reference)}`]);
      if(sameReference)liveFail('该人员的付款凭证已经登记，不能重复记账',409);
      const [due]:Row[]=await tx.query('SELECT COALESCE(SUM(payable_cents),0) amount FROM live_settlement_lines WHERE company_id=? AND settlement_id=? AND user_id=?',[a.companyId,id,input.userId]);
      const [paid]:Row[]=await tx.query("SELECT COALESCE(SUM(amount_cents),0) amount FROM live_settlement_events WHERE company_id=? AND settlement_id=? AND user_id=? AND event_type='payment'",[a.companyId,id,input.userId]);
      const remaining=num(due.amount)-num(paid.amount);
      if(!remaining||Math.sign(input.amountCents)!==Math.sign(remaining)||Math.abs(input.amountCents)>Math.abs(remaining))liveFail('付款或追回金额超过该人员剩余应付/应追回金额',409);
      const event=await tx.query("INSERT INTO live_settlement_events(company_id,settlement_id,event_type,actor_id,user_id,amount_cents,request_key,business_key,detail_json) VALUES(?,?,'payment',?,?,?,?,?,?)",[a.companyId,id,a.userId,input.userId,input.amountCents,input.requestKey,`${input.userId}:${text(input.reference)}`,JSON.stringify({reference:text(input.reference),note:text(input.note)})]);
      await tx.query('UPDATE live_settlements SET paid_total_cents=paid_total_cents+?,revision=revision+1 WHERE company_id=? AND id=?',[input.amountCents,a.companyId,id]);
      return {id:Number(event.insertId)};
    });
  }
  async void(user:AuthUser,id:number,reason:string) {
    const a=await loadLiveAccess(this.em,user);requireManage(a);
    if(!text(reason))liveFail('必须填写作废原因',400);
    return this.ds.transaction(async tx=>{
      await lockCompany(tx,a.companyId);
      const [r]:Row[]=await tx.query('SELECT * FROM live_settlements WHERE company_id=? AND id=? FOR UPDATE',[a.companyId,id]);
      if(!r)liveFail('结算单不存在',404);
      if(r.status==='voided')return {id};
      if(!['draft','returned'].includes(r.status)||r.flow_run_id) liveFail('只能作废未关联审批流程的草稿；审批单须先在流程中撤回，已确认单保留历史并通过调整处理',409);
      await tx.query("UPDATE live_settlements SET status='voided',correction_key=NULL,void_reason=?,revision=revision+1 WHERE company_id=? AND id=?",[text(reason),a.companyId,id]);
      await tx.query('UPDATE live_settlement_lines SET released_at=? WHERE company_id=? AND settlement_id=?',[wallNow(liveClock.now()),a.companyId,id]);
      await tx.query("INSERT INTO live_settlement_events(company_id,settlement_id,event_type,actor_id,detail_json) VALUES(?,?,'voided',?,?)",[a.companyId,id,a.userId,JSON.stringify({reason:text(reason)})]);
      return {id};
    });
  }

}
