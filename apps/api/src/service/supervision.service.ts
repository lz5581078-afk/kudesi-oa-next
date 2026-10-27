import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  DEFAULT_SUPERVISION_RULES, SOON_MS, SPECIAL_PERMISSIONS, createChecker, escalationLevel,
  type ServiceSummary, type Severity, type SupervisionRuleDef, type SupervisionTarget,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { CaseLog, Company, Notification, ResourceRecord, SupervisionException, SupervisionRuleRow, User } from '../entities';
import { CaseSupport, parseRecipients } from './case-support';

const TARGETS: readonly SupervisionTarget[] = ['after_sales', 'appeal', 'flow', 'task'];
const LINK = '/supervision/center';

export interface ScanResult { created: number; escalated: number; resolved: number }
export interface ManualException { title: string; detail?: string; severity: Severity; ownerId?: number; storeId?: number }

/**
 * 兜底监督：未完成、超时、异常的事项从员工一路升级到主管和老板。
 * - 逾期的待办（售后工单、订单申诉、其他流程、任务）由扫描自动登记成异常（同一事项只登记一次），按逾期时长升级 L1 员工 → L2 主管 → L3 老板；
 * - 事项办完后异常自动解除；也可以手工登记异常、写跟进记录、写原因关闭；
 * - 阈值来自“监督规则”（每类一条，可在页面改；没改过用默认）。
 */
