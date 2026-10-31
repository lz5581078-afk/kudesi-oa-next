import type { EntityManager } from 'typeorm';
import { LiveRuleError, liveRulesFromInput } from '@kudesi/shared';
import { exactCents, type LegacyLive } from './protocol';

/**
 * 旧直播管理数据导入：排场、场次、上播产品、下播报告与勾选订单、提成规则版本、提成记录、主播工资、月结单（明细与退款）。
 * 约定：
 * - 金额旧库是十进制「元」，一律精确换算成整数分；对不上两位小数的行整行失败，不做舍入。
 * - 提成点数旧库是百分数（3.5），新库是 ×100 的整数（350）；投产旧库 4 位小数，新库 ×10000 的整数。
 * - 员工、直播间（位置资料）、抖音账号（自媒体资料）、店铺、基础编码都通过本次/历史导入账本里的映射换成新 ID，缺映射的行失败并写原因。
 * - 旧审批流实例不迁入：旧库里「待审核」的场次迁成「待提交审核」、「审批中」的月结单迁成「已退回」，管理员在新流程里重新提交。
 * - 复跑幂等：已登记的源行直接复用；每一行一个保存点，失败只回滚这一行。
 */
export interface LiveImportCtx {
  em: EntityManager; companyId: number; actorId: number;
  lookup(type: string, id: unknown): number | undefined;
  register(type: string, id: unknown, targetId: number): Promise<void>;
  count(which: 'created' | 'reused', type: string): void;
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
  fail(type: string, id: string, reason: string): void;
  note(type: string, id: string, reason: string): void;
  safeFailure(e: unknown): string;
}
type Row = Record<string, any>;
export const LIVE_SOURCE_TYPES = ['live_rule_version', 'live_schedule', 'live_session', 'live_session_product', 'live_session_report', 'live_session_order', 'live_commission', 'live_wage', 'live_settlement', 'live_settlement_line', 'live_settlement_refund'] as const;
/** 导入账本里 target_type 对应的新表，用于复跑前核对账本没有失效 */
export const LIVE_TARGET_TABLE: Record<string, string> = { live_rule_version: 'live_commission_rule_versions', live_schedule: 'live_schedules', live_session: 'live_sessions', live_session_product: 'live_session_products', live_session_report: 'live_session_reports', live_session_order: 'live_session_orders', live_commission: 'live_commission_records', live_wage: 'live_wage_records', live_settlement: 'live_settlements', live_settlement_line: 'live_settlement_lines', live_settlement_refund: 'live_settlement_refunds' };
export const liveHashGroups = (live: LegacyLive | undefined): Array<[string, Row[]]> => live ? [
  ['live_rule_version', live.commission_rule_versions ?? []], ['live_schedule', live.schedules ?? []], ['live_session', live.sessions ?? []], ['live_session_product', live.session_products ?? []],
  ['live_session_report', live.session_reports ?? []], ['live_session_order', live.session_orders ?? []], ['live_commission', live.commission_records ?? []], ['live_wage', live.wage_records ?? []],
  ['live_settlement', live.settlements ?? []], ['live_settlement_line', live.settlement_lines ?? []], ['live_settlement_refund', live.settlement_refunds ?? []],
] : [];

