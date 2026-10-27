import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  LIVE_ROLE_LABEL, LiveRuleError, LiveRulesInput, liveComputeCommission, liveComputeWage, liveIsDay, liveIsMonth, liveMonthBounds, liveRulesFromInput, liveRulesToInput, liveToday, liveYuanToCents,
} from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { loadLiveAccess, requireManage, requireUse, requireView } from './live-access';
import { Row, liveClock, liveFail, lockCompany, num, numOrNull, ruleVersions, text } from './live-core';

/** 提成规则版本、提成记录、主播工资记录。能看全员的只有 live.commissions.view，其余人只看本人。 */
@Injectable()
export class LiveLedgerService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}
  private get em() { return this.ds.manager; }

  private rulesOf(input: LiveRulesInput) {
    try { return liveRulesFromInput(input); } catch (e) { if (e instanceof LiveRuleError) liveFail(e.message, 400); throw e; }
  }

  // ---------- 规则 ----------
  async rules(user: AuthUser) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    if (!a.canView && !a.canViewAll) liveFail('没有查看提成规则的权限', 403);
    const versions = await ruleVersions(this.em, a.companyId);
    const today = liveToday(liveClock.now());
    const current = versions.find((v) => v.effectiveFrom <= today) ?? null;
    return { canManage: a.canManage, currentId: current?.id ?? null, versions: versions.map((v) => ({ id: v.id, effectiveFrom: v.effectiveFrom, note: v.note, createdAt: v.createdAt, creatorName: v.creatorName, usedCount: v.usedCount, rules: v.rules, form: liveRulesToInput(v.rules) })) };
  }

  /** 只追加：新版本从生效日期当天起适用于场次日期；同一生效日期不能建两个版本；已有的版本不可改不可删。 */
  async createRule(user: AuthUser, input: { effectiveFrom: string; note?: string; rules: LiveRulesInput }) {
    const a = await loadLiveAccess(this.em, user); requireManage(a);
    if (!liveIsDay(input.effectiveFrom)) liveFail('请选择生效日期', 400);
    const rules = this.rulesOf(input.rules);
    return this.ds.transaction(async (em) => {
      await lockCompany(em, a.companyId);
      const [dup] = await em.query('SELECT id FROM live_commission_rule_versions WHERE company_id = ? AND effective_from = ?', [a.companyId, input.effectiveFrom]);
      if (dup) liveFail('这个生效日期已经有一个规则版本，请换一个日期（已保存的版本不能修改，只能追加新版本）');
      const ins = await em.query('INSERT INTO live_commission_rule_versions (company_id, effective_from, rules_json, note, created_by) VALUES (?,?,?,?,?)', [a.companyId, input.effectiveFrom, JSON.stringify(rules), text(input.note) || null, a.userId]);
      return { id: Number(ins.insertId) };
    });
  }

  /** 规则编辑器试算：不保存。销售额、投流用元。 */
  async trial(user: AuthUser, input: { rules: LiveRulesInput; sales: string; adSpend?: string }) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    if (!a.canView && !a.canViewAll) liveFail('没有试算提成的权限', 403);
    const rules = this.rulesOf(input.rules);
    try {
      const r = liveComputeCommission({ rules, finalSalesCents: liveYuanToCents(input.sales, '销售额') as number, adSpendCents: liveYuanToCents(input.adSpend ?? '', '投流费用', { allowEmpty: true }) });
      return { tierIndex: r.tierIndex, tier: r.tier, roiScaled: r.roiScaled, belowRoi: r.belowRoi, anchor: r.anchor, control: r.control, operator: r.operator };
    } catch (e) { if (e instanceof LiveRuleError) liveFail(e.message, 400); throw e; }
  }

  async wageTrial(user: AuthUser, input: { startAt: string; endAt: string; hourlyRateCents: number }) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    if (!a.canView && !a.canViewAll) liveFail('没有试算工资的权限', 403);
    try { return liveComputeWage(input); } catch (e) { if (e instanceof LiveRuleError) liveFail(e.message, 400); throw e; }
  }

  // ---------- 提成记录 ----------
  private async scope(user: AuthUser, q: { month?: string; from?: string; to?: string }) {
    const a = await loadLiveAccess(this.em, user); requireUse(a);
    const month = liveIsMonth(q.month) ? q.month : liveToday(liveClock.now()).slice(0, 7);
    const where = ['r.company_id = ?'], params: unknown[] = [a.companyId];
    if (liveIsDay(q.from) && liveIsDay(q.to)) { where.push('r.session_date BETWEEN ? AND ?'); params.push(q.from, q.to); }
    else { const b = liveMonthBounds(month); where.push('r.session_date >= ? AND r.session_date < ?'); params.push(b.from, b.until); }
    if (!a.canViewAll) { where.push('r.user_id = ?'); params.push(a.userId); }
    return { a, month, where, params };
  }

  async commissions(user: AuthUser, q: { month?: string; from?: string; to?: string; userId?: number; role?: string }) {
    const { a, month, where, params } = await this.scope(user, q);
    if (q.userId && a.canViewAll) { where.push('r.user_id = ?'); params.push(q.userId); }
    if (q.role && LIVE_ROLE_LABEL[q.role]) { where.push('r.role = ?'); params.push(q.role); }
    const rows: Row[] = await this.em.query(
      `SELECT r.id, r.session_id, r.user_id, r.role, DATE_FORMAT(r.session_date,'%Y-%m-%d') day, r.final_sales_cents, r.ad_spend_cents, r.roi_scaled, r.below_roi, r.rate_units, r.amount_cents, r.rule_version_id, e.name user_name,
         s.room_name, DATE_FORMAT(s.start_at,'%Y-%m-%d %H:%i') start_text, s.douyin_account_name
         FROM live_commission_records r JOIN users e ON e.id = r.user_id AND e.company_id = r.company_id JOIN live_sessions s ON s.id = r.session_id AND s.company_id = r.company_id
        WHERE ${where.join(' AND ')} ORDER BY r.session_date DESC, r.session_id DESC, r.id`, params);
    const summary = new Map<string, { userId: number; name: string; role: string; roleLabel: string; sessions: number; salesCents: number; amountCents: number }>();
    for (const r of rows) {
      const key = `${r.user_id}:${r.role}`;
      const s = summary.get(key) ?? { userId: Number(r.user_id), name: r.user_name, role: r.role, roleLabel: LIVE_ROLE_LABEL[r.role], sessions: 0, salesCents: 0, amountCents: 0 };
      s.sessions += 1; s.salesCents += num(r.final_sales_cents); s.amountCents += num(r.amount_cents); summary.set(key, s);
    }
    return {
      month, scope: a.canViewAll ? 'all' : 'mine', totalCents: rows.reduce((t, r) => t + num(r.amount_cents), 0), summary: [...summary.values()],
      rows: rows.map((r) => ({ id: Number(r.id), sessionId: Number(r.session_id), userId: Number(r.user_id), userName: r.user_name, role: r.role, roleLabel: LIVE_ROLE_LABEL[r.role], date: r.day, roomName: r.room_name, startAt: r.start_text, douyinName: r.douyin_account_name,
        finalSalesCents: num(r.final_sales_cents), adSpendCents: num(r.ad_spend_cents), roiScaled: numOrNull(r.roi_scaled), belowRoi: !!r.below_roi, rateUnits: Number(r.rate_units), amountCents: num(r.amount_cents), ruleVersionId: Number(r.rule_version_id) })),
    };
  }

  async wages(user: AuthUser, q: { month?: string; from?: string; to?: string; userId?: number }) {
    const { a, month, where, params } = await this.scope(user, q);
    if (q.userId && a.canViewAll) { where.push('r.user_id = ?'); params.push(q.userId); }
    const rows: Row[] = await this.em.query(
      `SELECT r.id, r.session_id, r.user_id, DATE_FORMAT(r.session_date,'%Y-%m-%d') day, DATE_FORMAT(r.start_at,'%Y-%m-%d %H:%i') start_text, DATE_FORMAT(r.end_at,'%Y-%m-%d %H:%i') end_text, r.minutes, r.hourly_rate_cents, r.rate_source, r.amount_cents, r.adjust_note, e.name user_name, s.room_name
         FROM live_wage_records r JOIN users e ON e.id = r.user_id AND e.company_id = r.company_id JOIN live_sessions s ON s.id = r.session_id AND s.company_id = r.company_id
        WHERE ${where.join(' AND ')} ORDER BY r.session_date DESC, r.id DESC`, params);
    const summary = new Map<number, { userId: number; name: string; sessions: number; minutes: number; amountCents: number }>();
    for (const r of rows) {
      const s = summary.get(Number(r.user_id)) ?? { userId: Number(r.user_id), name: r.user_name, sessions: 0, minutes: 0, amountCents: 0 };
      s.sessions += 1; s.minutes += Number(r.minutes); s.amountCents += num(r.amount_cents); summary.set(Number(r.user_id), s);
    }
    return {
      month, scope: a.canViewAll ? 'all' : 'mine', totalCents: rows.reduce((t, r) => t + num(r.amount_cents), 0), summary: [...summary.values()],
      rows: rows.map((r) => ({ id: Number(r.id), sessionId: Number(r.session_id), userId: Number(r.user_id), userName: r.user_name, date: r.day, roomName: r.room_name, startAt: r.start_text, endAt: r.end_text, minutes: Number(r.minutes), hourlyRateCents: num(r.hourly_rate_cents), rateSource: r.rate_source, amountCents: num(r.amount_cents), note: r.adjust_note ?? '' })),
    };
  }

  async people(user: AuthUser) {
    const a = await loadLiveAccess(this.em, user); requireView(a);
    const rows: Row[] = await this.em.query("SELECT id, name FROM users WHERE company_id = ? AND status = 'active' ORDER BY id", [a.companyId]);
    return rows.map((r) => ({ id: Number(r.id), name: r.name }));
  }
}
