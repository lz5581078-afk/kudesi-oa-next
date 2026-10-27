import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  createChecker, deskFor, departmentPath, isTaskView, taskStage, todayInChina, WORKSPACE_MODULES,
  marginPpm, type BossDashboard, type DailyBusiness, type BossPerson, type DeskCatalog, type DeskPosition, type PersonalTaskList, type PersonalTaskRow, type SummaryCard, type TaskView, type WorkspaceModuleKey,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Department, Notification, Position, User, WorkItem } from '../entities';
import { ResourcesService } from '../resources/resources.service';
import { WorkspaceModuleRegistry } from './module-registry';

const COST_VIEW = 'product.cost.view';
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => ymd(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
const MODULE_KEYS = Object.keys(WORKSPACE_MODULES) as WorkspaceModuleKey[];

/** 功能首页以外的工作台数据：岗位目录、岗位汇总、个人任务四分类、老板总控台。公司和本人只取自令牌。 */
@Injectable()
export class WorkspaceService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly resources: ResourcesService,
    private readonly registry: WorkspaceModuleRegistry,
  ) {}

  private can(user: AuthUser, key: string) { return createChecker(user.permissions)(key); }

  // ================= 岗位目录 =================

  /** 有“部门与岗位”查看权限（或管理员）的人能浏览全部在用岗位；其他人只看到自己在岗的岗位。 */
  async catalog(user: AuthUser): Promise<DeskCatalog> {
    const em = this.dataSource.manager;
    const me = await em.findOne(User, { where: { id: user.id, companyId: user.companyId } });
    if (!me) throw new ForbiddenException('账号不存在');
    const mine = new Set<number>([...(me.positionId ? [me.positionId] : []), ...(me.extraPositionIds ?? [])]);
    const canBrowse = !!user.permissions.isCompanyAdmin || this.can(user, 'org.structure.view');
    const depts = await em.find(Department, { where: { companyId: user.companyId } });
    const byId = new Map(depts.map((d) => [d.id, { name: d.name, parentId: d.parentId }]));
    const activeDept = new Set(depts.filter((d) => d.status === 'active').map((d) => d.id));
    const positions = await em.find(Position, { where: { companyId: user.companyId, status: 'active' }, order: { sortOrder: 'ASC', id: 'ASC' } });
    const list: DeskPosition[] = positions
      .filter((p) => (canBrowse || mine.has(p.id)) && (p.departmentId == null || activeDept.has(p.departmentId)))
      .map((p) => ({
        id: p.id, name: p.name, workspaceType: p.workspaceType as DeskPosition['workspaceType'], level: p.level, departmentId: p.departmentId,
        departmentPath: p.departmentId != null ? departmentPath(p.departmentId, byId) : '', assigned: mine.has(p.id), isPrimary: me.positionId === p.id,
      }));
    const first = list.find((p) => p.isPrimary) ?? list.find((p) => p.assigned) ?? null;
    return { positions: list, canBrowse, defaultPositionId: first?.id ?? null };
  }

  /** 岗位工作台的汇总卡片：先查岗位在不在可见目录里，再按岗位类型取数。 */
  async desk(user: AuthUser, positionId: number) {
    const cat = await this.catalog(user);
    const position = cat.positions.find((p) => p.id === positionId);
    if (!position) throw new NotFoundException('没有这个岗位的工作台，或你无权查看');
    const def = deskFor(position.workspaceType);
    const cards: SummaryCard[] = [];
    const em = this.dataSource.manager;
    const type = position.workspaceType;
    if (['finance', 'cashier', 'purchasing', 'warehouse', 'boss'].includes(type) && this.can(user, 'finance.drafts.view')) {
      const rows: Array<{ status: string; n: string }> = await em.query("SELECT status, COUNT(*) AS n FROM finance_documents WHERE company_id = ? AND status IN ('draft','issued') GROUP BY status", [user.companyId]);
      const n = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
      cards.push({ key: 'drafts', label: '草稿单据', value: n('draft'), page: 'finance.drafts' });
      cards.push({ key: 'issued', label: '已开立未过账', value: n('issued'), tone: n('issued') > 0 ? 'warn' : 'normal', page: 'finance.history' });
    }
    if (['general', 'operations', 'boss'].includes(type)) {
      const exp = await this.resources.expiring(user, 30, true);
      cards.push({ key: 'expired', label: '资料已过期', value: exp.counts.expired, tone: exp.counts.expired > 0 ? 'bad' : 'normal', page: 'resource.overview' });
      cards.push({ key: 'due-soon', label: '30 天内到期', value: exp.counts.dueSoon, tone: exp.counts.dueSoon > 0 ? 'warn' : 'normal', page: 'resource.overview' });
    }
    for (const key of def.modules ?? []) {
      const provider = this.registry.get(key);
      if (provider?.deskCards) cards.push(...(await provider.deskCards(user, type)));
      else cards.push({ key: `module-${key}`, label: WORKSPACE_MODULES[key], value: null, hint: '暂无该模块', module: key });
    }
    return { position, title: `${position.name}工作台`, focus: def.focus, pending: def.pending ?? [], cards };
  }

  // ================= 个人任务 =================

  private rowOf(user: AuthUser, r: Record<string, unknown>, now: Date): PersonalTaskRow {
    const status = r.status as 'open' | 'done' | 'cancelled';
    const stage = taskStage({ status, startedAt: r.startedAt, submittedAt: r.submittedAt });
    const assigneeId = Number(r.assigneeId);
    const creatorId = r.creatorId == null ? null : Number(r.creatorId);
    const open = status === 'open';
    const mineTask = assigneeId === user.id;
    const dueAt = r.dueAt ? new Date(r.dueAt as string) : null;
    return {
      id: Number(r.id), title: String(r.title), description: (r.description as string) ?? null, status, stage,
      dueAt: dueAt ? dueAt.toISOString() : null, overdue: open && !!dueAt && dueAt < now,
      assigneeId, assigneeName: String(r.assigneeName ?? ''), creatorId, creatorName: String(r.creatorName ?? ''),
      doneNote: (r.doneNote as string) ?? null, reviewNote: (r.reviewNote as string) ?? null,
      startedAt: r.startedAt ? new Date(r.startedAt as string).toISOString() : null, submittedAt: r.submittedAt ? new Date(r.submittedAt as string).toISOString() : null,
      finishedAt: r.finishedAt ? new Date(r.finishedAt as string).toISOString() : null,
      can: {
        start: open && mineTask && stage === 'new',
        complete: open && mineTask && stage !== 'submitted',
        submit: open && mineTask && stage !== 'submitted' && creatorId != null && creatorId !== user.id,
        review: open && stage === 'submitted' && creatorId === user.id && !mineTask,
      },
    };
  }

  /**
   * 个人任务四分类（只含手工任务/周期任务，流程待办在“我的待办”里）：
   * 新任务＝我负责、还没开始；进行中＝我负责、已开始（含已提交等复核）；待我复核＝我指派的、对方已提交；已完成＝我负责的已结束。
   */
  async tasks(user: AuthUser, q: { view?: string; page?: number; pageSize?: number }): Promise<PersonalTaskList> {
    const view: TaskView = isTaskView(q.view) ? q.view : 'new';
    const page = Math.max(1, Math.floor(q.page ?? 1));
    const pageSize = Math.min(30, Math.max(1, Math.floor(q.pageSize ?? 8)));
    const now = new Date();
    const base = "w.company_id = ? AND w.kind = 'task'";
    const cond: Record<TaskView, string> = {
      new: "w.assignee_id = ? AND w.status = 'open' AND w.started_at IS NULL AND w.submitted_at IS NULL",
      processing: "w.assignee_id = ? AND w.status = 'open' AND (w.started_at IS NOT NULL OR w.submitted_at IS NOT NULL)",
      review: "w.created_by = ? AND w.assignee_id <> ? AND w.status = 'open' AND w.submitted_at IS NOT NULL",
      done: "w.assignee_id = ? AND w.status IN ('done','cancelled')",
    };
    const argsFor = (v: TaskView) => (v === 'review' ? [user.companyId, user.id, user.id] : [user.companyId, user.id]);
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n FROM work_items w WHERE ${base} AND ${cond[view]}`, argsFor(view));
    const rows = await this.dataSource.query(
      `SELECT w.id, w.title, w.description, w.status, w.due_at AS dueAt, w.started_at AS startedAt, w.submitted_at AS submittedAt, w.finished_at AS finishedAt,
              w.done_note AS doneNote, w.review_note AS reviewNote, w.assignee_id AS assigneeId, w.created_by AS creatorId, a.name AS assigneeName, c.name AS creatorName
       FROM work_items w JOIN users a ON a.id = w.assignee_id LEFT JOIN users c ON c.id = w.created_by
       WHERE ${base} AND ${cond[view]}
       ORDER BY ${view === 'done' ? 'w.finished_at DESC, w.id DESC' : 'w.due_at IS NULL, w.due_at ASC, w.id DESC'} LIMIT ? OFFSET ?`,
      [...argsFor(view), pageSize, (page - 1) * pageSize]);
    const counts = { new: 0, processing: 0, review: 0, done: 0, overdue: 0 } as PersonalTaskList['counts'];
    for (const v of ['new', 'processing', 'review', 'done'] as TaskView[]) {
      const [c] = await this.dataSource.query(`SELECT COUNT(*) AS n FROM work_items w WHERE ${base} AND ${cond[v]}`, argsFor(v));
      counts[v] = Number(c.n);
    }
    const [o] = await this.dataSource.query(`SELECT COUNT(*) AS n FROM work_items w WHERE ${base} AND w.assignee_id = ? AND w.status = 'open' AND w.due_at IS NOT NULL AND w.due_at < ?`, [user.companyId, user.id, now]);
    counts.overdue = Number(o.n);
    return { view, page, pageSize, total: Number(n), counts, rows: rows.map((r: Record<string, unknown>) => this.rowOf(user, r, now)) };
  }

  private notify(em: EntityManager, user: AuthUser, userId: number, title: string, kind = 'task') {
    return em.insert(Notification, { companyId: user.companyId, userId, kind, title: title.slice(0, 200), body: null, link: '/workbench/personal' });
  }

  private async lockTask(em: EntityManager, user: AuthUser, id: number) {
    const t = await em.findOne(WorkItem, { where: { id, companyId: user.companyId, kind: 'task' }, lock: { mode: 'pessimistic_write' } });
    if (!t) throw new NotFoundException('任务不存在');
    if (t.status !== 'open') throw new BadRequestException('这条任务已经结束了');
    return t;
  }

  /** 负责人点“开始处理”：新任务 → 进行中。 */
  async start(user: AuthUser, id: number) {
    return this.dataSource.transaction(async (em) => {
      const t = await this.lockTask(em, user, id);
      if (t.assigneeId !== user.id) throw new ForbiddenException('只有负责人能开始处理');
      if (t.submittedAt) throw new BadRequestException('已提交复核，等指派人处理');
      if (!t.startedAt) { t.startedAt = new Date(); await em.save(WorkItem, t); }
      return { ok: true };
    });
  }

  /** 负责人把做完的任务提交给指派人复核（只有别人指派给我的任务可以提交）。 */
  async submit(user: AuthUser, id: number, note?: string) {
    return this.dataSource.transaction(async (em) => {
      const t = await this.lockTask(em, user, id);
      if (t.assigneeId !== user.id) throw new ForbiddenException('只有负责人能提交复核');
      if (!t.createdBy || t.createdBy === user.id) throw new BadRequestException('自己建的任务直接点“完成”即可，不需要复核');
      if (t.submittedAt) throw new BadRequestException('已经提交复核了');
      const now = new Date();
      t.startedAt = t.startedAt ?? now; t.submittedAt = now; t.doneNote = note?.trim().slice(0, 500) || null; t.reviewNote = null;
      await em.save(WorkItem, t);
      await this.notify(em, user, t.createdBy, `${user.name} 提交了任务待你复核：${t.title}`);
      return { ok: true };
    });
  }

  /** 指派人复核：通过＝任务完成；退回＝回到负责人的“进行中”，写明意见。 */
  async review(user: AuthUser, id: number, approve: boolean, note?: string) {
    return this.dataSource.transaction(async (em) => {
      const t = await this.lockTask(em, user, id);
      if (t.createdBy !== user.id || t.assigneeId === user.id) throw new ForbiddenException('只有指派人能复核');
      if (!t.submittedAt) throw new BadRequestException('负责人还没有提交复核');
      const text = note?.trim().slice(0, 500) || null;
      if (!approve && !text) throw new BadRequestException('退回要写明原因');
      if (approve) {
        t.status = 'done'; t.finishedAt = new Date(); t.reviewNote = text;
        await em.save(WorkItem, t);
        await this.notify(em, user, t.assigneeId, `复核通过：${t.title}`, 'result');
      } else {
        t.submittedAt = null; t.reviewNote = text;
        await em.save(WorkItem, t);
        await this.notify(em, user, t.assigneeId, `任务被退回：${t.title}（${text}）`);
      }
      return { ok: true };
    });
  }

  // ================= 运营每日经营 =================

  /** 某一天各店铺的经营数据（来自店铺经营数据资料）；利润含采购成本，没有成本权限的人不返回。 */
  async daily(user: AuthUser, dateIn?: string): Promise<DailyBusiness> {
    const date = dateIn && /^\d{4}-\d{2}-\d{2}$/.test(dateIn) ? dateIn : addDays(todayInChina(), -1);
    const canCost = this.can(user, COST_VIEW);
    const rows: Array<{ sid: string; sales: string | null; refund: string | null; ad: string | null; fee: string | null; pc: string | null; oc: string | null }> = await this.dataSource.query(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.storeId')) AS sid, SUM(CAST(JSON_EXTRACT(data,'$.sales') AS SIGNED)) AS sales, SUM(CAST(JSON_EXTRACT(data,'$.refund') AS SIGNED)) AS refund,
        SUM(CAST(JSON_EXTRACT(data,'$.adCost') AS SIGNED)) AS ad, SUM(CAST(JSON_EXTRACT(data,'$.platformFee') AS SIGNED)) AS fee, SUM(CAST(JSON_EXTRACT(data,'$.purchaseCost') AS SIGNED)) AS pc, SUM(CAST(JSON_EXTRACT(data,'$.otherCost') AS SIGNED)) AS oc
       FROM resource_records WHERE company_id = ? AND type = 'store-daily-metrics' AND archived_at IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.day')) = ? GROUP BY sid`, [user.companyId, date]);
    const stores: Array<{ id: number; title: string; platform: string | null; status: string }> = await this.dataSource.query(
      "SELECT id, title, status, JSON_UNQUOTE(JSON_EXTRACT(data,'$.platform')) AS platform FROM resource_records WHERE company_id = ? AND type = 'stores' AND archived_at IS NULL", [user.companyId]);
    const byId = new Map(stores.map((s) => [Number(s.id), s]));
    const list = rows.map((r) => {
      const sales = Number(r.sales ?? 0);
      const profit = sales - Number(r.refund ?? 0) - Number(r.ad ?? 0) - Number(r.fee ?? 0) - Number(r.pc ?? 0) - Number(r.oc ?? 0);
      const st = byId.get(Number(r.sid));
      return { storeId: Number(r.sid), name: st?.title ?? `店铺#${r.sid}`, platform: st?.platform ?? '', salesCents: sales, adCostCents: Number(r.ad ?? 0), profitCents: canCost ? profit : null, marginPpm: marginPpm(canCost ? profit : null, sales) };
    }).filter((r) => byId.has(r.storeId)).sort((a, b) => b.salesCents - a.salesCents);
    const have = new Set(list.map((r) => r.storeId));
    const sales = list.reduce((n, r) => n + r.salesCents, 0);
    const profit = canCost ? list.reduce((n, r) => n + (r.profitCents ?? 0), 0) : null;
    return {
      date, stores: list,
      totals: { salesCents: sales, adCostCents: list.reduce((n, r) => n + r.adCostCents, 0), profitCents: profit, marginPpm: marginPpm(profit, sales) },
      missing: stores.filter((s) => !['cancelled', 'inactive'].includes(s.status) && !have.has(Number(s.id))).map((s) => ({ storeId: Number(s.id), name: s.title })),
    };
  }

  // ================= 老板总控台 =================

  async boss(user: AuthUser): Promise<BossDashboard> {
    const cid = user.companyId;
    const now = new Date();
    const today = todayInChina();
    const canCost = this.can(user, COST_VIEW);
    const q = <T,>(sql: string, args: unknown[]): Promise<T[]> => this.dataSource.query(sql, args);
    const modules = Object.fromEntries(MODULE_KEYS.map((k) => [k, this.registry.has(k)])) as Record<WorkspaceModuleKey, boolean>;

    const [wi] = await q<{ overdue: string; pending: string }>("SELECT SUM(status = 'open' AND due_at IS NOT NULL AND due_at < ?) AS overdue, SUM(status = 'open') AS pending FROM work_items WHERE company_id = ?", [now, cid]);
    const [runs] = await q<{ n: string }>("SELECT COUNT(*) AS n FROM flow_runs WHERE company_id = ? AND status = 'running' AND due_at IS NOT NULL AND due_at < ?", [cid, now]);
    const [stores] = await q<{ total: string; abnormal: string }>("SELECT COUNT(*) AS total, SUM(status = 'abnormal') AS abnormal FROM resource_records WHERE company_id = ? AND type = 'stores' AND archived_at IS NULL", [cid]);
    const exp = await this.resources.expiring(user, 30, true);

    const sup = this.registry.get('supervision');
    const ex = sup?.exceptions ? await sup.exceptions(user) : null;

    const attention: SummaryCard[] = [
      { key: 'exceptions', label: '开放异常', value: ex ? ex.total : null, tone: ex && ex.total > 0 ? 'bad' : 'normal', hint: ex ? (ex.total ? '去兜底监督处理' : '全部已处理') : '暂无该模块', page: 'supervision.overview', module: 'supervision' },
      { key: 'overdue-items', label: '已超时待办', value: Number(wi?.overdue ?? 0), tone: Number(wi?.overdue ?? 0) > 0 ? 'bad' : 'normal', hint: `未完成 ${Number(wi?.pending ?? 0)} 项`, page: 'flow.overview' },
      { key: 'overdue-runs', label: '超时流程', value: Number(runs?.n ?? 0), tone: Number(runs?.n ?? 0) > 0 ? 'bad' : 'normal', hint: '流程超过截止时间仍未办结', page: 'flow.overview' },
      { key: 'abnormal-stores', label: '异常店铺', value: Number(stores?.abnormal ?? 0), tone: Number(stores?.abnormal ?? 0) > 0 ? 'bad' : 'normal', hint: `共 ${Number(stores?.total ?? 0)} 家店铺`, page: 'resource.stores' },
      { key: 'expiry', label: '资料到期提醒', value: exp.counts.expired + exp.counts.dueSoon, tone: exp.counts.expired > 0 ? 'bad' : exp.counts.dueSoon > 0 ? 'warn' : 'normal', hint: `已过期 ${exp.counts.expired} · 30 天内到期 ${exp.counts.dueSoon}`, page: 'resource.overview' },
    ];
    for (const key of MODULE_KEYS) {
      if (key === 'supervision') continue;
      const p = this.registry.get(key);
      if (p?.bossCards) attention.push(...(await p.bossCards(user)));
      else attention.push({ key: `module-${key}`, label: WORKSPACE_MODULES[key], value: null, hint: '暂无该模块', module: key });
    }

    // 经营：店铺经营数据（手工+导入）。利润含采购成本，没有成本权限的人服务端不返回。
    const metricSql = (where: string) => `SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.day')) AS d, JSON_UNQUOTE(JSON_EXTRACT(data,'$.storeId')) AS sid,
      SUM(CAST(JSON_EXTRACT(data,'$.sales') AS SIGNED)) AS sales, SUM(CAST(JSON_EXTRACT(data,'$.refund') AS SIGNED)) AS refund, SUM(CAST(JSON_EXTRACT(data,'$.adCost') AS SIGNED)) AS ad,
      SUM(CAST(JSON_EXTRACT(data,'$.platformFee') AS SIGNED)) AS fee, SUM(CAST(JSON_EXTRACT(data,'$.purchaseCost') AS SIGNED)) AS pc, SUM(CAST(JSON_EXTRACT(data,'$.otherCost') AS SIGNED)) AS oc
      FROM resource_records WHERE company_id = ? AND type = 'store-daily-metrics' AND archived_at IS NULL AND ${where} GROUP BY d, sid`;
    type M = { d: string; sid: string; sales: string | null; refund: string | null; ad: string | null; fee: string | null; pc: string | null; oc: string | null };
    const from = addDays(today, -13);
    const metrics = await q<M>(metricSql("JSON_UNQUOTE(JSON_EXTRACT(data,'$.day')) >= ?"), [cid, from]);
    const profitOf = (m: M) => Number(m.sales ?? 0) - Number(m.refund ?? 0) - Number(m.ad ?? 0) - Number(m.fee ?? 0) - Number(m.pc ?? 0) - Number(m.oc ?? 0);
    const sum = (rows: M[]) => ({ sales: rows.reduce((s, m) => s + Number(m.sales ?? 0), 0), profit: rows.reduce((s, m) => s + profitOf(m), 0) });
    const todayRows = metrics.filter((m) => m.d === today);
    const t = sum(todayRows);
    const byDay = new Map<string, M[]>();
    for (const m of metrics) { if (!byDay.has(m.d)) byDay.set(m.d, []); byDay.get(m.d)!.push(m); }
    const trend = [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, rows]) => ({ date, salesCents: sum(rows).sales, profitCents: canCost ? sum(rows).profit : null }));
    const weekFrom = addDays(today, -6);
    const week = new Map<number, M[]>();
    for (const m of metrics.filter((x) => x.d >= weekFrom)) { const id = Number(m.sid); if (!week.has(id)) week.set(id, []); week.get(id)!.push(m); }
    const ids = [...week.keys()].filter((n) => n > 0);
    const storeRows = ids.length ? await q<{ id: number; title: string; platform: string | null }>(`SELECT id, title, JSON_UNQUOTE(JSON_EXTRACT(data,'$.platform')) AS platform FROM resource_records WHERE company_id = ? AND type = 'stores' AND id IN (${ids.map(() => '?').join(',')})`, [cid, ...ids]) : [];
    const storeOf = new Map(storeRows.map((s) => [Number(s.id), s]));
    const storeList = [...week].map(([storeId, rows]) => ({ storeId, name: storeOf.get(storeId)?.title ?? `店铺#${storeId}`, platform: storeOf.get(storeId)?.platform ?? '', salesCents: sum(rows).sales, profitCents: canCost ? sum(rows).profit : null }))
      .sort((a, b) => (canCost ? (b.profitCents ?? 0) - (a.profitCents ?? 0) : b.salesCents - a.salesCents));

    // 人员兜底排行：未完成/已超时待办 + 监督模块给的异常数
    const peopleRows = await q<{ id: number; name: string; position: string | null; pending: string; overdue: string }>(
      `SELECT u.id, u.name, p.name AS position, SUM(w.status = 'open') AS pending, SUM(w.status = 'open' AND w.due_at IS NOT NULL AND w.due_at < ?) AS overdue
       FROM users u JOIN work_items w ON w.assignee_id = u.id AND w.company_id = u.company_id LEFT JOIN positions p ON p.id = u.position_id
       WHERE u.company_id = ? AND u.status = 'active' GROUP BY u.id, u.name, p.name HAVING pending > 0`, [now, cid]);
    const people: BossPerson[] = peopleRows.map((r) => ({ userId: Number(r.id), name: r.name, position: r.position ?? '', pending: Number(r.pending), overdue: Number(r.overdue), exceptions: ex?.byUser?.[Number(r.id)] ?? 0 }))
      .sort((a, b) => b.overdue - a.overdue || b.exceptions - a.exceptions || b.pending - a.pending).slice(0, 30);

    return {
      asOf: now.toISOString(), modules, attention,
      today: { salesCents: t.sales, profitCents: canCost ? t.profit : null, hasData: todayRows.length > 0 },
      exceptions: { available: !!ex, total: ex?.total ?? 0, rows: ex?.rows ?? [] },
      people, stores: storeList, trend,
    };
  }
}
