import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { createChecker, dueEndOfDay, routineMatches, todayInChina, validateRoutine, type RoutineRule } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Notification, TaskRoutine, User, WorkItem } from '../entities';

export interface RoutineInput extends RoutineRule {
  title: string; description?: string | null; assigneeId: number; dueDays: number; active?: boolean;
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

  async create(user: AuthUser, p: { title: string; description?: string; assigneeId?: number; dueDate?: string }) {
    const title = p.title?.trim();
    if (!title || title.length > 150) throw new BadRequestException('任务标题必填，不超过 150 字');
    const assigneeId = p.assigneeId ?? user.id;
    if (assigneeId !== user.id && !this.can(user, 'tasks.assign')) throw new ForbiddenException('没有给别人指派任务的权限');
    if (p.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate)) throw new BadRequestException('截止日期格式不对');
    if (p.dueDate && p.dueDate < todayInChina()) throw new BadRequestException('截止日期不能早于今天');
    return this.dataSource.transaction(async (em) => {
      await this.activeUser(em, user.companyId, assigneeId);
      const ins = await em.insert(WorkItem, {
        companyId: user.companyId, kind: 'task', runId: null, stepId: null, assigneeId, createdBy: user.id, title, description: p.description?.trim() || null,
        status: 'open', dueAt: p.dueDate ? dueEndOfDay(p.dueDate, 1) : null,
      } as never);
      if (assigneeId !== user.id) await this.notify(em, user.companyId, assigneeId, `${user.name} 给你指派了任务：${title}`);
      return { id: Number(ins.identifiers[0].id) };
    });
  }

  private async lockTask(em: EntityManager, user: AuthUser, id: number) {
    const t = await em.findOne(WorkItem, { where: { id, companyId: user.companyId, kind: 'task' }, lock: { mode: 'pessimistic_write' } });
    if (!t) throw new NotFoundException('任务不存在');
    if (t.status !== 'open') throw new BadRequestException('这条任务已经结束了');
    return t;
  }

  async complete(user: AuthUser, id: number, note?: string) {
    return this.dataSource.transaction(async (em) => {
      const t = await this.lockTask(em, user, id);
      if (t.assigneeId !== user.id) throw new ForbiddenException('只有负责人能完成任务');
      if (t.submittedAt) throw new BadRequestException('已提交复核，等指派人处理');
      t.status = 'done'; t.finishedAt = new Date(); t.doneNote = note?.trim().slice(0, 500) || null;
      await em.save(WorkItem, t);
      if (t.createdBy && t.createdBy !== user.id) await this.notify(em, user.companyId, t.createdBy, `${user.name} 完成了任务：${t.title}`, 'result');
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

  /** 我指派的任务（含指派给自己的）。 */
  async assigned(user: AuthUser, q: { status?: string; page: number; pageSize: number }) {
    const where = ['w.company_id = ?', "w.kind = 'task'", 'w.created_by = ?'];
    const args: unknown[] = [user.companyId, user.id];
    if (q.status) { where.push('w.status = ?'); args.push(q.status); }
    const w = where.join(' AND ');
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n FROM work_items w WHERE ${w}`, args);
    const rows = await this.dataSource.query(
      `SELECT w.id, w.title, w.description, w.status, w.due_at AS dueAt, w.created_at AS createdAt, w.finished_at AS finishedAt, w.done_note AS doneNote, u.name AS assigneeName
       FROM work_items w JOIN users u ON u.id = w.assignee_id WHERE ${w} ORDER BY w.id DESC LIMIT ? OFFSET ?`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    return { total: Number(n), page: q.page, pageSize: q.pageSize, rows: rows.map((r: { status: string; dueAt: Date | null }) => ({ ...r, overdue: r.status === 'open' && !!r.dueAt && r.dueAt < new Date() })) };
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
      const patch = {
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
            scheduleKey: `routine:${r.id}:${today}`, title: r.title, description: r.description, status: 'open', dueAt: dueEndOfDay(today, r.dueDays),
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