class LiveRowError extends Error {}
const bad = (m: string): never => { throw new LiveRowError(m); };
const money = (v: unknown, label: string): number => { try { const c = exactCents(v); return c === undefined ? 0 : c; } catch { return bad(`${label}不能精确换算成整数分`); } };
const moneyOrNull = (v: unknown, label: string) => (v === null || v === undefined || v === '' ? null : money(v, label));
/** 十进制字符串 → 乘以 10^scale 的整数，超出精度不舍入。 */
function scaled(v: unknown, scale: number, label: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(v));
  if (!m || (m[3] ?? '').replace(/0+$/, '').length > scale) return bad(`${label}精度超出范围`);
  const n = Number(m[2]) * 10 ** scale + Number(((m[3] ?? '') + '0'.repeat(scale)).slice(0, scale));
  return m[1] ? -n : n;
}
const str = (v: unknown, max: number): string | null => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max));
const json = (v: unknown): any => { if (v === null || v === undefined || v === '') return null; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return v; };
const wall = (v: unknown, label: string): string => { const s = String(v ?? ''); if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(s)) bad(`${label}时间格式不对`); return s.replace('T', ' ').slice(0, 19).padEnd(19, ':00'); };
const day = (v: unknown, label: string): string => { const s = String(v ?? '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) bad(`${label}日期格式不对`); return s; };

export async function importLive(ctx: LiveImportCtx, live: LegacyLive): Promise<void> {
  const { em, companyId } = ctx;
  const run = async (type: string, rows: Row[], one: (r: Row) => Promise<number>) => {
    for (const r of rows) {
      const id = String(r.id);
      if (ctx.lookup(type, id)) { ctx.count('reused', type); continue; }
      try {
        await ctx.savepoint(async () => { const target = await one(r); await ctx.register(type, id, target); });
        ctx.count('created', type);
      } catch (e) { ctx.fail(type, id, e instanceof LiveRowError ? e.message : ctx.safeFailure(e)); }
    }
  };
  const user = (v: unknown, label: string, optional = false): number | null => {
    if (v === null || v === undefined || v === '') { if (optional) return null; return bad(`${label}缺失`); }
    const id = ctx.lookup('user', v);
    if (!id) { if (optional) return null; return bad(`${label}（旧员工 ${v}）不在本次迁入范围`); }
    return id;
  };
  const approver = (v: unknown, type: string, id: string) => { const n = v ? ctx.lookup('user', v) : undefined; if (!n) ctx.note(type, id, '旧审核人不在迁入范围，审核人记为执行迁移的管理员'); return n ?? ctx.actorId; };
  const resource = (type: string, v: unknown, label: string, optional = false): number | null => {
    if (v === null || v === undefined || v === '') { if (optional) return null; return bad(`${label}缺失`); }
    const id = ctx.lookup(type, v);
    if (!id) { if (optional) return null; return bad(`${label}（旧 ID ${v}）没有对应的新资料，请先迁入该资料`); }
    return id;
  };
  const title = async (id: number): Promise<string> => { const [r] = await em.query('SELECT title FROM resource_records WHERE id = ? AND company_id = ?', [id, companyId]); return String(r?.title ?? '').slice(0, 200); };

  // 规则版本：旧 rules_json 的档位用元、点数用百分数，走与页面保存相同的校验换算；日期已有版本时跳过，不覆盖
  const ruleOf = new Map<string, { id: number; rules: any; from: string }>();
  await run('live_rule_version', live.commission_rule_versions ?? [], async (r) => {
    const from = day(r.effective_from, '生效日期');
    let rules; try { rules = liveRulesFromInput(json(r.rules_json)); } catch (e) { return bad(e instanceof LiveRuleError ? e.message : '规则格式不对'); }
    const [dup] = await em.query('SELECT id FROM live_commission_rule_versions WHERE company_id = ? AND effective_from = ?', [companyId, from]);
    if (dup) { ctx.note('live_rule_version', String(r.id), '目标公司同一生效日期已有规则版本，复用现有版本，不覆盖'); return Number(dup.id); }
    const ins = await em.query('INSERT INTO live_commission_rule_versions (company_id, effective_from, rules_json, note, created_by) VALUES (?,?,?,?,?)', [companyId, from, JSON.stringify(rules), str(r.note, 500), ctx.actorId]);
    return Number(ins.insertId);
  });
  for (const r of live.commission_rule_versions ?? []) { const id = ctx.lookup('live_rule_version', r.id); if (id) { try { ruleOf.set(String(r.id), { id, rules: liveRulesFromInput(json(r.rules_json)), from: day(r.effective_from, '') }); } catch { /* 已在上面报失败 */ } } }

  await run('live_schedule', live.schedules ?? [], async (r) => {
    const room = resource('locations', r.room_location_id, '直播间') as number, acct = resource('self-media', r.douyin_account_id, '抖音账号') as number;
    const store = resource('stores', r.store_id, '店铺', true);
    if (r.store_id && !store) ctx.note('live_schedule', String(r.id), '旧店铺未迁入，排场不带店铺');
    const ins = await em.query(
      `INSERT INTO live_schedules (company_id, room_id, room_name, schedule_date, start_at, end_at, anchor_user_id, control_user_id, operator_user_id, douyin_account_id, douyin_account_name, store_id, store_name,
        status, note, cancel_reason, notification_version, created_by, updated_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [companyId, room, await title(room), day(r.schedule_date, '排场'), wall(r.start_at, '开始'), wall(r.end_at, '结束'), user(r.anchor_employee_id, '主播'), user(r.control_employee_id, '中控', true), user(r.operator_employee_id, '运营', true),
        acct, await title(acct), store, store ? await title(store) : null, ['scheduled', 'live', 'finished', 'cancelled'].includes(r.status) ? r.status : bad('排场状态不认识'), str(r.note, 500), str(r.cancel_reason, 500),
        Math.max(1, Number(r.notification_version) || 1), user(r.created_by, '创建人', true) ?? ctx.actorId, user(r.updated_by, '更新人', true), r.created_at ? wall(r.created_at, '创建') : wall(r.start_at, '创建')]);
    return Number(ins.insertId);
  });

  await run('live_session', live.sessions ?? [], async (r) => {
    const room = resource('locations', r.room_location_id, '直播间') as number, acct = resource('self-media', r.douyin_account_id, '抖音账号') as number;
    const store = resource('stores', r.store_id, '店铺', true);
    const sid = String(r.id);
    let status = String(r.status);
    if (!['live', 'pending_report', 'submitted', 'returned', 'approved'].includes(status)) bad('场次状态不认识');
    if (status === 'submitted') { status = 'pending_report'; ctx.note('live_session', sid, '旧系统待审核的场次迁成「待提交审核」，需在新流程里重新提交'); }
    const approved = status === 'approved';
    const ins = await em.query(
      `INSERT INTO live_sessions (company_id, schedule_id, room_id, room_name, anchor_user_id, control_user_id, operator_user_id, douyin_account_id, douyin_account_name, store_id, store_name, session_date, start_at, end_at,
        status, started_by, started_role, return_reason, submitted_by, submitted_at, final_sales_cents, final_sales_source, final_sales_reason, approved_by, approved_at, revision, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [companyId, r.schedule_id ? ctx.lookup('live_schedule', r.schedule_id) ?? null : null, room, str(r.room_name, 200) || await title(room), user(r.anchor_employee_id, '主播'), user(r.control_employee_id, '中控', true), user(r.operator_employee_id, '运营', true),
        acct, str(r.douyin_account_name, 200) || await title(acct), store, str(r.store_name, 200), day(r.session_date, '场次'), wall(r.start_at, '上播'), r.end_at ? wall(r.end_at, '下播') : null,
        status, user(r.started_by, '上播人', true) ?? ctx.actorId, ['anchor', 'control', 'operator'].includes(r.started_role) ? r.started_role : 'anchor', str(r.return_reason, 500), user(r.submitted_by, '提交人', true), r.submitted_at && status !== 'pending_report' ? wall(r.submitted_at, '提交') : null,
        approved ? moneyOrNull(r.final_sales, '最终销售额') : null, approved ? str(r.final_sales_source, 20) : null, approved ? str(r.final_sales_reason, 500) : null,
        approved ? approver(r.approved_by, 'live_session', sid) : null, approved && r.approved_at ? wall(r.approved_at, '审核') : null, Math.max(1, Number(r.revision) || 1), r.created_at ? wall(r.created_at, '创建') : wall(r.start_at, '创建')]);
    const newId = Number(ins.insertId);
    if (r.schedule_id) { const sch = ctx.lookup('live_schedule', r.schedule_id); if (sch) await em.query('UPDATE live_schedules SET session_id = ? WHERE company_id = ? AND id = ? AND session_id IS NULL', [newId, companyId, sch]); }
    return newId;
  });

  const sessionOf = (v: unknown) => ctx.lookup('live_session', v) ?? bad(`所属场次（旧 ID ${v}）没有迁入`);
  await run('live_session_product', live.session_products ?? [], async (r) => {
    const ins = await em.query('INSERT INTO live_session_products (company_id, session_id, base_code_id, code_snapshot, name_snapshot, spec_snapshot, sort_order) VALUES (?,?,?,?,?,?,?)',
      [companyId, sessionOf(r.session_id), resource('finance-base-codes', r.base_code_id, '基础编码'), str(r.code_snapshot, 100) ?? '', str(r.name_snapshot, 200) ?? '', str(r.spec_snapshot, 300), Number(r.sort_order) || 0]);
    return Number(ins.insertId);
  });
  await run('live_session_report', live.session_reports ?? [], async (r) => {
    const role = String(r.reporter_role); if (!['anchor', 'control', 'operator'].includes(role)) bad('报告角色不认识');
    const ins = await em.query(
      `INSERT INTO live_session_reports (company_id, session_id, role, reporter_user_id, end_at, sales_cents, ad_spend_cents, order_source, orders_total_cents, order_count, note, revision, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [companyId, sessionOf(r.session_id), role, user(r.reporter_employee_id, '填报人'), wall(r.end_at, '下播'), money(r.sales_amount, '销售额'), moneyOrNull(r.ad_spend, '投流费用'), str(r.order_source, 12) || 'jushuitan',
        moneyOrNull(r.orders_total, '订单合计'), Number(r.order_count) || 0, str(r.note, 500), Math.max(1, Number(r.revision) || 1), r.created_at ? wall(r.created_at, '创建') : wall(r.end_at, '创建')]);
    return Number(ins.insertId);
  });
  await run('live_session_order', live.session_orders ?? [], async (r) => {
    const ins = await em.query('INSERT INTO live_session_orders (company_id, session_id, report_id, order_id, inner_order_id, amount_cents, pay_time, order_status, shop_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [companyId, sessionOf(r.session_id), ctx.lookup('live_session_report', r.report_id) ?? bad(`所属下播报告（旧 ID ${r.report_id}）没有迁入`), str(r.order_id, 64) ?? bad('订单号缺失'), str(r.inner_order_id, 64), money(r.amount, '订单金额'),
        r.pay_time ? wall(r.pay_time, '付款') : null, str(r.order_status, 32), str(r.shop_id, 64) ?? '']);
    return Number(ins.insertId);
  });

  await run('live_commission', live.commission_records ?? [], async (r) => {
    const cid = String(r.id), version = ruleOf.get(String(r.rule_version_id)) ?? bad(`规则版本（旧 ID ${r.rule_version_id}）没有迁入`);
    const role = String(r.role); if (!['anchor', 'control', 'operator'].includes(role)) bad('提成角色不认识');
    const snapshot = { versionId: version.id, effectiveFrom: version.from, rules: version.rules, belowRoi: Boolean(Number(r.below_roi)), legacySnapshot: json(r.rule_snapshot) };
    const ins = await em.query(
      `INSERT INTO live_commission_records (company_id, session_id, user_id, role, session_date, final_sales_cents, ad_spend_cents, roi_scaled, below_roi, rate_units, amount_cents, rule_version_id, rule_snapshot, approved_by, approved_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [companyId, sessionOf(r.session_id), user(r.employee_id, '提成人'), role, day(r.session_date, '场次'), money(r.final_sales, '最终销售额'), money(r.ad_spend, '投流费用'), scaled(r.roi, 4, '投产'), Number(r.below_roi) ? 1 : 0,
        scaled(r.rate, 2, '提成点数') ?? bad('提成点数缺失'), money(r.amount, '提成金额'), version.id, JSON.stringify(snapshot), approver(r.approved_by, 'live_commission', cid), r.approved_at ? wall(r.approved_at, '审核') : wall(r.session_date + ' 00:00:00', '审核')]);
    return Number(ins.insertId);
  });
  await run('live_wage', live.wage_records ?? [], async (r) => {
    const wid = String(r.id);
    const ins = await em.query(
      `INSERT INTO live_wage_records (company_id, session_id, user_id, session_date, start_at, end_at, minutes, hourly_rate_cents, rate_source, amount_cents, adjust_note, review_snapshot, approved_by, approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [companyId, sessionOf(r.session_id), user(r.employee_id, '主播'), day(r.session_date, '场次'), wall(r.start_at, '开始'), wall(r.end_at, '结束'), Number(r.minutes) || 0, money(r.hourly_rate, '时薪'),
        ['archive', 'manual'].includes(String(r.rate_source)) ? r.rate_source : bad('时薪来源不认识'), money(r.amount, '工资金额'), str(r.adjust_note, 500), r.review_snapshot ? JSON.stringify(json(r.review_snapshot)) : null,
        approver(r.approved_by, 'live_wage', wid), r.approved_at ? wall(r.approved_at, '审核') : wall(r.session_date + ' 00:00:00', '审核')]);
    return Number(ins.insertId);
  });

  await run('live_settlement', live.settlements ?? [], async (r) => {
    const sid = String(r.id); let status = String(r.status), returnReason = str(r.return_reason, 500);
    if (!['draft', 'submitted', 'returned', 'approved'].includes(status)) bad('结算单状态不认识');
    if (status === 'submitted') { status = 'returned'; returnReason = '旧系统审批中，迁入后需在新流程里重新提交'; ctx.note('live_settlement', sid, '旧系统审批中的结算单迁成「已退回」，需重新提交'); }
    if (!/^\d{4}-\d{2}$/.test(String(r.month))) bad('结算月份格式不对');
    const approved = status === 'approved';
    const ins = await em.query(
      `INSERT INTO live_settlements (company_id, month, status, record_count, commission_total_cents, refund_total_cents, deduction_total_cents, payable_total_cents, refunds_checked_at, note, return_reason, created_by, updated_by, submitted_by, submitted_at, approved_by, approved_at, revision, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [companyId, r.month, status, Number(r.record_count) || 0, money(r.commission_total, '提成合计'), money(r.refund_total, '退款合计'), money(r.deduction_total, '扣减合计'), money(r.payable_total, '应发合计'), r.refunds_checked_at ? wall(r.refunds_checked_at, '退款核对') : null,
        str(r.note, 500), returnReason, user(r.created_by, '创建人', true) ?? ctx.actorId, user(r.updated_by, '更新人', true), approved ? user(r.submitted_by, '提交人', true) : null, approved && r.submitted_at ? wall(r.submitted_at, '提交') : null,
        approved ? approver(r.approved_by, 'live_settlement', sid) : null, approved && r.approved_at ? wall(r.approved_at, '审批') : null, Math.max(1, Number(r.revision) || 1), r.created_at ? wall(r.created_at, '创建') : wall(`${r.month}-01 00:00:00`, '创建')]);
    return Number(ins.insertId);
  });
  const settlementOf = (v: unknown) => ctx.lookup('live_settlement', v) ?? bad(`月结单（旧 ID ${v}）没有迁入`);
  await run('live_settlement_line', live.settlement_lines ?? [], async (r) => {
    const ins = await em.query(
      `INSERT INTO live_settlement_lines (company_id, settlement_id, commission_record_id, session_id, user_id, role, session_date, final_sales_cents, rate_units, commission_cents, order_count, orders_total_cents, refund_cents, deduction_cents, payable_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [companyId, settlementOf(r.settlement_id), ctx.lookup('live_commission', r.commission_record_id) ?? bad(`提成记录（旧 ID ${r.commission_record_id}）没有迁入`), sessionOf(r.session_id), user(r.employee_id, '提成人'), String(r.role), day(r.session_date, '场次'),
        money(r.final_sales, '最终销售额'), scaled(r.rate, 2, '提成点数') ?? 0, money(r.commission_amount, '提成金额'), Number(r.order_count) || 0, money(r.orders_total, '订单合计'), money(r.refund_amount, '退款'), money(r.deduction, '扣减'), money(r.payable, '应发')]);
    return Number(ins.insertId);
  });
  await run('live_settlement_refund', live.settlement_refunds ?? [], async (r) => {
    const ins = await em.query('INSERT INTO live_settlement_refunds (company_id, settlement_id, session_id, order_id, order_amount_cents, refund_cents, refund_source, detail_json, checked_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [companyId, settlementOf(r.settlement_id), sessionOf(r.session_id), str(r.order_id, 64) ?? bad('订单号缺失'), money(r.order_amount, '订单金额'), money(r.refund_amount, '退款金额'), str(r.refund_source, 12) || 'none',
        r.detail_json ? JSON.stringify(json(r.detail_json)) : null, wall(r.checked_at, '核对')]);
    return Number(ins.insertId);
  });
}
