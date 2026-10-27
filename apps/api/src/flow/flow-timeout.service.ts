import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { FLOW_TEMPLATES, createChecker, defaultTimeoutPolicy, normalizeTimeoutPolicy, penaltyCents, resolveTimeoutPolicy, type PolicyRow, type StepDef, type TimeoutPolicy } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { FlowTemplateRow } from '../entities';

const parse = <T,>(v: unknown, fallback: T): T => (typeof v === 'string' ? (JSON.parse(v) as T) : ((v as T) ?? fallback));
const PAGE = 20;

/**
 * 超时规则与处罚台账，以及督促时效提醒。
 * 规则分三层（公司默认 → 流程独立 → 节点独立，后者按段覆盖前者）；一次逾期记一条“超时事件”并固化当时的规则；
 * 处罚金额是整数分，只对“有明确个人办理人”的步骤计算，计算结果是待确认，必须由有权限的人确认或免除并写原因。
 */
@Injectable()
export class FlowTimeoutService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}
  private readonly log = new Logger('FlowTimeout');

  private can(user: AuthUser, key: string) { return createChecker(user.permissions)(key); }

  // ================= 规则 =================

  private async scope(em: EntityManager, user: AuthUser, templateKey: string, nodeKey: string) {
    if (templateKey.length > 40 || nodeKey.length > 40 || (!templateKey && nodeKey)) throw new BadRequestException('规则范围无效');
    if (!templateKey) return;
    const builtin = FLOW_TEMPLATES.some((t) => t.key === templateKey);
    if (!builtin && !(await em.findOne(FlowTemplateRow, { where: { companyId: user.companyId, templateKey } }))) throw new NotFoundException('流程不存在');
    if (nodeKey) {
      const defs: Array<{ steps: unknown }> = await em.query('SELECT steps FROM flow_definitions WHERE company_id = ? AND template_key = ? ORDER BY version DESC', [user.companyId, templateKey]);
      const keys = new Set<string>(defs.flatMap((d) => parse<StepDef[]>(d.steps, []).map((s) => s.key)));
      if (builtin) FLOW_TEMPLATES.find((t) => t.key === templateKey)!.steps.forEach((s) => keys.add(s.key));
      if (!keys.has(nodeKey)) throw new NotFoundException('节点不存在');
    }
  }

  private async rows(em: EntityManager, companyId: number): Promise<Array<PolicyRow & { revision: number }>> {
    const r: Array<{ template_key: string; node_key: string; policy: unknown; revision: number }> = await em.query('SELECT template_key, node_key, policy, revision FROM flow_timeout_policies WHERE company_id = ?', [companyId]);
    return r.map((x) => ({ templateKey: x.template_key, nodeKey: x.node_key, policy: parse<Partial<TimeoutPolicy>>(x.policy, {}), revision: Number(x.revision) }));
  }

  /** 某个范围的规则：自己保存的、继承来的、最终生效的；以及各层概览（给“流程独立规则”列表用） */
  async getPolicy(user: AuthUser, templateKey: string, nodeKey: string) {
    const em = this.ds.manager;
    await this.scope(em, user, templateKey, nodeKey);
    const rows = await this.rows(em, user.companyId);
    const own = rows.find((r) => r.templateKey === templateKey && r.nodeKey === nodeKey);
    const inherited = resolveTimeoutPolicy(rows.filter((r) => !(r.templateKey === templateKey && r.nodeKey === nodeKey)), templateKey, nodeKey);
    return {
      policy: own?.policy ?? (templateKey ? { notifications: null, penalties: null } : defaultTimeoutPolicy()),
      effective: resolveTimeoutPolicy(rows, templateKey, nodeKey), inherited, revision: own?.revision ?? 0,
      overrides: rows.filter((r) => r.templateKey).map((r) => ({ templateKey: r.templateKey, nodeKey: r.nodeKey })),
      canManage: this.can(user, 'flow.templates.manage'),
    };
  }

  async savePolicy(user: AuthUser, templateKey: string, nodeKey: string, input: unknown, revision: number) {
    if (!this.can(user, 'flow.templates.manage')) throw new ForbiddenException('没有配置流程的权限');
    const { policy, errors } = normalizeTimeoutPolicy(input, templateKey === '');
    if (errors.length) throw new BadRequestException(errors.join('；'));
    return this.ds.transaction(async (em) => {
      await this.scope(em, user, templateKey, nodeKey);
      const [before] = await em.query('SELECT policy, revision FROM flow_timeout_policies WHERE company_id = ? AND template_key = ? AND node_key = ? FOR UPDATE', [user.companyId, templateKey, nodeKey]);
      if (Number(revision) !== Number(before?.revision ?? 0)) throw new ConflictException('规则已被修改，请重新读取后保存');
      const ids = [policy.notifications?.supervisorUserId, policy.notifications?.bossUserId].filter((x): x is number => !!x);
      for (const id of ids) {
        const [u] = await em.query("SELECT id FROM users WHERE company_id = ? AND id = ? AND status = 'active'", [user.companyId, id]);
        if (!u) throw new BadRequestException('通知接收人不存在或已停用');
      }
      if (before && JSON.stringify(parse(before.policy, {})) === JSON.stringify(policy)) return { revision: Number(before.revision) };
      // 两段都沿用上一层 = 删除这一层的独立规则
      if (templateKey && !policy.notifications && !policy.penalties) {
        if (before) await em.query('DELETE FROM flow_timeout_policies WHERE company_id = ? AND template_key = ? AND node_key = ?', [user.companyId, templateKey, nodeKey]);
      } else {
        await em.query(
          `INSERT INTO flow_timeout_policies (company_id, template_key, node_key, policy, updated_by) VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE policy = VALUES(policy), revision = revision + 1, updated_by = VALUES(updated_by)`, [user.companyId, templateKey, nodeKey, JSON.stringify(policy), user.id]);
      }
      await em.query('INSERT INTO flow_timeout_events (company_id, kind, template_key, node_key, before_json, after_json, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [user.companyId, 'policy', templateKey, nodeKey, before ? JSON.stringify(parse(before.policy, {})) : null, JSON.stringify(policy), user.id]);
      return { revision: Number(before?.revision ?? 0) + 1 };
    });
  }

  // ================= 台账 =================

  async ledger(user: AuthUser, q: { templateKey?: string; status?: string; page: number }) {
    const em = this.ds.manager;
    const where = ['i.company_id = ?'];
    const args: unknown[] = [user.companyId];
    if (q.templateKey) { where.push('i.template_key = ?'); args.push(q.templateKey); }
    if (q.status === 'pending') where.push("p.status = 'pending'");
    else if (q.status === 'confirmed' || q.status === 'waived') { where.push('p.status = ?'); args.push(q.status); }
    else if (q.status === 'open') where.push("i.status = 'open'");
    const w = where.join(' AND ');
    const [{ n }] = await em.query(`SELECT COUNT(*) AS n FROM flow_timeout_incidents i LEFT JOIN flow_timeout_penalties p ON p.company_id = i.company_id AND p.incident_id = i.id WHERE ${w}`, args);
    const rows = await em.query(
      `SELECT i.id, i.run_id AS runId, i.template_key AS templateKey, i.step_key AS stepKey, i.assignee_id AS assigneeId, u.name AS assigneeName, i.sole_owner AS soleOwner, i.title,
              i.due_at AS dueAt, i.ended_at AS endedAt, i.overdue_minutes AS overdueMinutes, i.status, i.policy,
              p.id AS penaltyId, p.calculated_cents AS calculatedCents, p.confirmed_cents AS confirmedCents, p.status AS penaltyStatus, p.reason AS penaltyReason, p.revision AS penaltyRevision
       FROM flow_timeout_incidents i LEFT JOIN users u ON u.id = i.assignee_id LEFT JOIN flow_timeout_penalties p ON p.company_id = i.company_id AND p.incident_id = i.id
       WHERE ${w} ORDER BY i.id DESC LIMIT ? OFFSET ?`, [...args, PAGE, (q.page - 1) * PAGE]);
    const ids = rows.map((r: { id: number }) => r.id);
    const evs: Array<{ ref_id: number; after_json: unknown }> = ids.length ? await em.query(`SELECT ref_id, after_json FROM flow_timeout_events WHERE company_id = ? AND kind = 'escalate' AND ref_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, [user.companyId, ...ids]) : [];
    const labels = new Map<string, string>(FLOW_TEMPLATES.map((t) => [t.key, t.label]));
    for (const r of await em.find(FlowTemplateRow, { where: { companyId: user.companyId }, select: ['templateKey', 'name'] })) labels.set(r.templateKey, r.name);
    return {
      total: Number(n), page: q.page, pageSize: PAGE, canDecide: this.can(user, 'flow.penalties.manage'),
      rows: rows.map((r: Record<string, unknown> & { id: number; templateKey: string }) => ({
        ...r, soleOwner: !!r.soleOwner, templateLabel: labels.get(r.templateKey) ?? r.templateKey, policy: parse(r.policy, {}),
        notifications: evs.filter((e) => e.ref_id === r.id).map((e) => parse<Record<string, unknown>>(e.after_json, {})),
      })),
    };
  }

  /** 确认或免除处罚：必须写原因；金额不能超过计算值；留痕 */
  async decidePenalty(user: AuthUser, id: number, b: { status: string; amountCents: number; reason: string; revision: number }) {
    if (!this.can(user, 'flow.penalties.manage')) throw new ForbiddenException('没有确认处罚的权限');
    const reason = (b.reason ?? '').trim();
    if (!['confirmed', 'waived'].includes(b.status) || !reason || reason.length > 500 || !Number.isInteger(b.amountCents) || b.amountCents < 0) throw new BadRequestException('请填写处理结果、有效金额和原因');
    return this.ds.transaction(async (em) => {
      const [before] = await em.query('SELECT * FROM flow_timeout_penalties WHERE company_id = ? AND id = ? FOR UPDATE', [user.companyId, id]);
      if (!before) throw new NotFoundException('处罚记录不存在');
      if (before.status !== 'pending' || Number(b.revision) !== Number(before.revision)) throw new ConflictException('处罚已被处理或计算金额已变化，请刷新');
      if (b.amountCents > Number(before.calculated_cents)) throw new BadRequestException('确认金额不能超过计算金额');
      const amount = b.status === 'waived' ? 0 : b.amountCents;
      await em.query('UPDATE flow_timeout_penalties SET status = ?, confirmed_cents = ?, reason = ?, confirmed_by = ?, confirmed_at = NOW(), revision = revision + 1 WHERE company_id = ? AND id = ?', [b.status, amount, reason, user.id, user.companyId, id]);
      await em.query('INSERT INTO flow_timeout_events (company_id, kind, ref_id, before_json, after_json, actor_id) VALUES (?, ?, ?, ?, ?, ?)',
        [user.companyId, 'penalty', id, JSON.stringify({ status: before.status, calculatedCents: Number(before.calculated_cents) }), JSON.stringify({ status: b.status, confirmedCents: amount, reason }), user.id]);
      return { ok: true };
    });
  }

  // ================= 扫描（每分钟） =================

  private async notify(em: EntityManager, companyId: number, userIds: number[], n: { kind: string; title: string; body?: string; link?: string }) {
    for (const uid of [...new Set(userIds)]) {
      await em.query('INSERT INTO notifications (company_id, user_id, kind, title, body, link) VALUES (?, ?, ?, ?, ?, ?)', [companyId, uid, n.kind, n.title.slice(0, 200), n.body?.slice(0, 500) ?? null, n.link ?? null]);
    }
  }

  /** 登记一次提醒记录；已经发过（唯一键冲突）返回 false */
  private async once(em: EntityManager, companyId: number, workItemId: number, kind: string) {
    const r = await em.query('INSERT IGNORE INTO flow_reminder_logs (company_id, work_item_id, kind) VALUES (?, ?, ?)', [companyId, workItemId, kind]);
    return Number(r.affectedRows) === 1;
  }

  async tick(now = new Date()) {
    let n = 0;
    n += await this.reminders(now);
    n += await this.incidents(now);
    return n;
  }

  /** 督促时效：到期前 N 分钟提醒、超时后每隔 M 分钟再提醒；每条提醒只发一次 */
  async reminders(now: Date) {
    const items: Array<{ id: number; company_id: number; assignee_id: number; title: string; due_at: Date; run_id: number; step_key: string; steps: unknown }> = await this.ds.query(
      `SELECT w.id, w.company_id, w.assignee_id, w.title, w.due_at, w.run_id, s.step_key, r.steps_snapshot AS steps
       FROM work_items w JOIN flow_steps s ON s.id = w.step_id JOIN flow_runs r ON r.id = w.run_id
       WHERE w.kind = 'flow' AND w.status = 'open' AND w.due_at IS NOT NULL AND r.status = 'running' LIMIT 1000`);
    let sent = 0;
    for (const it of items) {
      const def = parse<StepDef[]>(it.steps, []).find((s) => s.key === it.step_key);
      const remind = def?.remind;
      if (!remind) continue;
      const due = new Date(it.due_at).getTime();
      const left = (due - now.getTime()) / 60_000;
      const link = `/workbench/todos?run=${it.run_id}`;
      await this.ds.transaction(async (em) => {
        if (left > 0) {
          for (const m of remind.beforeMinutes) {
            if (left <= m && (await this.once(em, it.company_id, it.id, `before:${m}`))) {
              await this.notify(em, it.company_id, [it.assignee_id], { kind: 'remind', title: `即将到期：${it.title}`, body: `还剩不到 ${Math.ceil(left)} 分钟`, link });
              sent += 1;
              break; // 同一轮只发最接近的一条
            }
          }
        } else if (remind.overdueEveryMinutes) {
          const k = Math.floor(-left / remind.overdueEveryMinutes);
          if (k >= 1 && k <= 50 && (await this.once(em, it.company_id, it.id, `over:${k}`))) {
            await this.notify(em, it.company_id, [it.assignee_id], { kind: 'remind', title: `已超时，请尽快办理：${it.title}`, body: `已超时 ${Math.floor(-left)} 分钟`, link });
            sent += 1;
          }
        }
      });
    }
    return sent;
  }

  private policyRows = new Map<number, { at: number; rows: PolicyRow[] }>();
  private async policyFor(companyId: number, templateKey: string, stepKey: string) {
    const c = this.policyRows.get(companyId);
    let rows = c && Date.now() - c.at < 30_000 ? c.rows : null;
    if (!rows) { rows = await this.rows(this.ds.manager, companyId); this.policyRows.set(companyId, { at: Date.now(), rows }); }
    return resolveTimeoutPolicy(rows, templateKey, stepKey).policy;
  }

  /** 超时事件：逾期中的待办记一条“进行中”事件，办完/被取消后收口；已经按期外办完的补一条已结束事件；同时发通知与计算处罚 */
  async incidents(now: Date) {
    const base = `SELECT w.id, w.company_id, w.run_id, w.step_id, w.assignee_id, w.title, w.due_at, w.status AS item_status, w.finished_at, r.template_key, s.step_key, s.recipients,
                         TIMESTAMPDIFF(SECOND, w.due_at, COALESCE(w.finished_at, ?)) AS secs
                  FROM work_items w JOIN flow_steps s ON s.id = w.step_id JOIN flow_runs r ON r.id = w.run_id`;
    const open: Array<Record<string, unknown>> = await this.ds.query(`${base} WHERE w.kind = 'flow' AND w.status = 'open' AND w.due_at < ? ORDER BY w.id LIMIT 500`, [now, now]);
    const late: Array<Record<string, unknown>> = await this.ds.query(
      `${base} WHERE w.kind = 'flow' AND w.status = 'done' AND w.finished_at > w.due_at AND w.finished_at > DATE_SUB(?, INTERVAL 3 DAY)
         AND NOT EXISTS (SELECT 1 FROM flow_timeout_incidents i WHERE i.company_id = w.company_id AND i.work_item_id = w.id AND i.due_at = w.due_at) ORDER BY w.id LIMIT 200`, [now, now]);
    const closing: Array<Record<string, unknown>> = await this.ds.query(
      `${base} JOIN flow_timeout_incidents oi ON oi.company_id = w.company_id AND oi.work_item_id = w.id AND oi.due_at = w.due_at AND oi.status = 'open'
       WHERE w.kind = 'flow' AND w.status <> 'open' ORDER BY w.id LIMIT 200`, [now]);
    let n = 0;
    for (const row of [...open, ...late, ...closing]) {
      try { await this.ds.transaction((em) => this.processItem(em, row, now)); n += 1; }
      catch (e) { this.log.error(`超时事件处理失败（待办 ${String(row.id)}）：${(e as Error).message}`); }
    }
    return n;
  }

  private async processItem(em: EntityManager, it: Record<string, unknown>, now: Date) {
    const companyId = Number(it.company_id), itemId = Number(it.id);
    const status = it.item_status === 'open' ? 'open' : it.item_status === 'done' ? 'closed' : 'cancelled';
    const minutes = Math.max(0, Math.floor(Number(it.secs) / 60));
    if (minutes < 1 && status === 'open') return;
    const recipients = parse<number[]>(it.recipients, []);
    const policy = await this.policyFor(companyId, String(it.template_key), String(it.step_key));
    const [existing] = await em.query('SELECT id, policy, status FROM flow_timeout_incidents WHERE company_id = ? AND work_item_id = ? AND due_at = ? FOR UPDATE', [companyId, itemId, it.due_at]);
    let incidentId: number;
    let snapshot = policy;
    if (existing) {
      incidentId = Number(existing.id);
      snapshot = parse(existing.policy, policy);
      await em.query('UPDATE flow_timeout_incidents SET overdue_minutes = ?, status = ?, ended_at = ? WHERE id = ?', [minutes, status, status === 'open' ? null : it.finished_at ?? now, incidentId]);
    } else {
      const r = await em.query(
        `INSERT INTO flow_timeout_incidents (company_id, work_item_id, run_id, step_id, template_key, step_key, assignee_id, sole_owner, title, due_at, ended_at, overdue_minutes, policy, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [companyId, itemId, it.run_id, it.step_id, it.template_key, it.step_key, it.assignee_id, recipients.length === 1 ? 1 : 0, String(it.title).slice(0, 255), it.due_at, status === 'open' ? null : it.finished_at ?? now, minutes, JSON.stringify(policy), status]);
      incidentId = Number(r.insertId);
    }
    if (status === 'cancelled') return;
    // 通知：到阈值时通知主管/老板，每个事件每一级只通知一次（办完后补收口的事件不再通知）
    const nt = snapshot.notifications;
    if (status === 'open' && nt?.enabled) {
      for (const [level, threshold] of [['supervisor', nt.supervisorAfterMinutes], ['boss', nt.bossAfterMinutes]] as const) {
        if (minutes < threshold || !(await this.once(em, companyId, itemId, `${level}:${incidentId}`))) continue;
        const to = await this.receivers(em, companyId, level, nt, Number(it.assignee_id));
        if (to.length) await this.notify(em, companyId, to, { kind: 'escalate', title: `${level === 'supervisor' ? '主管提醒' : '老板提醒'}：${String(it.title)} 已超时 ${minutes} 分钟`, link: `/flow/overview?run=${String(it.run_id)}` });
        await em.query('INSERT INTO flow_timeout_events (company_id, kind, ref_id, after_json, actor_id) VALUES (?, ?, ?, ?, ?)',
          [companyId, 'escalate', incidentId, JSON.stringify({ level, atMinutes: threshold, recipientIds: to, error: to.length ? null : level === 'supervisor' ? '未找到办理人的上级或部门主管' : '未找到老板通知接收人' }), 0]);
      }
    }
    // 处罚：只对有明确个人办理人的步骤；金额只增不减，确认/免除后不再变
    const pen = snapshot.penalties;
    const cents = recipients.length === 1 ? penaltyCents(pen, minutes) : 0;
    if (pen && cents > 0) {
      const scope = pen.unit === 'task' ? `task:${itemId}:${String(it.due_at)}` : `node:${String(it.step_id)}`;
      const key = crypto.createHash('sha256').update(JSON.stringify([companyId, scope, it.assignee_id, pen])).digest('hex');
      await em.query(
        `INSERT INTO flow_timeout_penalties (company_id, penalty_key, incident_id, assignee_id, calculated_cents) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE revision = revision + IF(status = 'pending' AND VALUES(calculated_cents) > calculated_cents, 1, 0),
           calculated_cents = IF(status = 'pending', GREATEST(calculated_cents, VALUES(calculated_cents)), calculated_cents)`, [companyId, key, incidentId, it.assignee_id, cents]);
    }
  }

  private async receivers(em: EntityManager, companyId: number, level: 'supervisor' | 'boss', nt: NonNullable<TimeoutPolicy['notifications']>, assigneeId: number): Promise<number[]> {
    const active = async (ids: number[]) => (ids.length ? (await em.query(`SELECT id FROM users WHERE company_id = ? AND status = 'active' AND id IN (${ids.map(() => '?').join(',')})`, [companyId, ...ids])).map((x: { id: number }) => Number(x.id)) : []);
    if (level === 'supervisor') {
      if (nt.supervisorReceiver === 'employee') return nt.supervisorUserId ? active([nt.supervisorUserId]) : [];
      const [u] = await em.query('SELECT manager_id AS m, department_id AS d FROM users WHERE company_id = ? AND id = ?', [companyId, assigneeId]);
      let m = u?.m ? Number(u.m) : null;
      if (!m && u?.d) { const [d] = await em.query('SELECT manager_id AS m FROM departments WHERE company_id = ? AND id = ?', [companyId, u.d]); m = d?.m ? Number(d.m) : null; }
      return m && m !== assigneeId ? active([m]) : [];
    }
    if (nt.bossReceiver === 'employee') return nt.bossUserId ? active([nt.bossUserId]) : [];
    return (await em.query("SELECT id FROM users WHERE company_id = ? AND status = 'active' AND is_company_admin = 1", [companyId])).map((x: { id: number }) => Number(x.id));
  }
}
