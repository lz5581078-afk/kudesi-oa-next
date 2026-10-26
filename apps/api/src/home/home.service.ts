import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  createChecker, HOME_WORKSPACES, isHomeWorkspaceType, mergedHomeWidgets,
  type HomeDto, type HomeRunRow, type HomeWidget, type HomeWorkspaceType,
} from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { FlowService } from '../flow/flow.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { ResourcesService } from '../resources/resources.service';

const iso = (v: unknown): string | null => (v ? new Date(v as string | Date).toISOString() : null);

/**
 * 首页聚合：只读，每张卡片的数据都在服务端按当前登录人的权限算好，没权限的卡片根本不返回。
 * 身份只取自令牌（AuthUser），公司条件由各个被复用的服务自己带。
 * 复用现有服务（流程待办、资料总览、财务经营、库存），不重复写统计逻辑；
 * 成本相关数字沿用这些服务自己的成本权限处理，这里另外只挑选需要的字段，不转发成本明细。
 */
@Injectable()
export class HomeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly flow: FlowService,
    private readonly resources: ResourcesService,
    private readonly docs: FinanceDocumentsService,
  ) {}
  private readonly log = new Logger('Home');
  /** 短缓存（毫秒）：同一个人连续刷新首页不重复跑统计；0 = 不缓存（测试用） */
  cacheMs = 15_000;
  private readonly cache = new Map<string, { at: number; data: HomeDto }>();

  /** 岗位类型：主岗位 + 兼任岗位的 workspace_type（显式字段，不看名称）；公司管理员按老板处理。 */
  async workspaceTypes(user: AuthUser): Promise<{ types: HomeWorkspaceType[]; positionName: string | null }> {
    const [u] = await this.dataSource.query('SELECT position_id AS pid, extra_position_ids AS extra FROM users WHERE id = ? AND company_id = ?', [user.id, user.companyId]);
    const extra: number[] = !u?.extra ? [] : Array.isArray(u.extra) ? u.extra : JSON.parse(String(u.extra));
    const ids = [u?.pid, ...extra].filter((x): x is number => typeof x === 'number' && x > 0);
    const rows: Array<{ id: number; name: string; type: string }> = ids.length
      ? await this.dataSource.query(`SELECT id, name, workspace_type AS type FROM positions WHERE company_id = ? AND status = 'active' AND id IN (${ids.map(() => '?').join(',')})`, [user.companyId, ...ids])
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
    const types: HomeWorkspaceType[] = [];
    if (user.permissions.isCompanyAdmin) types.push('boss');
    for (const r of ordered) if (isHomeWorkspaceType(r.type) && r.type !== 'blank' && !types.includes(r.type)) types.push(r.type);
    if (types.length === 0) types.push('blank');
    return { types, positionName: byId.get(u?.pid)?.name ?? null };
  }

  async get(user: AuthUser): Promise<HomeDto> {
    const { types, positionName } = await this.workspaceTypes(user);
    const key = `${user.companyId}:${user.id}:${types.join(',')}:${JSON.stringify(user.permissions)}`;
    const hit = this.cache.get(key);
    if (this.cacheMs > 0 && hit && Date.now() - hit.at < this.cacheMs) return hit.data;

    const can = createChecker(user.permissions);
    const def = HOME_WORKSPACES[types[0]];
    const dto: HomeDto = { workspace: { type: types[0], title: def.title, focus: def.focus, positionName, types }, widgets: [] };
    const failed: HomeWidget[] = [];
    let fin: Promise<boolean> | null = null; // 财务指标和店铺排行共用同一次财务经营查询
    const finance = () => (fin ??= this.finance(user, dto));
    const jobs: Record<HomeWidget, (() => Promise<boolean>) | null> = {
      todos: () => this.todos(user, dto),
      started: () => this.started(user, dto),
      tasks: can('workbench.tasks.view') ? () => this.tasks(user, dto) : null,
      apply: can('flow.apply.view') ? () => this.apply(user, dto) : null,
      flowAlerts: can('flow.overview.view') ? () => this.flowAlerts(user, dto) : null,
      people: can('flow.overview.view') ? () => this.people(user, dto) : null,
      finance: can('finance.overview.view') ? finance : null,
      stores: can('finance.overview.view') ? finance : null,
      stock: can('finance.inventory.view') ? () => this.stock(user, dto) : null,
      resourceAlerts: () => this.resourceAlerts(user, dto),
    };
    const wanted = mergedHomeWidgets(types);
    const shown = new Set<HomeWidget>();
    const results = await Promise.all(wanted.map(async (w) => {
      const job = jobs[w];
      if (!job) return [w, false] as const;
      try { return [w, await job()] as const; } catch (e) { this.log.warn(`首页卡片 ${w} 读取失败：${(e as Error).message}`); failed.push(w); return [w, false] as const; }
    }));
    for (const [w, ok] of results) if (ok) shown.add(w);
    dto.widgets = wanted.filter((w) => shown.has(w));
    if (failed.length) dto.failed = failed;
    // 没读到数据的字段不留空壳：只保留 widgets 里列出的
    for (const w of ['todos', 'started', 'tasks', 'apply', 'flowAlerts', 'people', 'finance', 'stores', 'stock', 'resourceAlerts'] as const) if (!dto.widgets.includes(w)) delete dto[w];

    if (this.cacheMs > 0) {
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(key, { at: Date.now(), data: dto });
    }
    return dto;
  }

  private runRow(r: Record<string, unknown>): HomeRunRow {
    return {
      id: Number(r.id), title: String(r.title), templateLabel: String(r.templateLabel ?? ''), requesterName: String(r.requesterName ?? ''),
      stepName: (r.stepName as string | null) ?? null, handlers: ((r.handlers as string[]) ?? []).filter(Boolean), dueAt: iso(r.dueAt), overdue: Boolean(r.overdue),
    };
  }

  private async todos(user: AuthUser, dto: HomeDto) {
    const t = await this.flow.todos(user, { tab: 'pending', page: 1, pageSize: 5 });
    dto.todos = {
      pending: t.counts.pending, overdue: t.counts.overdue, returned: t.counts.returned, cc: t.counts.cc,
      rows: t.rows.map((r: Record<string, unknown>) => ({
        id: Number(r.id), runId: r.runId ? Number(r.runId) : null, title: String(r.runTitle ?? r.title), templateLabel: String(r.templateLabel ?? ''),
        stepName: (r.stepName as string | null) ?? null, dueAt: iso(r.dueAt), overdue: Boolean(r.overdue), returned: r.enteredVia === 'return',
      })),
    };
    return true;
  }

  private async started(user: AuthUser, dto: HomeDto) {
    const r = await this.flow.listRuns(user, { view: 'started', status: 'running', page: 1, pageSize: 5 });
    dto.started = { running: r.total, rows: r.rows.map((x: Record<string, unknown>) => this.runRow(x)) };
    return true;
  }

  private async tasks(user: AuthUser, dto: HomeDto) {
    const [r] = await this.dataSource.query(
      "SELECT COUNT(*) AS n, COALESCE(SUM(due_at IS NOT NULL AND due_at < ?), 0) AS late FROM work_items WHERE company_id = ? AND kind = 'task' AND created_by = ? AND status = 'open'",
      [new Date(), user.companyId, user.id]);
    dto.tasks = { open: Number(r.n), overdue: Number(r.late) };
    return true;
  }

  private async apply(user: AuthUser, dto: HomeDto) {
    const list = await this.flow.templates(user);
    dto.apply = { templates: list.filter((t) => t.active).map((t) => ({ key: t.key, label: t.label, description: t.description })) };
    return true;
  }

  private async flowAlerts(user: AuthUser, dto: HomeDto) {
    const r = await this.flow.listRuns(user, { view: 'all', overdue: true, page: 1, pageSize: 5 });
    dto.flowAlerts = { overdue: r.total, rows: r.rows.map((x: Record<string, unknown>) => this.runRow(x)) };
    return true;
  }

  private async people(user: AuthUser, dto: HomeDto) {
    const rows: Array<{ uid: number; name: string; pending: string; late: string }> = await this.dataSource.query(
      `SELECT w.assignee_id AS uid, u.name AS name, COUNT(*) AS pending, SUM(w.due_at IS NOT NULL AND w.due_at < ?) AS late
       FROM work_items w JOIN users u ON u.id = w.assignee_id AND u.company_id = w.company_id
       WHERE w.company_id = ? AND w.status = 'open' GROUP BY w.assignee_id, u.name HAVING late > 0 ORDER BY late DESC, pending DESC LIMIT 5`,
      [new Date(), user.companyId]);
    dto.people = { rows: rows.map((r) => ({ userId: r.uid, name: r.name, pending: Number(r.pending), overdue: Number(r.late) })) };
    return true;
  }

  private async finance(user: AuthUser, dto: HomeDto) {
    const o = await this.docs.overview(user); // 内部已按成本权限把毛利、净利、店铺利润置空
    dto.finance = {
      month: o.month, revenueCents: o.revenueCents, expenseCents: o.expenseCents, netProfitCents: o.netProfitCents, bankCents: o.bankCents,
      receivableCents: o.receivableCents, payableCents: o.payableCents, drafts: o.drafts, issued: o.issued,
      trend: o.trend.slice(-15).map((t: { date: string; revenueCents: number; profitCents: number | null }) => ({ date: t.date, revenueCents: t.revenueCents, profitCents: t.profitCents })),
    };
    dto.stores = { rows: o.stores.slice(0, 5).map((s: { storeId: number; name: string; platform: string; salesCents: number; profitCents: number | null }) => ({ storeId: s.storeId, name: s.name, platform: s.platform, salesCents: s.salesCents, profitCents: s.profitCents })) };
    return true;
  }

  private async stock(user: AuthUser, dto: HomeDto) {
    const rows = await this.docs.inventory(user, { stockStatus: 'out' });
    dto.stock = {
      outCount: rows.length,
      rows: rows.slice(0, 5).map((r) => ({ productName: String(r.productName ?? ''), code: String(r.code ?? ''), warehouseName: String(r.warehouseName ?? ''), qty: Number(r.qty), unit: String(r.unit ?? '') })),
    };
    return true;
  }

  private async resourceAlerts(user: AuthUser, dto: HomeDto) {
    const o = await this.resources.overview(user); // 只含当前人有查看权限的资料类型
    if (o.items.length === 0) return false;
    const abnormal = o.items.filter((i) => i.abnormal > 0).map((i) => ({ type: i.type, label: i.label, abnormal: i.abnormal }));
    dto.resourceAlerts = { abnormalTotal: abnormal.reduce((s, i) => s + i.abnormal, 0), abnormal: abnormal.slice(0, 8), alerts: o.alerts.slice(0, 8) };
    return true;
  }
}
