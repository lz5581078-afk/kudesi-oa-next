import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  LIVE_ROLE_LABEL, LIVE_SESSION_STATUS, LIVE_START_EARLY_MS, LiveRuleError, liveAddDays, liveCanSeeSession, liveComputeCommission, liveFilterPreview, liveFromText, liveIsDay, liveIsMonth,
  liveMonthBounds, liveReportRoleFor, liveToText, liveToday, liveVersionFor,
} from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { FlowService } from '../flow/flow.service';
import { LiveAccess, liveDouyinAccounts, liveDouyinStores, liveProducts, liveRoomList, livePeople, loadLiveAccess, requireUse } from './live-access';
import { Row, SESSION_SELECT, closedMonth, idOf, liveClock, liveFail, lockCompany, num, numOrNull, reportsOf, ruleVersions, sessionRow, text, wallNow } from './live-core';
import { LiveOrderSource } from './live-order-source';
import { ReviewForm, checkSubmittable, previewApproval } from './live-review';
import { serializeSchedule } from './live-schedule.service';

export interface StartInput {
  scheduleId?: number | null; roomId?: number | null; anchorId?: number | null; controlId?: number | null; operatorId?: number | null;
  douyinAccountId?: number | null; storeId?: number | null; productIds: number[]; startAt?: string | null;
}
export interface ReportInput { role?: string; endAt: string; salesCents: number; adSpendCents?: number | null; orderIds?: string[]; note?: string }
export interface SessionQuery { from?: string; to?: string; roomId?: number; anchorId?: number; controlId?: number; status?: string; page?: number; pageSize?: number; reviewOnly?: boolean }

const ACTIVE = ['live', 'pending_report', 'returned', 'submitted'];
const SKEW_MS = 5 * 60000;
const REVIEWER_SQL = 'EXISTS (SELECT 1 FROM flow_steps fs WHERE fs.run_id = s.flow_run_id AND JSON_CONTAINS(fs.recipients, CAST(? AS JSON)))';

export function serializeSession(s: Row) {
  return {
    id: Number(s.id), scheduleId: s.schedule_id ? Number(s.schedule_id) : null, roomId: Number(s.room_id), roomName: s.room_name, date: s.session_day, startAt: s.start_text, endAt: s.end_text ?? null,
    plannedEnd: s.schedule_end ?? null, status: s.status, statusLabel: LIVE_SESSION_STATUS[s.status] ?? s.status,
    anchor: { id: Number(s.anchor_user_id), name: s.anchor_name }, control: s.control_user_id ? { id: Number(s.control_user_id), name: s.control_name } : null,
    operator: s.operator_user_id ? { id: Number(s.operator_user_id), name: s.operator_name } : null,
    douyinAccount: { id: Number(s.douyin_account_id), name: s.douyin_account_name }, store: s.store_id ? { id: Number(s.store_id), name: s.store_name } : null,
    finalSalesCents: numOrNull(s.final_sales_cents), finalSalesSource: s.final_sales_source ?? null, finalSalesReason: s.final_sales_reason ?? null,
    returnReason: s.return_reason ?? null, flowRunId: s.flow_run_id ? Number(s.flow_run_id) : null, submittedAt: s.submitted_text ?? null, approvedAt: s.approved_text ?? null,
    approverName: s.approver_name ?? null, revision: Number(s.revision),
  };
}