@Injectable()
export class SupervisionService {
  private readonly log = new Logger('Supervision');
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly support: CaseSupport) {}

  private can(user: AuthUser, key: string) { return createChecker(user.permissions)(key); }
  private canManage(user: AuthUser) { return this.can(user, SPECIAL_PERMISSIONS.supervisionManage); }

  // ================= 规则 =================

  async rules(companyId: number, em: EntityManager = this.ds.manager): Promise<SupervisionRuleDef[]> {
    const rows = await em.find(SupervisionRuleRow, { where: { companyId } });
    return DEFAULT_SUPERVISION_RULES.map((d) => {
      const r = rows.find((x) => x.targetType === d.targetType);
      return r ? {
        targetType: d.targetType, name: r.name, overdueMinutes: r.overdueMinutes, supervisorVisibleMinutes: r.supervisorVisibleMinutes, bossVisibleMinutes: r.bossVisibleMinutes,
        abnormalCondition: r.abnormalCondition, closeRequiresReason: r.closeRequiresReason, status: r.status,
      } : { ...d };
    });
  }

  async saveRule(user: AuthUser, target: string, b: Partial<Omit<SupervisionRuleDef, 'targetType' | 'name'>>) {
    if (!this.canManage(user)) throw new ForbiddenException('没有管理监督规则的权限');
    const def = DEFAULT_SUPERVISION_RULES.find((d) => d.targetType === target);
    if (!def) throw new NotFoundException('没有这种监督对象');
    const cur = (await this.rules(user.companyId)).find((r) => r.targetType === target)!;
    const next = { ...cur, ...b };
    const okMin = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 525_600;
    if (![next.overdueMinutes, next.supervisorVisibleMinutes, next.bossVisibleMinutes].every(okMin)) throw new BadRequestException('时间必须是 0 到 525600 之间的整数分钟');
    if (next.bossVisibleMinutes < next.supervisorVisibleMinutes) throw new BadRequestException('老板可见的时间不能早于主管可见的时间');
    if (!['active', 'inactive'].includes(next.status)) throw new BadRequestException('状态不对');
    const cond = String(next.abnormalCondition ?? '').trim().slice(0, 240);
    await this.ds.query(
      `INSERT INTO supervision_rules (company_id, target_type, name, overdue_minutes, supervisor_visible_minutes, boss_visible_minutes, abnormal_condition, close_requires_reason, status, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE overdue_minutes = VALUES(overdue_minutes), supervisor_visible_minutes = VALUES(supervisor_visible_minutes), boss_visible_minutes = VALUES(boss_visible_minutes),
         abnormal_condition = VALUES(abnormal_condition), close_requires_reason = VALUES(close_requires_reason), status = VALUES(status), updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`,
      [user.companyId, target, def.name, next.overdueMinutes, next.supervisorVisibleMinutes, next.bossVisibleMinutes, cond, next.closeRequiresReason ? 1 : 0, next.status, user.id]);
    return { ok: true };
  }

  // ================= 汇总（给首页/老板总控台调用） =================

  /**
   * 待处理数、逾期数等汇总。只按公司统计，不含个人敏感信息；金额为整数分。
   * 老板总控台/首页直接调用：`SupervisionService.summary(companyId)`（或 GET /api/supervision/summary）。
   */
  async summary(companyId: number, now = new Date()): Promise<ServiceSummary> {
    const soon = new Date(now.getTime() + SOON_MS);
    const [as] = await this.ds.query(
      `SELECT COALESCE(SUM(r.status = 'running'), 0) AS open, COALESCE(SUM(r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at < ?), 0) AS late,
              COALESCE(SUM(r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at >= ? AND r.due_at < ?), 0) AS soon,
              COALESCE(SUM(CASE WHEN r.status = 'running' THEN c.amount_cents END), 0) AS openAmount,
              COALESCE(SUM(CASE WHEN r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at < ? THEN c.amount_cents END), 0) AS lateAmount
         FROM after_sales_cases c JOIN flow_runs r ON r.id = c.run_id WHERE c.company_id = ?`, [now, now, soon, now, companyId]);
    const [ap] = await this.ds.query(
      `SELECT COALESCE(SUM(r.status = 'running'), 0) AS open, COALESCE(SUM(r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at < ?), 0) AS late,
              COALESCE(SUM(r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at >= ? AND r.due_at < ?), 0) AS soon,
              COALESCE(SUM(r.status = 'running' AND r.current_step_key = 'submit'), 0) AS toSubmit,
              COALESCE(SUM(CASE WHEN r.status = 'running' THEN a.amount_cents END), 0) AS openAmount
         FROM order_appeals a JOIN flow_runs r ON r.id = a.run_id WHERE a.company_id = ?`, [now, now, soon, companyId]);
    const [tk] = await this.ds.query(
      `SELECT COALESCE(SUM(status = 'open' AND (due_at IS NULL OR due_at >= ?)), 0) AS pending, COALESCE(SUM(status = 'open' AND due_at IS NOT NULL AND due_at < ?), 0) AS overdue,
              COALESCE(SUM(status = 'done'), 0) AS completed, COALESCE(SUM(status <> 'cancelled'), 0) AS total
         FROM work_items WHERE company_id = ? AND kind = 'task'`, [now, now, companyId]);
    const [fl] = await this.ds.query(
      `SELECT COALESCE(SUM(status = 'running'), 0) AS running, COALESCE(SUM(status = 'running' AND due_at IS NOT NULL AND due_at < ?), 0) AS overdue FROM flow_runs WHERE company_id = ?`, [now, companyId]);
    const [ex] = await this.ds.query(
      `SELECT COUNT(*) AS open, COALESCE(SUM(severity = 'urgent'), 0) AS urgent, COALESCE(SUM(level >= 2), 0) AS escalated FROM supervision_exceptions WHERE company_id = ? AND status = 'open'`, [companyId]);
    const n = (v: unknown) => Number(v ?? 0);
    return {
      asOf: now.toISOString(),
      afterSales: { open: n(as.open), overdue: n(as.late), dueSoon: n(as.soon), openAmountCents: n(as.openAmount), overdueAmountCents: n(as.lateAmount) },
      appeals: { open: n(ap.open), overdue: n(ap.late), dueSoon: n(ap.soon), toSubmit: n(ap.toSubmit), openAmountCents: n(ap.openAmount) },
      tasks: { pending: n(tk.pending), overdue: n(tk.overdue), completed: n(tk.completed), total: n(tk.total) },
      flows: { running: n(fl.running), overdue: n(fl.overdue) },
      exceptions: { open: n(ex.open), urgent: n(ex.urgent), escalated: n(ex.escalated) },
    };
  }

  // ================= 监督中心 =================

  async overview(user: AuthUser) {
    const now = new Date();
    const c = user.companyId;
    const summary = await this.summary(c, now);
    const exRows = await this.ds.manager.find(SupervisionException, { where: { companyId: c, status: 'open' }, order: { id: 'DESC' }, take: 300 });
    const closedRows = await this.ds.manager.find(SupervisionException, { where: [{ companyId: c, status: 'closed' }, { companyId: c, status: 'auto' }], order: { id: 'DESC' }, take: 30 });
    const stores = await this.storeNames(c, [...exRows, ...closedRows].map((e) => e.storeId ?? 0));
    const names = await this.support.userNames(c, [...exRows, ...closedRows].flatMap((e) => [e.ownerId ?? 0, e.closedBy ?? 0, e.createdBy ?? 0]));
    const rank = { urgent: 0, important: 1, normal: 2 } as const;
    const shape = (e: SupervisionException) => ({
      id: e.id, sourceType: e.sourceType, sourceId: e.sourceId, runId: e.runId, title: e.title, detail: e.detail, severity: e.severity, status: e.status, level: e.level,
      ownerId: e.ownerId, ownerName: e.ownerId ? names.get(e.ownerId) ?? '' : '', storeName: e.storeId ? stores.get(e.storeId) ?? '' : '', dueAt: e.dueAt,
      createdAt: e.createdAt, escalatedAt: e.escalatedAt, closeReason: e.closeReason, closedByName: e.closedBy ? names.get(e.closedBy) ?? '' : '', closedAt: e.closedAt,
      canClose: e.status === 'open' && (this.canManage(user) || (e.sourceType === 'manual' && e.createdBy === user.id)),
    });
    const exceptions = exRows.map(shape).sort((a, b) => rank[a.severity] - rank[b.severity] || b.level - a.level || b.id - a.id);
    const people = await this.ds.query(
      `SELECT u.id, u.name, u.title, u.status,
              COALESCE(SUM(w.status = 'open' AND (w.due_at IS NULL OR w.due_at >= ?)), 0) AS pending,
              COALESCE(SUM(w.status = 'open' AND w.due_at IS NOT NULL AND w.due_at < ?), 0) AS overdue,
              (SELECT COUNT(*) FROM supervision_exceptions e WHERE e.company_id = u.company_id AND e.owner_id = u.id AND e.status = 'open') AS exceptions
         FROM users u LEFT JOIN work_items w ON w.assignee_id = u.id AND w.company_id = u.company_id AND w.status = 'open'
        WHERE u.company_id = ? GROUP BY u.id HAVING pending > 0 OR overdue > 0 OR exceptions > 0
        ORDER BY overdue DESC, exceptions DESC, pending DESC LIMIT 200`, [now, now, c]);
    const alerts = await this.ds.query(
      `SELECT w.id, w.kind, w.run_id AS runId, w.title, u.name AS ownerName, w.due_at AS dueAt
         FROM work_items w JOIN users u ON u.id = w.assignee_id WHERE w.company_id = ? AND w.status = 'open' AND u.status <> 'active' ORDER BY w.due_at IS NULL, w.due_at ASC LIMIT 200`, [c]);
    return {
      asOf: now.toISOString(), summary, exceptions, closed: closedRows.map(shape),
      people: people.map((p: Record<string, unknown>) => ({ ...p, pending: Number(p.pending), overdue: Number(p.overdue), exceptions: Number(p.exceptions) })),
      assignmentAlerts: alerts, rules: await this.rules(c), canManage: this.canManage(user),
    };
  }

  private async storeNames(companyId: number, ids: number[]) {
    const uniq = [...new Set(ids.filter((x) => x > 0))];
    if (!uniq.length) return new Map<number, string>();
    const rows: Array<{ id: number; title: string }> = await this.ds.query(`SELECT id, title FROM resource_records WHERE company_id = ? AND type = 'stores' AND id IN (${uniq.map(() => '?').join(',')})`, [companyId, ...uniq]);
    return new Map(rows.map((r) => [r.id, r.title]));
  }

  async detail(user: AuthUser, id: number) {
    const e = await this.ds.manager.findOne(SupervisionException, { where: { id, companyId: user.companyId } });
    if (!e) throw new NotFoundException('异常不存在');
    return { logs: await this.support.logs(user.companyId, 'exception', id) };
  }

  /** 手工登记异常（“兜底”：系统没抓到的、人工发现的问题）。 */
  async register(user: AuthUser, b: ManualException) {
    const title = b.title?.trim();
    if (!title || title.length > 200) throw new BadRequestException('请写异常标题（不超过 200 字）');
    if (!['urgent', 'important', 'normal'].includes(b.severity)) throw new BadRequestException('请选择严重程度');
    if (b.detail && b.detail.length > 1000) throw new BadRequestException('说明不超过 1000 字');
    return this.ds.transaction(async (em) => {
      if (b.ownerId) {
        const u = await em.findOne(User, { where: { id: b.ownerId, companyId: user.companyId, status: 'active' } });
        if (!u) throw new BadRequestException('负责人不存在或已停用');
      }
      if (b.storeId) {
        const s = await em.findOne(ResourceRecord, { where: { id: b.storeId, companyId: user.companyId, type: 'stores' } });
        if (!s) throw new BadRequestException('店铺不存在');
      }
      const ins = await em.insert(SupervisionException, {
        companyId: user.companyId, sourceType: 'manual', sourceId: null, sourceKey: `manual:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title, detail: b.detail?.trim() || null,
        severity: b.severity, status: 'open', level: 1, ownerId: b.ownerId ?? null, storeId: b.storeId ?? null, createdBy: user.id,
      } as never);
      const id = Number(ins.identifiers[0].id);
      if (b.ownerId && b.ownerId !== user.id) await em.insert(Notification, { companyId: user.companyId, userId: b.ownerId, kind: 'exception', title: `${user.name} 登记了异常：${title}`.slice(0, 200), body: b.detail?.slice(0, 500) ?? null, link: LINK });
      await em.insert(CaseLog, { companyId: user.companyId, targetType: 'exception', targetId: id, userId: user.id, kind: 'system', content: '登记异常' });
      return { id };
    });
  }

  async close(user: AuthUser, id: number, reason?: string) {
    return this.ds.transaction(async (em) => {
      const e = await em.findOne(SupervisionException, { where: { id, companyId: user.companyId }, lock: { mode: 'pessimistic_write' } });
      if (!e) throw new NotFoundException('异常不存在');
      if (e.status !== 'open') throw new BadRequestException('这条异常已经处理过了');
      if (!(this.canManage(user) || (e.sourceType === 'manual' && e.createdBy === user.id))) throw new ForbiddenException('没有关闭异常的权限');
      const rules = await this.rules(user.companyId, em);
      const needReason = e.sourceType === 'manual' ? true : rules.find((r) => r.targetType === e.sourceType)?.closeRequiresReason ?? true;
      const text = reason?.trim() ?? '';
      if (needReason && !text) throw new BadRequestException('关闭异常要写原因');
      e.status = 'closed'; e.closeReason = text.slice(0, 500) || null; e.closedBy = user.id; e.closedAt = new Date();
      await em.save(SupervisionException, e);
      await em.insert(CaseLog, { companyId: user.companyId, targetType: 'exception', targetId: id, userId: user.id, kind: 'system', content: `关闭异常${text ? `：${text}` : ''}`.slice(0, 1000) });
      return { ok: true };
    });
  }

  async addLog(user: AuthUser, id: number, content: string) {
    const text = content?.trim();
    if (!text || text.length > 1000) throw new BadRequestException('请写跟进内容（不超过 1000 字）');
    const e = await this.ds.manager.findOne(SupervisionException, { where: { id, companyId: user.companyId } });
    if (!e) throw new NotFoundException('异常不存在');
    await this.ds.manager.insert(CaseLog, { companyId: user.companyId, targetType: 'exception', targetId: id, userId: user.id, kind: 'note', content: text });
    return { ok: true };
  }

  // ================= 扫描：登记、升级、自动解除 =================

  async scanAll(now = new Date()): Promise<ScanResult> {
    const total: ScanResult = { created: 0, escalated: 0, resolved: 0 };
    const companies = await this.ds.manager.find(Company, { where: { status: 'active' }, select: ['id'] });
    for (const c of companies) {
      try {
        const r = await this.scan(c.id, now);
        total.created += r.created; total.escalated += r.escalated; total.resolved += r.resolved;
      } catch (e) { this.log.error(`公司 ${c.id} 监督扫描失败：${(e as Error).message}`); }
    }
    return total;
  }

  private targetOf(kind: string, template: string | null): SupervisionTarget {
    if (kind === 'task') return 'task';
    return template === 'after-sales' ? 'after_sales' : template === 'order-appeal' ? 'appeal' : 'flow';
  }

  /** 谁是主管：流程配置的升级对象 + 办理人的直属上级 + 办理人所在部门主管；都没有就找公司管理员。 */
  private async supervisorsOf(em: EntityManager, companyId: number, ownerId: number | null, escalate: number[]): Promise<number[]> {
    const set = new Set<number>(escalate);
    if (ownerId) {
      const o = await em.findOne(User, { where: { id: ownerId, companyId }, select: ['id', 'managerId', 'departmentId'] });
      if (o?.managerId) set.add(o.managerId);
      if (o?.departmentId) {
        const [d] = await em.query('SELECT manager_id AS m FROM departments WHERE id = ? AND company_id = ?', [o.departmentId, companyId]);
        if (d?.m) set.add(Number(d.m));
      }
      set.delete(ownerId);
    }
    const active = set.size ? (await em.find(User, { where: { companyId, status: 'active' }, select: ['id'] })).map((u) => u.id).filter((id) => set.has(id)) : [];
    return active.length ? active : this.bossesOf(em, companyId, ownerId);
  }

  private async bossesOf(em: EntityManager, companyId: number, exclude: number | null): Promise<number[]> {
    const rows: Array<{ id: number }> = await em.query(
      `SELECT u.id FROM users u LEFT JOIN positions p ON p.id = u.position_id WHERE u.company_id = ? AND u.status = 'active' AND (u.is_company_admin = 1 OR p.level = 'boss')`, [companyId]);
    return rows.map((r) => Number(r.id)).filter((id) => id !== exclude);
  }

  private async notify(em: EntityManager, companyId: number, userIds: number[], title: string, body: string) {
    for (const uid of [...new Set(userIds)]) await em.insert(Notification, { companyId, userId: uid, kind: 'escalate', title: title.slice(0, 200), body: body.slice(0, 500), link: LINK });
  }

  async scan(companyId: number, now = new Date()): Promise<ScanResult> {
    const result: ScanResult = { created: 0, escalated: 0, resolved: 0 };
    const rules = await this.rules(companyId);
    const items: Array<Record<string, unknown>> = await this.ds.query(
      `SELECT w.id, w.kind, w.run_id AS runId, w.step_id AS stepId, w.assignee_id AS assigneeId, w.title, w.due_at AS dueAt, r.template_key AS template, r.escalate_user_ids AS escalate
         FROM work_items w LEFT JOIN flow_runs r ON r.id = w.run_id WHERE w.company_id = ? AND w.status = 'open' AND w.due_at IS NOT NULL AND w.due_at < ? ORDER BY w.id LIMIT 2000`, [companyId, now]);
    const seen = new Set<string>();
    for (const it of items) {
      const target = this.targetOf(String(it.kind), (it.template as string | null) ?? null);
      const rule = rules.find((r) => r.targetType === target)!;
      if (rule.status !== 'active') continue;
      const key = it.kind === 'task' ? `task:${it.id}` : `flow:${it.stepId}`;
      if (seen.has(key)) continue; // 部门共享的步骤有多行待办，只登记一次
      seen.add(key);
      const overdueMin = Math.floor((now.getTime() - new Date(String(it.dueAt)).getTime()) / 60000);
      if (overdueMin < rule.overdueMinutes) continue;
      const level = escalationLevel(overdueMin, rule);
      await this.ds.transaction(async (em) => {
        const ex = await em.findOne(SupervisionException, { where: { companyId, sourceKey: key }, lock: { mode: 'pessimistic_write' } });
        const ownerId = Number(it.assigneeId);
        const escalate = parseRecipients(it.escalate);
        if (!ex) {
          let sourceId: number | null = it.kind === 'task' ? Number(it.id) : Number(it.runId);
          let storeId: number | null = null;
          if (target === 'after_sales') { const [c] = await em.query('SELECT id, store_id AS storeId FROM after_sales_cases WHERE run_id = ? AND company_id = ?', [it.runId, companyId]); if (c) { sourceId = Number(c.id); storeId = Number(c.storeId); } }
          if (target === 'appeal') { const [a] = await em.query('SELECT id, store_id AS storeId FROM order_appeals WHERE run_id = ? AND company_id = ?', [it.runId, companyId]); if (a) { sourceId = Number(a.id); storeId = Number(a.storeId); } }
          const severity: Severity = level === 3 || target === 'after_sales' || target === 'appeal' ? 'urgent' : 'important';
          await em.insert(SupervisionException, {
            companyId, sourceType: target, sourceId, sourceKey: key, runId: it.runId ? Number(it.runId) : null, title: `${String(it.title)} 已${target === 'task' ? '逾期' : '超时'}`.slice(0, 200),
            detail: rule.abnormalCondition || null, severity, status: 'open', level, ownerId, storeId, dueAt: new Date(String(it.dueAt)), escalatedAt: level > 1 ? now : null,
          } as never);
          result.created += 1;
          if (level >= 2) await this.notify(em, companyId, await this.supervisorsOf(em, companyId, ownerId, escalate), `异常待跟进：${String(it.title)}`, `已超时 ${overdueMin} 分钟，规则：${rule.name}`);
          if (level >= 3) await this.notify(em, companyId, await this.bossesOf(em, companyId, ownerId), `异常已升级到老板：${String(it.title)}`, `已超时 ${overdueMin} 分钟`);
        } else if (ex.status === 'open' && level > ex.level) {
          ex.level = level; ex.escalatedAt = now; if (level === 3) ex.severity = 'urgent';
          await em.save(SupervisionException, ex);
          result.escalated += 1;
          if (level === 2) await this.notify(em, companyId, await this.supervisorsOf(em, companyId, ownerId, escalate), `异常升级到主管：${String(it.title)}`, `已超时 ${overdueMin} 分钟，规则：${rule.name}`);
          if (level === 3) await this.notify(em, companyId, await this.bossesOf(em, companyId, ownerId), `异常已升级到老板：${String(it.title)}`, `已超时 ${overdueMin} 分钟`);
        }
      }).catch((e) => { if ((e as { code?: string }).code !== 'ER_DUP_ENTRY') throw e; });
    }
    result.resolved = await this.autoResolve(companyId, now);
    return result;
  }

  /** 事项已经办完/取消，对应的自动登记异常自动解除。 */
  private async autoResolve(companyId: number, now: Date): Promise<number> {
    const open = await this.ds.manager.find(SupervisionException, { where: { companyId, status: 'open' } });
    let n = 0;
    for (const e of open) {
      const [kind, ref] = e.sourceKey.split(':');
      if (kind !== 'flow' && kind !== 'task') continue;
      const [row] = kind === 'flow'
        ? await this.ds.query("SELECT COUNT(*) AS n FROM flow_steps WHERE id = ? AND company_id = ? AND status = 'active'", [Number(ref), companyId])
        : await this.ds.query("SELECT COUNT(*) AS n FROM work_items WHERE id = ? AND company_id = ? AND status = 'open'", [Number(ref), companyId]);
      if (Number(row.n) > 0) continue;
      await this.ds.manager.update(SupervisionException, { id: e.id, status: 'open' }, { status: 'auto', closeReason: '事项已办理或已取消，系统自动解除', closedAt: now });
      n += 1;
    }
    return n;
  }
}
