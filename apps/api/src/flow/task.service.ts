import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { createChecker, dueEndOfDay, routineMatches, TASK_FEEDBACK_PRESETS, todayInChina, validateFeedback, validateRoutine, type RoutineRule } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Notification, TaskDelayRequest, TaskRoutine, User, WorkItem } from '../entities';

export interface RoutineInput extends RoutineRule {
  title: string; description?: string | null; assigneeId: number; dueDays: number; active?: boolean;
  supervisorId?: number | null; requiresReview?: boolean; feedbackPreset?: string | null; completionStandard?: string | null;
}

export interface TaskCreateInput {
  title: string; description?: string; assigneeId?: number; dueDate?: string;
  supervisorId?: number; requiresReview?: boolean; feedbackPreset?: string; completionStandard?: string;
}

/** 任务中心：手工任务（指派给自己或别人）和周期任务（到点自动生成）。任务和流程待办放在同一张待办表里。 */
@Injectable()
export class TaskService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private can(user: AuthUser, key: string) { return createChecker(user.permissions)(key); }
  private async activeUser(em: EntityManager, companyId: number, id: number) {
    const u = await em.findOne(User, { where: { id, companyId, status: 'active' } });
    if (!u) throw new BadRequestException('负责人不存在或已停用');
    return u;
  }
  private notify(em: EntityManager, companyId: number, userId: number, title: string, kind = 'task') {
    return em.insert(Notification, { companyId, userId, kind, title: title.slice(0, 200), body: null, link: '/workbench/todos' });
  }

  /** 监督/复核/反馈模板的公共校验：监督人要是本公司在职员工；要复核必须有监督人或指派人；反馈模板要存在。 */
  private async checkSupervision(em: EntityManager, companyId: number, p: { supervisorId?: number | null; requiresReview?: boolean; feedbackPreset?: string | null; completionStandard?: string | null }, hasCreator: boolean) {
    if (p.supervisorId) await this.activeUser(em, companyId, p.supervisorId).catch(() => { throw new BadRequestException('监督人不存在或已停用'); });
    if (p.requiresReview && !p.supervisorId && !hasCreator) throw new BadRequestException('需要复核的任务请指定监督人');
    if (p.feedbackPreset && !TASK_FEEDBACK_PRESETS[p.feedbackPreset]) throw new BadRequestException('反馈模板不存在');
    if ((p.completionStandard?.length ?? 0) > 500) throw new BadRequestException('完成标准不超过 500 字');
  }

  async create(user: AuthUser, p: TaskCreateInput) {
    const title = p.title?.trim();
    if (!title || title.length > 150) throw new BadRequestException('任务标题必填，不超过 150 字');
    const assigneeId = p.assigneeId ?? user.id;
    if (assigneeId !== user.id && !this.can(user, 'tasks.assign')) throw new ForbiddenException('没有给别人指派任务的权限');
    if (p.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate)) throw new BadRequestException('截止日期格式不对');
    if (p.dueDate && p.dueDate < todayInChina()) throw new BadRequestException('截止日期不能早于今天');
    return this.dataSource.transaction(async (em) => {
      await this.activeUser(em, user.companyId, assigneeId);
      await this.checkSupervision(em, user.companyId, p, true);
      const ins = await em.insert(WorkItem, {
        companyId: user.companyId, kind: 'task', runId: null, stepId: null, assigneeId, createdBy: user.id, title, description: p.description?.trim() || null,
        status: 'open', dueAt: p.dueDate ? dueEndOfDay(p.dueDate, 1) : null,
        supervisorId: p.supervisorId || null, requiresReview: !!p.requiresReview, feedbackPreset: p.feedbackPreset || null, completionStandard: p.completionStandard?.trim() || null,
      } as never);
      if (assigneeId !== user.id) await this.notify(em, user.companyId, assigneeId, `${user.name} 给你指派了任务：${title}`);
      if (p.supervisorId && p.supervisorId !== user.id && p.supervisorId !== assigneeId) await this.notify(em, user.companyId, p.supervisorId, `你被指定监督任务：${title}`);
      return { id: Number(ins.identifiers[0].id) };
    });
  }

  /** 取出并锁定任务。进行中（status=open）才能操作；已提交（submitted_at 有值）的任务在等复核，负责人不能再改，复核时 submitted 要为 true。 */
  private async lockTask(em: EntityManager, user: AuthUser, id: number, submitted: boolean | null = false) {
    const t = await em.findOne(WorkItem, { where: { id, companyId: user.companyId, kind: 'task' }, lock: { mode: 'pessimistic_write' } });
    if (!t) throw new NotFoundException('任务不存在');
    if (t.status !== 'open') throw new BadRequestException('这条任务已经结束了');
    if (submitted === false && t.submittedAt) throw new BadRequestException('已提交复核，等监督人处理');
    if (submitted === true && !t.submittedAt) throw new BadRequestException('负责人还没有提交');
    return t;
  }

  /** 复核/批准延期的人：有监督人是监督人，没有就是指派人；公司管理员也可以代办。 */
  private reviewerOf(t: WorkItem) { return t.supervisorId ?? t.createdBy; }
  /** 监督人、指派人、公司管理员都可以复核（指派人也能在“个人任务”页复核，两边是同一份数据）。 */
  private canReview(user: AuthUser, t: WorkItem) { return t.supervisorId === user.id || t.createdBy === user.id || user.permissions.isCompanyAdmin; }

  /**
   * 负责人提交任务。
   * - 有反馈模板：必须按模板填反馈；没有模板：写一句完成情况即可（和以前一样）。
   * - “异常提交”：事情没办成/发现问题，必须写说明，任务进入“异常”等监督人处理，不算完成。
   * - 要复核的任务提交后是“待复核”，监督人通过才算完成；不要复核的直接完成。
   */
  async complete(user: AuthUser, id: number, note?: string, opts: { payload?: Record<string, unknown>; abnormal?: boolean } = {}) {
    return this.dataSource.transaction(async (em) => {
      const t = await this.lockTask(em, user, id);
      if (t.assigneeId !== user.id) throw new ForbiddenException('只有负责人能完成任务');
      const text = note?.trim().slice(0, 500) || null;
      const payload = opts.payload ?? {};
      if (opts.abnormal && !text) throw new BadRequestException('异常提交要写清楚是什么问题');
      if (t.feedbackPreset && !opts.abnormal) {
        const errs = validateFeedback(t.feedbackPreset, payload);
        if (errs.length) throw new BadRequestException(errs.join('；'));
      } else if (t.feedbackPreset && Object.keys(payload).length) {
        const errs = validateFeedback(t.feedbackPreset, payload).filter((e) => !e.startsWith('请至少'));
        if (errs.length) throw new BadRequestException(errs.join('；'));
      }
      const now = new Date();
      t.doneNote = text; t.submitPayload = Object.keys(payload).length ? payload : null; t.startedAt = t.startedAt ?? now; t.reviewNote = null;
      const reviewer = this.reviewerOf(t);
      const toReview = !!opts.abnormal || t.requiresReview;
      t.isAbnormal = !!opts.abnormal;
      if (toReview) t.submittedAt = now;
      else { t.status = 'done'; t.finishedAt = now; }
      await em.save(WorkItem, t);
      if (reviewer && reviewer !== user.id) {
        const tail = opts.abnormal ? `异常提交了任务：${t.title}` : toReview ? `提交了任务等你复核：${t.title}` : `完成了任务：${t.title}`;
        await this.notify(em, user.companyId, reviewer, `${user.name} ${tail}`, toReview ? 'task' : 'result');
      }
      return { ok: true, status: opts.abnormal ? 'abnormal' : toReview ? 'reviewing' : 'done' };
    });
  }

  /** 监督人复核：通过（任务完成）或退回（回到负责人手里重做，必须写原因）。异常提交的任务也是这样处理。 */
  async review(user: AuthUser, id: number, p: { action: 'approve' | 'return'; comment?: string }) {
    return this.dataSource.transaction(async (em) => {
      const t = await this.lockTask(em, user, id, true);
      if (!this.canReview(user, t)) throw new ForbiddenException('只有监督人或指派人能复核');
      const comment = p.comment?.trim().slice(0, 500) || null;
      if (p.action === 'return' && !comment) throw new BadRequestException('退回要写明原因');
      t.reviewNote = comment;
      if (p.action === 'approve') { t.status = 'done'; t.finishedAt = new Date(); }
      else { t.submittedAt = null; t.isAbnormal = false; }
      await em.save(WorkItem, t);
      await this.notify(em, user.companyId, t.assigneeId, p.action === 'approve' ? `任务复核通过：${t.title}` : `任务被退回，请重做：${t.title}${comment ? `（${comment}）` : ''}`, p.action === 'approve' ? 'result' : 'returned');
      return { ok: true };
    });
  }

  /** 负责人申请延期：写新截止日和原因，监督人（没有就是指派人）同意后截止时间才改。同一任务同时只能有一条待处理的申请。 */
  async requestDelay(user: AuthUser, id: number, p: { dueDate: string; reason: string }) {
    const reason = p.reason?.trim();
    if (!reason) throw new BadRequestException('请写明延期原因');
    if (reason.length > 500) throw new BadRequestException('延期原因不超过 500 字');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate ?? '')) throw new BadRequestException('新的截止日期格式不对');
    if (p.dueDate < todayInChina()) throw new BadRequestException('新的截止日期不能早于今天');
    return this.dataSource.transaction(async (em) => {
      const t = await this.lockTask(em, user, id);
      if (t.assigneeId !== user.id) throw new ForbiddenException('只有负责人能申请延期');
      const approver = this.reviewerOf(t);
      if (!approver) throw new BadRequestException('这条任务没有监督人，请联系管理员调整截止时间');
      const requested = dueEndOfDay(p.dueDate, 1);
      if (t.dueAt && requested <= t.dueAt) throw new BadRequestException('新的截止日期要晚于现在的截止时间');
      if (await em.count(TaskDelayRequest, { where: { companyId: user.companyId, workItemId: id, status: 'pending' } })) throw new BadRequestException('已经有一条延期申请在等处理');
      const ins = await em.insert(TaskDelayRequest, { companyId: user.companyId, workItemId: id, requesterId: user.id, approverId: approver, oldDueAt: t.dueAt, requestedDueAt: requested, reason } as never);
      if (approver !== user.id) await this.notify(em, user.companyId, approver, `${user.name} 申请延期：${t.title}（延到 ${p.dueDate}）`);
      return { id: Number(ins.identifiers[0].id) };
    });
  }

  /** 监督人处理延期申请：同意则任务截止时间改成新的，并重新开始逾期提醒。 */
  async decideDelay(user: AuthUser, reqId: number, p: { approve: boolean; comment?: string }) {
    return this.dataSource.transaction(async (em) => {
      const r = await em.findOne(TaskDelayRequest, { where: { id: reqId, companyId: user.companyId }, lock: { mode: 'pessimistic_write' } });
      if (!r) throw new NotFoundException('延期申请不存在');
      if (r.status !== 'pending') throw new BadRequestException('这条延期申请已经处理过了');
      if (r.approverId !== user.id && !user.permissions.isCompanyAdmin) throw new ForbiddenException('只有监督人或指派人能处理延期申请');
      const comment = p.comment?.trim().slice(0, 500) || null;
      if (!p.approve && !comment) throw new BadRequestException('不同意要写明原因');
      const t = await em.findOne(WorkItem, { where: { id: r.workItemId, companyId: user.companyId, kind: 'task' }, lock: { mode: 'pessimistic_write' } });
      if (!t || t.status !== 'open') throw new BadRequestException('任务已经结束，不用再处理延期了');
      r.status = p.approve ? 'approved' : 'rejected'; r.approvalComment = comment; r.decidedAt = new Date();
      await em.save(TaskDelayRequest, r);
      if (p.approve) { t.dueAt = r.requestedDueAt; t.overdueNotifiedAt = null; await em.save(WorkItem, t); }
      await this.notify(em, user.companyId, r.requesterId, p.approve ? `延期已同意：${t.title}` : `延期被拒绝：${t.title}${comment ? `（${comment}）` : ''}`, 'result');
      return { ok: true };
    });
  }

  /** 指派人或公司管理员可以取消；周期任务生成的（没有指派人）只有管理员能取消。 */
  async cancel(user: AuthUser, id: number) {
    return this.dataSource.transaction(async (em) => {
      const t = await this.lockTask(em, user, id);
      if (!(t.createdBy === user.id || user.permissions.isCompanyAdmin || this.can(user, 'tasks.routines.manage'))) throw new ForbiddenException('只有指派人或管理员能取消任务');
      t.status = 'cancelled'; t.finishedAt = new Date();
      await em.save(WorkItem, t);
      if (t.assigneeId !== user.id) await this.notify(em, user.companyId, t.assigneeId, `任务已取消：${t.title}`);
      return { ok: true };
    });
  }

  private async taskRows(where: string[], args: unknown[], q: { status?: string; page: number; pageSize: number }) {
    // 页面上的“待复核/异常”不是 status：status 仍是 open，靠 submitted_at 和 is_abnormal 区分
    const byStage: Record<string, string> = { open: "w.status = 'open' AND w.submitted_at IS NULL", reviewing: "w.status = 'open' AND w.submitted_at IS NOT NULL AND w.is_abnormal = 0", abnormal: "w.status = 'open' AND w.submitted_at IS NOT NULL AND w.is_abnormal = 1", done: "w.status = 'done'", cancelled: "w.status = 'cancelled'" };
    if (q.status) { if (!byStage[q.status]) throw new BadRequestException('状态不合法'); where.push(byStage[q.status]); }
    const w = where.join(' AND ');
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n FROM work_items w WHERE ${w}`, args);
    const rows = await this.dataSource.query(
      `SELECT w.id, w.title, w.description, w.status, w.due_at AS dueAt, w.created_at AS createdAt, w.finished_at AS finishedAt, w.done_note AS doneNote,
              w.requires_review AS requiresReview, w.feedback_preset AS feedbackPreset, w.completion_standard AS completionStandard, w.submit_payload AS submitPayload,
              w.submitted_at AS submittedAt, w.review_note AS reviewNote, w.is_abnormal AS isAbnormal, w.assignee_id AS assigneeId, w.supervisor_id AS supervisorId,
              u.name AS assigneeName, sv.name AS supervisorName, cu.name AS creatorName,
              (SELECT d.id FROM task_delay_requests d WHERE d.work_item_id = w.id AND d.status = 'pending' LIMIT 1) AS delayId,
              (SELECT d.requested_due_at FROM task_delay_requests d WHERE d.work_item_id = w.id AND d.status = 'pending' LIMIT 1) AS delayDueAt,
              (SELECT d.reason FROM task_delay_requests d WHERE d.work_item_id = w.id AND d.status = 'pending' LIMIT 1) AS delayReason
       FROM work_items w JOIN users u ON u.id = w.assignee_id LEFT JOIN users sv ON sv.id = w.supervisor_id LEFT JOIN users cu ON cu.id = w.created_by
       WHERE ${w} ORDER BY w.id DESC LIMIT ? OFFSET ?`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    const now = new Date();
    return {
      total: Number(n), page: q.page, pageSize: q.pageSize,
      rows: rows.map((r: { status: string; dueAt: Date | null; requiresReview: number; isAbnormal: number; submittedAt: Date | null; submitPayload: unknown }) => ({
        ...r, requiresReview: Number(r.requiresReview) === 1, isAbnormal: Number(r.isAbnormal) === 1,
        stage: r.status !== 'open' ? r.status : !r.submittedAt ? 'open' : Number(r.isAbnormal) === 1 ? 'abnormal' : 'reviewing',
        submitPayload: typeof r.submitPayload === 'string' ? JSON.parse(r.submitPayload) : r.submitPayload,
        overdue: r.status === 'open' && !!r.dueAt && r.dueAt < now,
      })),
    };
  }

  /** 我指派的任务（含指派给自己的）。 */
  assigned(user: AuthUser, q: { status?: string; page: number; pageSize: number }) {
    return this.taskRows(['w.company_id = ?', "w.kind = 'task'", 'w.created_by = ?'], [user.companyId, user.id], q);
  }

  /** 我监督的任务：指定我做监督人的，加上指派人没写监督人时我这个指派人（这些已在“我指派的”里，所以这里只列指定我监督的）。 */
  supervised(user: AuthUser, q: { status?: string; page: number; pageSize: number }) {
    return this.taskRows(['w.company_id = ?', "w.kind = 'task'", 'w.supervisor_id = ?'], [user.companyId, user.id], q);
  }

  /** 等我处理的数量：待复核/异常的任务 + 待批准的延期申请（给待办页和任务中心的红点用）。 */
  async reviewCounts(companyId: number, userId: number) {
    const [r] = await this.dataSource.query(
      `SELECT COUNT(*) AS n FROM work_items w WHERE w.company_id = ? AND w.kind = 'task' AND w.status = 'open' AND w.submitted_at IS NOT NULL AND COALESCE(w.supervisor_id, w.created_by) = ?`, [companyId, userId]);
    const [d] = await this.dataSource.query(`SELECT COUNT(*) AS n FROM task_delay_requests WHERE company_id = ? AND approver_id = ? AND status = 'pending'`, [companyId, userId]);
    return { review: Number(r.n), delay: Number(d.n) };
  }

  // ---------- 周期任务 ----------

  private needManage(user: AuthUser) {
    if (!this.can(user, 'tasks.routines.manage')) throw new ForbiddenException('没有管理周期任务的权限');
  }

  async routines(user: AuthUser) {
    this.needManage(user);
    const rows = await this.dataSource.manager.find(TaskRoutine, { where: { companyId: user.companyId }, order: { id: 'DESC' } });
    const names = new Map((await this.dataSource.manager.find(User, { where: { companyId: user.companyId, id: In([...new Set(rows.map((r) => r.assigneeId))]) }, select: ['id', 'name'] })).map((u) => [u.id, u.name]));
    return rows.map((r) => ({ ...r, assigneeName: names.get(r.assigneeId) ?? '' }));
  }

  async saveRoutine(user: AuthUser, id: number | null, p: RoutineInput) {
    this.needManage(user);
    const errors = validateRoutine(p, p.title ?? '', p.dueDays);
    if (errors.length) throw new BadRequestException(errors.join('；'));
    return this.dataSource.transaction(async (em) => {
      await this.activeUser(em, user.companyId, p.assigneeId);
      await this.checkSupervision(em, user.companyId, { ...p, supervisorId: p.supervisorId ?? null }, false);
      const patch = {
        supervisorId: p.supervisorId || null, requiresReview: !!p.requiresReview, feedbackPreset: p.feedbackPreset || null, completionStandard: p.completionStandard?.trim() || null,
        title: p.title.trim(), description: p.description?.trim() || null, assigneeId: p.assigneeId, frequency: p.frequency,
        weekday: p.frequency === 'weekly' ? p.weekday : null, monthDay: p.frequency === 'monthly' ? p.monthDay : null, dueDays: p.dueDays, active: p.active ?? true,
      };
      if (id) {
        const r = await em.findOne(TaskRoutine, { where: { id, companyId: user.companyId } });
        if (!r) throw new NotFoundException('周期任务不存在');
        await em.update(TaskRoutine, { id }, patch as never);
        return { id };
      }
      const ins = await em.insert(TaskRoutine, { ...patch, companyId: user.companyId, createdBy: user.id } as never);
      return { id: Number(ins.identifiers[0].id) };
    });
  }

  async setRoutineActive(user: AuthUser, id: number, active: boolean) {
    this.needManage(user);
    const r = await this.dataSource.manager.update(TaskRoutine, { id, companyId: user.companyId }, { active } as never);
    if (!r.affected) throw new NotFoundException('周期任务不存在');
    return { ok: true };
  }

  /**
   * 生成今天的周期任务。每个（周期任务、日期）只生成一次（唯一键兜底，重复调用安全）。
   * 服务当天没开起来就错过当天的，不补发历史日期（补发一堆过期任务比漏一天更扰人）。
   */
  async generateRoutines(today = todayInChina()) {
    const routines = await this.dataSource.manager.find(TaskRoutine, { where: { active: true } });
    let created = 0;
    for (const r of routines) {
      if (!routineMatches(r, today)) continue;
      try {
        await this.dataSource.transaction(async (em) => {
          const assignee = await em.findOne(User, { where: { id: r.assigneeId, companyId: r.companyId, status: 'active' } });
          if (!assignee) return; // 负责人已停用：不生成，管理员在周期任务页能看到需要改负责人
          await em.insert(WorkItem, {
            companyId: r.companyId, kind: 'task', runId: null, stepId: null, assigneeId: r.assigneeId, createdBy: null, routineId: r.id,
            scheduleKey: `routine:${r.id}:${today}`, title: r.title, description: r.description, status: 'open',
            supervisorId: r.supervisorId, requiresReview: r.requiresReview, feedbackPreset: r.feedbackPreset, completionStandard: r.completionStandard, dueAt: dueEndOfDay(today, r.dueDays),
          } as never);
          await this.notify(em, r.companyId, r.assigneeId, `今日任务：${r.title}`);
          created += 1;
        });
      } catch (e) {
        if ((e as { code?: string }).code !== 'ER_DUP_ENTRY') throw e;
      }
    }
    return created;
  }
}