/** 场次：上播、报下播、提交审核、列表与详情、我的直播工作台。 */
@Injectable()
export class LiveSessionService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly flow: FlowService, private readonly orders: LiveOrderSource) {}
  private get em() { return this.ds.manager; }

  // ---------- 通用 ----------
  private isParticipant(s: Row, uid: number) { return [s.anchor_user_id, s.control_user_id, s.operator_user_id, s.started_by].some((v) => v !== null && v !== undefined && Number(v) === uid); }
  private async isReviewer(em: EntityManager, s: Row, uid: number) {
    if (!s.flow_run_id) return false;
    const [r] = await em.query('SELECT COUNT(*) n FROM flow_steps WHERE run_id = ? AND JSON_CONTAINS(recipients, CAST(? AS JSON))', [s.flow_run_id, String(uid)]);
    return Number(r.n) > 0;
  }
  private people(s: Row) { return { anchorId: Number(s.anchor_user_id), controlId: s.control_user_id ? Number(s.control_user_id) : null, operatorId: s.operator_user_id ? Number(s.operator_user_id) : null, startedBy: s.started_by ? Number(s.started_by) : null }; }
  private async visible(em: EntityManager, a: LiveAccess, s: Row) {
    return liveCanSeeSession(a.canView || a.canViewAll, a.userId, this.people(s)) || (await this.isReviewer(em, s, a.userId));
  }
  private parseTime(value: unknown, label: string): string {
    const t = liveToText(value);
    if (!t) liveFail(`${label}格式不正确（年-月-日 时:分）`, 400);
    return t as string;
  }

  // ---------- 报上播 ----------
  async start(user: AuthUser, input: StartInput) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    return this.ds.transaction(async (em) => {
      await lockCompany(em, a.companyId);
      const now = liveClock.now();
      const startAt = input.startAt ? this.parseTime(input.startAt, '上播时间') : wallNow(now);
      const startDate = liveFromText(startAt)!;
      if (startDate.getTime() > now.getTime() + SKEW_MS) liveFail('上播时间不能晚于现在', 400);
      if (startDate.getTime() < now.getTime() - 12 * 3600000) liveFail('上播时间不能早于 12 小时前，请联系管理员处理', 400);
      const day = startAt.slice(0, 10);
      if (await closedMonth(em, a.companyId, day.slice(0, 7), true)) liveFail('该月份已进入结算审批或已结算，不能新建场次');
      let sched: Row | null = null;
      let roomId: number | null, anchorId: number | null, controlId: number | null, operatorId: number | null, accountId: number | null, storeId: number | null;
      if (input.scheduleId) {
        const [row] = await em.query('SELECT * FROM live_schedules WHERE company_id = ? AND id = ? FOR UPDATE', [a.companyId, input.scheduleId]);
        if (!row) liveFail('排场不存在', 404);
        sched = row;
        if (row.status !== 'scheduled' || row.session_id) liveFail('这场排班已上播、已结束或已取消');
        const mine = [row.anchor_user_id, row.control_user_id].some((v) => v && Number(v) === a.userId);
        if (!mine && !a.canManage) liveFail('只有本场排定的主播、中控（或管理人员）可以上播', 403);
        const [st, en] = [liveFromText(wallText(row.start_at))!.getTime(), liveFromText(wallText(row.end_at))!.getTime()];
        if (startDate.getTime() < st - LIVE_START_EARLY_MS) liveFail('距离排场开始还早，开始前 2 小时才可以上播');
        if (startDate.getTime() >= en) liveFail('这场排班已经过了结束时间，不能上播');
        [roomId, anchorId, controlId, operatorId] = [Number(row.room_id), Number(row.anchor_user_id), row.control_user_id ? Number(row.control_user_id) : null, row.operator_user_id ? Number(row.operator_user_id) : null];
        accountId = input.douyinAccountId ? idOf(input.douyinAccountId) : Number(row.douyin_account_id);
        storeId = input.storeId ? idOf(input.storeId) : row.store_id ? Number(row.store_id) : null;
      } else {
        if (!a.canManage && !a.isAnchor && !a.isControl) liveFail('只有主播、中控岗位（或管理人员）可以上播', 403);
        roomId = idOf(input.roomId);
        anchorId = idOf(input.anchorId) ?? (a.isAnchor ? a.userId : null);
        controlId = idOf(input.controlId) ?? (a.isControl && !a.isAnchor && !input.anchorId ? a.userId : null);
        if (!anchorId) liveFail('请选择主播', 400);
        if (!a.canManage && anchorId !== a.userId && !(a.isControl && controlId === a.userId)) liveFail('只能以本人的主播或中控身份上播', 403);
        operatorId = idOf(input.operatorId);
        accountId = idOf(input.douyinAccountId); storeId = idOf(input.storeId);
      }
      if (!roomId) liveFail('请选择直播间', 400);
      const room = (await liveRoomList(em, a.companyId)).find((r) => r.id === roomId);
      if (!room) liveFail('所选房间不是启用的直播间', 400);
      const { anchors, controls } = await livePeople(em, a.companyId);
      if (!anchors.some((p) => p.id === anchorId)) liveFail('所选人员不是主播岗位', 400);
      if (controlId && !controls.some((p) => p.id === controlId)) liveFail('所选人员不是中控岗位', 400);
      if (operatorId) {
        const [op] = await em.query("SELECT id FROM users WHERE company_id = ? AND id = ? AND status = 'active'", [a.companyId, operatorId]);
        if (!op) liveFail('所选运营人员不存在或已停用', 400);
        if (operatorId === anchorId) liveFail('运营人员不能同时是主播', 400);
      }
      const account = accountId ? (await liveDouyinAccounts(em, a.companyId)).find((x) => x.id === accountId) : null;
      if (!account) liveFail('请选择有效的抖音号（资料「自媒体账号」里平台为抖音）', 400);
      if (!storeId) liveFail('请选择抖音店铺', 400);
      const stores = await liveDouyinStores(em, a.companyId);
      const store = stores.find((x) => x.id === storeId);
      if (!store) liveFail('所选店铺不存在、已注销或不是抖音店铺', 400);
      if (!store!.jstShopId) liveFail('这个店铺的资料里还没有填「聚水潭店铺编号」，不能上播。请联系管理员补全店铺资料', 400);
      if (stores.filter((x) => x.jstShopId === store!.jstShopId).length > 1) liveFail('聚水潭店铺编号被多个抖音店铺使用，无法唯一对应，请联系管理员处理', 400);
      const productIds = [...new Set((input.productIds ?? []).map(Number))];
      if (!productIds.length || productIds.length > 100 || productIds.some((v) => !idOf(v))) liveFail('请选择 1 到 100 个在卖产品', 400);
      const products = await liveProducts(em, a.companyId, productIds);
      if (products.length !== productIds.length) liveFail('有产品不存在或已停用，请重新选择', 400);
      const [busyRoom] = await em.query("SELECT id FROM live_sessions WHERE company_id = ? AND status = 'live' AND room_id = ? LIMIT 1", [a.companyId, roomId]);
      if (busyRoom) liveFail('这个直播间正在直播，请先报下播');
      const [busyAnchor] = await em.query("SELECT id FROM live_sessions WHERE company_id = ? AND status = 'live' AND anchor_user_id = ? LIMIT 1", [a.companyId, anchorId]);
      if (busyAnchor) liveFail('这位主播正在另一场直播中，请先报下播');
      const role = a.userId === anchorId ? 'anchor' : a.userId === controlId ? 'control' : 'manager';
      const ins = await em.query(
        `INSERT INTO live_sessions (company_id, schedule_id, room_id, room_name, anchor_user_id, control_user_id, operator_user_id, douyin_account_id, douyin_account_name, store_id, store_name, jst_shop_id,
           session_date, start_at, status, started_by, started_role) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'live',?,?)`,
        [a.companyId, sched ? sched.id : null, room!.id, room!.name, anchorId, controlId, operatorId, account!.id, account!.name, store!.id, store!.name, store!.jstShopId, day, startAt, a.userId, role]);
      const id = Number(ins.insertId);
      let order = 0;
      for (const p of products) await em.query('INSERT INTO live_session_products (company_id, session_id, base_code_id, code_snapshot, name_snapshot, spec_snapshot, sort_order) VALUES (?,?,?,?,?,?,?)', [a.companyId, id, p.id, p.code.slice(0, 100), (p.name || p.code).slice(0, 200), p.spec.slice(0, 300) || null, order++]);
      if (sched) await em.query("UPDATE live_schedules SET status = 'live', session_id = ?, updated_by = ? WHERE company_id = ? AND id = ?", [id, a.userId, a.companyId, sched.id]);
      return { id };
    });
  }

  // ---------- 订单候选与报下播 ----------
  async orderCandidates(user: AuthUser, sessionId: number, q: { endAt?: string; refresh?: boolean }) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    const s = await sessionRow(this.em, a.companyId, sessionId);
    if (!liveReportRoleFor(a.userId, this.people(s))) liveFail('只有本场主播、中控本人可以查看可勾选的订单', 403);
    const endAt = q.endAt ? this.parseTime(q.endAt, '下播时间') : s.end_text ?? wallNow(liveClock.now());
    const found = await this.orders.candidates(a.companyId, { id: Number(s.id), shopId: s.jst_shop_id ?? null, startAt: s.start_text, endAt }, { refresh: !!q.refresh });
    return { ...found, startAt: s.start_text, endAt };
  }

  async report(user: AuthUser, sessionId: number, input: ReportInput) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    // 外部订单查询放在事务之外；事务里只写库
    const first = await sessionRow(this.em, a.companyId, sessionId);
    const role = liveReportRoleFor(a.userId, this.people(first), input.role ?? null);
    if (!role) liveFail('只能由主播、中控（或排定的运营）本人为自己的角色报下播，管理人员不能代填', 403);
    const endAt = this.parseTime(input.endAt, '下播时间');
    const sales = input.salesCents;
    if (!Number.isSafeInteger(sales) || sales < 0 || sales > 10_000_000_000) liveFail('销售额需要是 0 到 1 亿元之间的金额', 400);
    const needsOrders = role !== 'operator';
    const orderIds = [...new Set((input.orderIds ?? []).map((v) => String(v)))];
    let picked: Array<{ orderId: string; innerId: string; amountCents: number; payTime: string | null; status: string }> = [];
    if (needsOrders) {
      if (!orderIds.length) liveFail('请从聚水潭勾选本场订单（至少 1 单）', 400);
      const found = await this.orders.candidates(a.companyId, { id: Number(first.id), shopId: first.jst_shop_id ?? null, startAt: first.start_text, endAt }, { refresh: true });
      if (!found.available) liveFail(found.reason || '暂时查不到聚水潭订单，不能报下播', 409);
      const by = new Map(found.orders.map((o) => [o.orderId, o]));
      for (const id of orderIds) {
        const o = by.get(id);
        if (!o) liveFail(`订单 ${id} 不在本场的聚水潭订单范围内，请刷新订单后重新勾选`, 400);
        if (!o!.paid || o!.cancelled) liveFail(`订单 ${id} 未付款或已取消，不能勾选`, 400);
        picked.push({ orderId: o!.orderId, innerId: o!.innerId, amountCents: o!.amountCents, payTime: o!.payTime, status: o!.status });
      }
    } else picked = [];
    const adSpend = role === 'control' ? (input.adSpendCents ?? null) : null;
    if (role === 'control' && (adSpend === null || !Number.isSafeInteger(adSpend) || adSpend < 0 || adSpend > 10_000_000_000)) liveFail('中控请填写本场投流费用（没有投流填 0）', 400);
    if (role !== 'control' && input.adSpendCents) liveFail('只有中控填写投流费用', 400);
    await this.ds.transaction(async (em) => {
      await lockCompany(em, a.companyId);
      const s = await sessionRow(em, a.companyId, sessionId, true);
      if (!['live', 'pending_report', 'returned'].includes(s.status)) liveFail(s.status === 'submitted' ? '已提交审核，需审核人退回后才能修改' : '该场次已审核，不能再修改');
      if (liveReportRoleFor(a.userId, this.people(s), role) !== role) liveFail('只能由本人填报自己的角色', 403);
      if (s.jst_shop_id !== first.jst_shop_id || s.start_text !== first.start_text) liveFail('场次信息已变化，请刷新后重试');
      const now = liveClock.now();
      const end = liveFromText(endAt)!;
      if (end.getTime() <= liveFromText(s.start_text)!.getTime()) liveFail('下播时间必须晚于上播时间', 400);
      if (end.getTime() > now.getTime() + SKEW_MS) liveFail('下播时间不能晚于现在', 400);
      const total = picked.reduce((t, o) => t + o.amountCents, 0);
      const [old] = await em.query('SELECT id FROM live_session_reports WHERE company_id = ? AND session_id = ? AND role = ? FOR UPDATE', [a.companyId, sessionId, role]);
      let reportId: number;
      if (old) {
        reportId = Number(old.id);
        await em.query(
          `UPDATE live_session_reports SET reporter_user_id = ?, end_at = ?, sales_cents = ?, ad_spend_cents = ?, orders_total_cents = ?, order_count = ?, note = ?, revision = revision + 1 WHERE company_id = ? AND id = ?`,
          [a.userId, endAt, sales, adSpend, needsOrders ? total : null, picked.length, text(input.note) || null, a.companyId, reportId]);
        await em.query('DELETE FROM live_session_orders WHERE company_id = ? AND report_id = ?', [a.companyId, reportId]);
      } else {
        const ins = await em.query(
          `INSERT INTO live_session_reports (company_id, session_id, role, reporter_user_id, end_at, sales_cents, ad_spend_cents, orders_total_cents, order_count, note) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [a.companyId, sessionId, role, a.userId, endAt, sales, adSpend, needsOrders ? total : null, picked.length, text(input.note) || null]);
        reportId = Number(ins.insertId);
      }
      for (const o of picked) {
        await em.query('INSERT INTO live_session_orders (company_id, session_id, report_id, order_id, inner_order_id, amount_cents, pay_time, order_status, shop_id) VALUES (?,?,?,?,?,?,?,?,?)',
          [a.companyId, sessionId, reportId, o.orderId, o.innerId || null, o.amountCents, o.payTime, o.status || null, s.jst_shop_id ?? '']);
      }
      if (role === 'anchor') {
        // 场次下播时间以主播所报为准；离开「直播中」后房间和主播就空出来了
        await em.query("UPDATE live_sessions SET end_at = ?, status = IF(status = 'live', 'pending_report', status), revision = revision + 1 WHERE company_id = ? AND id = ?", [endAt, a.companyId, sessionId]);
        await em.query("UPDATE live_schedules SET status = 'finished' WHERE company_id = ? AND session_id = ? AND status = 'live'", [a.companyId, sessionId]);
      } else await em.query('UPDATE live_sessions SET revision = revision + 1 WHERE company_id = ? AND id = ?', [a.companyId, sessionId]);
    });
    return { ok: true };
  }

  // ---------- 提交审核 ----------
  async submit(user: AuthUser, sessionId: number) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    // 被退回、流程还在的：走流程的「重新提交」（它自己开事务，所以不能放进下面的事务里）
    const peek = await sessionRow(this.em, a.companyId, sessionId);
    if (peek.status === 'returned' && peek.flow_run_id) {
      if (![peek.anchor_user_id, peek.control_user_id].some((v) => v && Number(v) === a.userId) && !a.canManage) liveFail('只有本场主播或中控可以提交审核', 403);
      const [run] = await this.em.query('SELECT revision FROM flow_runs WHERE company_id = ? AND id = ?', [a.companyId, peek.flow_run_id]);
      if (run) { const r = await this.flow.resubmit(user, Number(peek.flow_run_id), { revision: Number(run.revision), payload: { sessionId } }); return { runId: r.id }; }
    }
    // 资格、下播报告和月份检查都在适配器 validateStart；业务记录由适配器 onStart 和流程同一个事务写入
    const detail = await this.flow.start(user, 'live-session-review', { sessionId }, undefined, { internal: true });
    return { runId: detail.id };
  }

  // ---------- 列表与详情 ----------
  async list(user: AuthUser, q: SessionQuery) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    const where = ['s.company_id = ?'], params: unknown[] = [a.companyId];
    if (!(a.canView || a.canViewAll)) {
      where.push(`(s.anchor_user_id = ? OR s.control_user_id = ? OR s.operator_user_id = ? OR s.started_by = ? OR ${REVIEWER_SQL})`);
      params.push(a.userId, a.userId, a.userId, a.userId, String(a.userId));
    }
    if (q.from && liveIsDay(q.from)) { where.push('s.session_date >= ?'); params.push(q.from); }
    if (q.to && liveIsDay(q.to)) { where.push('s.session_date <= ?'); params.push(q.to); }
    if (q.roomId) { where.push('s.room_id = ?'); params.push(q.roomId); }
    if (q.anchorId) { where.push('s.anchor_user_id = ?'); params.push(q.anchorId); }
    if (q.controlId) { where.push('s.control_user_id = ?'); params.push(q.controlId); }
    if (q.status && LIVE_SESSION_STATUS[q.status]) { where.push('s.status = ?'); params.push(q.status); }
    const page = Math.max(1, q.page ?? 1), size = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const [count] = await this.em.query(`SELECT COUNT(*) n FROM live_sessions s WHERE ${where.join(' AND ')}`, params);
    const rows: Row[] = await this.em.query(`${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.start_at DESC, s.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
    return { total: Number(count.n), page, pageSize: size, rows: rows.map(serializeSession) };
  }

  /** 预估提成：按场次日期适用的规则版本，用主播（没有则中控）所报销售额试算；只向本人展示本人的角色。 */
  private async preview(em: EntityManager, a: LiveAccess, s: Row, reports: Row[]) {
    if (s.status === 'approved') return null;
    const base = reports.find((r) => r.role === 'anchor') ?? reports.find((r) => r.role === 'control');
    if (!base) return { available: false, reason: '主播报下播后显示预估提成', anchor: null, control: null, operator: null };
    const version = liveVersionFor(await ruleVersions(em, a.companyId), s.session_day);
    if (!version) return { available: false, reason: '没有适用的提成规则版本', anchor: null, control: null, operator: null };
    const control = reports.find((r) => r.role === 'control');
    const r = liveComputeCommission({ rules: version.rules, finalSalesCents: num(base.sales_cents), adSpendCents: control?.ad_spend_cents === null || control?.ad_spend_cents === undefined ? null : Number(control.ad_spend_cents) });
    const p = { available: true, reason: '', basisSalesCents: r.finalSalesCents, adSpendCents: r.adSpendCents, roiScaled: r.roiScaled, belowRoi: r.belowRoi, ruleVersionId: version.id,
      anchor: r.anchor, control: s.control_user_id ? r.control : null, operator: s.operator_user_id && Number(s.operator_user_id) !== Number(s.control_user_id) ? r.operator : null };
    return liveFilterPreview(a.canViewAll, a.userId, { ...this.people(s), status: s.status }, p);
  }

  async detail(user: AuthUser, id: number) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    const em = this.em;
    const s = await sessionRow(em, a.companyId, id);
    if (!(await this.visible(em, a, s))) liveFail('没有查看这场直播的权限', 403);
    const [products, reports, orders, commissions, wages] = await Promise.all([
      em.query('SELECT base_code_id, code_snapshot, name_snapshot, spec_snapshot FROM live_session_products WHERE company_id = ? AND session_id = ? ORDER BY sort_order', [a.companyId, id]) as Promise<Row[]>,
      reportsOf(em, a.companyId, id),
      em.query("SELECT order_id, report_id, amount_cents, DATE_FORMAT(pay_time,'%Y-%m-%d %H:%i:%s') pay_text, order_status FROM live_session_orders WHERE company_id = ? AND session_id = ? ORDER BY id", [a.companyId, id]) as Promise<Row[]>,
      em.query('SELECT c.user_id, c.role, c.rate_units, c.amount_cents, c.roi_scaled, c.below_roi, c.rule_version_id, e.name FROM live_commission_records c JOIN users e ON e.id = c.user_id AND e.company_id = c.company_id WHERE c.company_id = ? AND c.session_id = ? ORDER BY c.id', [a.companyId, id]) as Promise<Row[]>,
      em.query("SELECT w.user_id, w.minutes, w.hourly_rate_cents, w.amount_cents, w.rate_source, w.adjust_note, DATE_FORMAT(w.start_at,'%Y-%m-%d %H:%i:%s') start_text, DATE_FORMAT(w.end_at,'%Y-%m-%d %H:%i:%s') end_text FROM live_wage_records w WHERE w.company_id = ? AND w.session_id = ?", [a.companyId, id]) as Promise<Row[]>,
    ]);
    const names = new Map<number, string>((await em.query(`SELECT id, name FROM users WHERE company_id = ? AND id IN (${[...new Set([...reports.map((r) => r.reporter_user_id), s.anchor_user_id])].map(() => '?').join(',')})`, [a.companyId, ...new Set([...reports.map((r) => r.reporter_user_id), s.anchor_user_id])])).map((r: Row) => [Number(r.id), r.name]));
    const mineAll = a.canViewAll;
    const showMoney = (userId: number) => mineAll || userId === a.userId; // 提成金额：全员权限者看全部，其他人只看本人
    const ppl = this.people(s);
    const editable = ['live', 'pending_report', 'returned'].includes(s.status);
    const canRoles = (['anchor', 'control', 'operator'] as const).filter((r) => editable && liveReportRoleFor(a.userId, ppl, r) === r);
    let flow: unknown = null;
    if (s.flow_run_id) { try { flow = await this.flow.detail(user, Number(s.flow_run_id)); } catch { flow = null; } }
    return {
      ...serializeSession(s),
      products: products.map((p) => ({ id: Number(p.base_code_id), code: p.code_snapshot, name: p.name_snapshot, spec: p.spec_snapshot ?? '' })),
      reports: reports.map((r) => ({
        role: r.role, roleLabel: LIVE_ROLE_LABEL[r.role], reporter: { id: Number(r.reporter_user_id), name: names.get(Number(r.reporter_user_id)) ?? '' }, endAt: r.end_text, salesCents: num(r.sales_cents),
        adSpendCents: numOrNull(r.ad_spend_cents), ordersTotalCents: numOrNull(r.orders_total_cents), orderCount: Number(r.order_count), note: r.note ?? '',
        orders: orders.filter((o) => Number(o.report_id) === Number(r.id)).map((o) => ({ orderId: o.order_id, amountCents: num(o.amount_cents), payTime: o.pay_text, status: o.order_status })),
      })),
      commissions: commissions.filter((c) => showMoney(Number(c.user_id))).map((c) => ({ userId: Number(c.user_id), name: c.name, role: c.role, roleLabel: LIVE_ROLE_LABEL[c.role], rateUnits: Number(c.rate_units), amountCents: num(c.amount_cents), roiScaled: numOrNull(c.roi_scaled), belowRoi: !!c.below_roi })),
      wage: wages.filter((w) => showMoney(Number(w.user_id))).map((w) => ({ userId: Number(w.user_id), minutes: Number(w.minutes), hourlyRateCents: num(w.hourly_rate_cents), amountCents: num(w.amount_cents), rateSource: w.rate_source, note: w.adjust_note, startAt: w.start_text, endAt: w.end_text }))[0] ?? null,
      preview: await this.preview(em, a, s, reports),
      me: { reportRoles: canRoles, canSubmit: ['pending_report', 'returned'].includes(s.status) && ([ppl.anchorId, ppl.controlId].includes(a.userId) || a.canManage), isManager: a.canManage },
      flow,
    };
  }

  /** 审核人（或管理人员）按所选来源、运营、工资设置试算提成与工资，不写库。 */
  async reviewPreview(user: AuthUser, id: number, form: ReviewForm) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    const s = await sessionRow(this.em, a.companyId, id);
    if (!a.canManage && !(await this.isReviewer(this.em, s, a.userId))) liveFail('没有审核这场直播的权限', 403);
    try { return await previewApproval(this.em, a.companyId, id, form); } catch (e) { if (e instanceof LiveRuleError) liveFail(e.message, 400); throw e; }
  }

  // ---------- 我的直播 ----------
  async workbench(user: AuthUser) {
    const a = await loadLiveAccess(this.em, user);
    if (!a.canDesk && !a.canView) liveFail('无权使用我的直播', 403);
    const em = this.em, c = a.companyId, uid = a.userId, now = liveClock.now();
    const today = liveToday(now), month = today.slice(0, 7), mine = '(s.anchor_user_id = ? OR s.control_user_id = ? OR s.operator_user_id = ?)';
    const [active, schedules, recent, comm, wage] = await Promise.all([
      em.query(`${SESSION_SELECT} WHERE s.company_id = ? AND ${mine} AND s.status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY s.start_at DESC LIMIT 20`, [c, uid, uid, uid, ...ACTIVE]) as Promise<Row[]>,
      em.query(`SELECT s.*, DATE_FORMAT(s.schedule_date,'%Y-%m-%d') schedule_day, DATE_FORMAT(s.start_at,'%Y-%m-%d %H:%i:%s') start_text, DATE_FORMAT(s.end_at,'%Y-%m-%d %H:%i:%s') end_text, a.name anchor_name, cc.name control_name, o.name operator_name
          FROM live_schedules s JOIN users a ON a.id = s.anchor_user_id AND a.company_id = s.company_id LEFT JOIN users cc ON cc.id = s.control_user_id AND cc.company_id = s.company_id LEFT JOIN users o ON o.id = s.operator_user_id AND o.company_id = s.company_id
         WHERE s.company_id = ? AND (s.anchor_user_id = ? OR s.control_user_id = ? OR s.operator_user_id = ?) AND s.status IN ('scheduled','live') AND s.schedule_date BETWEEN ? AND ? ORDER BY s.start_at`, [c, uid, uid, uid, today, liveAddDays(today, 7)]) as Promise<Row[]>,
      em.query(`${SESSION_SELECT} WHERE s.company_id = ? AND ${mine} ORDER BY s.start_at DESC LIMIT 20`, [c, uid, uid, uid]) as Promise<Row[]>,
      em.query("SELECT COALESCE(SUM(amount_cents),0) total FROM live_commission_records WHERE company_id = ? AND user_id = ? AND DATE_FORMAT(session_date,'%Y-%m') = ?", [c, uid, month]),
      em.query("SELECT COALESCE(SUM(amount_cents),0) total, COALESCE(SUM(minutes),0) minutes FROM live_wage_records WHERE company_id = ? AND user_id = ? AND DATE_FORMAT(session_date,'%Y-%m') = ?", [c, uid, month]),
    ]);
    const nowText = wallNow(now), nowMs = now.getTime();
    return {
      today, month, identity: { isAnchor: a.isAnchor, isControl: a.isControl, canManage: a.canManage },
      active: active.map(serializeSession),
      schedules: schedules.map((r) => ({ ...serializeSchedule(r), canStart: r.status === 'scheduled' && nowMs >= liveFromText(r.start_text)!.getTime() - LIVE_START_EARLY_MS && r.end_text > nowText, mineRole: Number(r.anchor_user_id) === uid ? 'anchor' : Number(r.control_user_id) === uid ? 'control' : 'operator' })),
      recent: recent.map(serializeSession),
      monthCommissionCents: num(comm[0].total), monthWageCents: num(wage[0].total), monthWageMinutes: num(wage[0].minutes),
    };
  }

  async history(user: AuthUser, q: { mode?: string; month?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
    const a = await loadLiveAccess(this.em, user);
    if (!a.canDesk && !a.canView) liveFail('无权使用我的直播', 403);
    const em = this.em, c = a.companyId, uid = a.userId, now = liveClock.now();
    const mine = '(s.anchor_user_id = ? OR s.control_user_id = ? OR s.operator_user_id = ?)';
    const month = liveIsMonth(q.month) ? q.month : liveToday(now).slice(0, 7);
    const where = [`s.company_id = ?`, mine], params: unknown[] = [c, uid, uid, uid];
    if (q.mode === 'range') {
      if (!liveIsDay(q.from) || !liveIsDay(q.to) || q.from > q.to) liveFail('请选择有效的起止日期', 400);
      where.push('s.session_date BETWEEN ? AND ?'); params.push(q.from, q.to);
    } else if (q.mode !== 'all') {
      const b = liveMonthBounds(month); where.push('s.session_date >= ? AND s.session_date < ?'); params.push(b.from, b.until);
    }
    const page = Math.max(1, q.page ?? 1), size = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const [count] = await em.query(`SELECT COUNT(*) n FROM live_sessions s WHERE ${where.join(' AND ')}`, params);
    const rows: Row[] = await em.query(`${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.start_at DESC, s.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
    const ids = rows.map((r) => Number(r.id));
    const [comm, wages]: [Row[], Row[]] = ids.length ? await Promise.all([
      em.query(`SELECT session_id, role, amount_cents FROM live_commission_records WHERE company_id = ? AND user_id = ? AND session_id IN (${ids.map(() => '?').join(',')})`, [c, uid, ...ids]),
      em.query(`SELECT session_id, amount_cents, minutes FROM live_wage_records WHERE company_id = ? AND user_id = ? AND session_id IN (${ids.map(() => '?').join(',')})`, [c, uid, ...ids]),
    ]) : [[], []];
    const summary = async (from: string | null, until: string | null) => {
      const range = from ? ' AND s.session_date >= ? AND s.session_date < ?' : '';
      const rp = from ? [from, until] : [];
      const [sess] = await em.query(`SELECT COUNT(*) n, COALESCE(SUM(TIMESTAMPDIFF(MINUTE, s.start_at, s.end_at)),0) minutes FROM live_sessions s WHERE s.company_id = ? AND ${mine} AND s.end_at IS NOT NULL${range}`, [c, uid, uid, uid, ...rp]);
      const dr = from ? ' AND session_date >= ? AND session_date < ?' : '';
      const [cm] = await em.query(`SELECT COALESCE(SUM(amount_cents),0) total FROM live_commission_records WHERE company_id = ? AND user_id = ?${dr}`, [c, uid, ...rp]);
      const [wg] = await em.query(`SELECT COALESCE(SUM(amount_cents),0) total, COALESCE(SUM(minutes),0) minutes FROM live_wage_records WHERE company_id = ? AND user_id = ?${dr}`, [c, uid, ...rp]);
      return { sessions: Number(sess.n), minutes: Number(sess.minutes), commissionCents: num(cm.total), wageCents: num(wg.total), wageMinutes: num(wg.minutes) };
    };
    const thisB = liveMonthBounds(liveToday(now).slice(0, 7));
    return {
      mode: q.mode === 'range' || q.mode === 'all' ? q.mode : 'month', month, total: Number(count.n), page, pageSize: size,
      rows: rows.map((r) => ({
        ...serializeSession(r), myRoles: ['anchor', 'control', 'operator'].filter((role) => Number(r[`${role}_user_id`]) === uid).map((x) => LIVE_ROLE_LABEL[x]),
        commissionCents: comm.filter((x) => Number(x.session_id) === Number(r.id)).reduce((t, x) => t + num(x.amount_cents), 0) || null,
        wageCents: wages.find((x) => Number(x.session_id) === Number(r.id)) ? num(wages.find((x) => Number(x.session_id) === Number(r.id))!.amount_cents) : null,
      })),
      summary: { all: await summary(null, null), thisMonth: await summary(thisB.from, thisB.until), lastMonth: await summary(thisB.previousFrom, thisB.from) },
    };
  }
}

function wallText(v: unknown): string { return liveToText(v) ?? String(v); }
