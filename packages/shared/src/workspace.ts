/**
 * 工作台：功能首页、岗位工作台、老板总控台、个人任务面板共用的定义。
 * 岗位工作台由岗位的显式字段 positions.workspace_type 决定（不按名称猜），常用业务入口只引用导航注册表里的页面，
 * 菜单、权限、路径都不在这里重复定义。
 */
import { NAV_SECTIONS, type NavPage } from './navigation';
import type { PositionWorkspaceType } from './position-templates';

/** 个人任务的四个分类（旧系统：新任务 / 进行中 / 待我复核 / 已完成）。 */
export const TASK_VIEWS = [
  { key: 'new', label: '新任务' },
  { key: 'processing', label: '进行中' },
  { key: 'review', label: '待我复核' },
  { key: 'done', label: '已完成' },
] as const;
export type TaskView = (typeof TASK_VIEWS)[number]['key'];
export const isTaskView = (v: unknown): v is TaskView => TASK_VIEWS.some((x) => x.key === v);

/** 依赖别的小组新建模块的汇总（售后、兜底监督、直播）。没有对应模块时页面显示“暂无该模块”。 */
export const WORKSPACE_MODULES = {
  supervision: '兜底监督',
  'after-sales': '售后',
  live: '直播',
} as const;
export type WorkspaceModuleKey = keyof typeof WORKSPACE_MODULES;

export type SummaryTone = 'normal' | 'warn' | 'bad';
/** 汇总卡片。value 为 null 表示“暂无”（没有权限看、或对应模块还没有）；module 说明是缺哪个模块。 */
export interface SummaryCard {
  key: string;
  label: string;
  value: number | string | null;
  hint?: string;
  tone?: SummaryTone;
  /** 点击后去的导航页面键（“分区.页面id”），页面没做完或没权限时只显示不可点 */
  page?: string;
  module?: WorkspaceModuleKey;
}

export interface BossException {
  id: number;
  title: string;
  severity: 'urgent' | 'important' | 'normal';
  ownerName: string;
  storeName: string;
  escalatedLevel: number;
}
export interface BossPerson { userId: number; name: string; position: string; pending: number; overdue: number; exceptions: number }
export interface BossStoreRow { storeId: number; name: string; platform: string; salesCents: number; profitCents: number | null }
export interface BossDashboard {
  asOf: string;
  /** 各依赖模块是否已接入 */
  modules: Record<WorkspaceModuleKey, boolean>;
  attention: SummaryCard[];
  today: { salesCents: number | null; profitCents: number | null; hasData: boolean };
  exceptions: { available: boolean; total: number; rows: BossException[] };
  people: BossPerson[];
  stores: BossStoreRow[];
  trend: Array<{ date: string; salesCents: number; profitCents: number | null }>;
}

export interface DeskDef {
  type: PositionWorkspaceType;
  title: string;
  focus: string;
  /** 常用业务入口：导航页面键“分区.页面id”，只显示有权限且已完成的 */
  links: string[];
  /** 主管级岗位（positions.level 为 manager/boss）额外的入口 */
  managerLinks?: string[];
  /** 旧系统标为“待接入”的专属业务，新系统也还没有 */
  pending?: string[];
  /** 这类岗位关心的依赖模块，没有接入时显示“暂无该模块” */
  modules?: WorkspaceModuleKey[];
}

export const DESK_DEFS: Readonly<Record<PositionWorkspaceType, DeskDef>> = {
  boss: { type: 'boss', title: '老板工作台', focus: '经营总览 · 异常跟进', links: ['workbench.boss', 'finance.overview', 'finance.history', 'flow.overview', 'resource.org-tree'], modules: ['supervision'] },
  general: { type: 'general', title: '综合事务工作台', focus: '经营资料 · 账号与资产', links: ['resource.stores', 'resource.licenses', 'resource.phones', 'resource.qualifications', 'resource.memos', 'resource.fixed-assets', 'resource.employees', 'resource.org-tree'], managerLinks: ['flow.overview', 'resource.position-profiles'] },
  operations: { type: 'operations', title: '运营工作台', focus: '店铺经营 · SKU申请', links: ['flow.apply', 'resource.stores', 'finance.finance-products', 'finance.finance-bundles', 'finance.pricing-debug', 'resource.phones'], managerLinks: ['flow.overview', 'finance.overview', 'features.live'], modules: ['live'] },
  finance: { type: 'finance', title: '财务工作台', focus: 'SKU成本审核 · 财务单据', links: ['finance.cost-table', 'finance.history', 'finance.drafts', 'finance.finance-express-prices', 'finance.cash-bank', 'finance.finance-products'], managerLinks: ['finance.overview', 'flow.overview'] },
  cashier: { type: 'cashier', title: '出纳工作台', focus: '收付款资料 · 资金核对', links: ['finance.cash-bank', 'finance.doc-receipt', 'finance.doc-payment', 'finance.doc-transfer', 'finance.drafts'], managerLinks: ['finance.overview'] },
  warehouse: { type: 'warehouse', title: '仓库工作台', focus: '发货组成 · 库存与收货', links: ['finance.inventory', 'finance.finance-bundles', 'finance.doc-purchase-in', 'finance.finance-products'], managerLinks: ['flow.overview'], pending: ['仓库收发货汇总'], modules: ['after-sales'] },
  purchasing: { type: 'purchasing', title: '采购供应链工作台', focus: '供应商资料 · 到货跟进', links: ['finance.finance-suppliers', 'finance.finance-products', 'finance.doc-purchase-in', 'finance.history'], managerLinks: ['flow.overview'], pending: ['采购到货汇总'] },
  support: { type: 'support', title: '客服工作台', focus: '售后处理 · 订单申诉', links: ['resource.stores'], managerLinks: ['flow.overview'], modules: ['after-sales', 'supervision'] },
  live_anchor: { type: 'live_anchor', title: '主播工作台', focus: '我的直播 · 排场与提成', links: ['features.live-desk', 'flow.apply'], modules: ['live'] },
  live_control: { type: 'live_control', title: '中控工作台', focus: '我的直播 · 排场与提成', links: ['features.live-desk', 'flow.apply'], modules: ['live'] },
  blank: { type: 'blank', title: '空白工作台', focus: '', links: [] },
};

export const deskFor = (type: string | null | undefined): DeskDef => DESK_DEFS[(type as PositionWorkspaceType) ?? 'blank'] ?? DESK_DEFS.blank;

/** 导航页面键“分区.页面id” → 导航页面（只认已完成的）。 */
export function navPageByKey(key: string): (NavPage & { sectionId: string; sectionLabel: string }) | null {
  const [sectionId, ...rest] = key.split('.');
  const id = rest.join('.');
  const section = NAV_SECTIONS.find((s) => s.id === sectionId);
  const page = section?.pages.find((p) => p.id === id && p.ready);
  return section && page ? { ...page, sectionId: section.id, sectionLabel: section.label } : null;
}

/** 岗位工作台的常用业务入口：只留当前账号有权限、且页面已做完的。 */
export function deskLinks(def: DeskDef, level: string | null | undefined, can: (permission: string) => boolean) {
  const keys = [...def.links, ...(level === 'manager' || level === 'boss' ? def.managerLinks ?? [] : [])];
  const seen = new Set<string>();
  const out: Array<NavPage & { sectionId: string; sectionLabel: string }> = [];
  for (const k of keys) {
    const p = navPageByKey(k);
    if (!p || seen.has(p.path) || !can(p.permission)) continue;
    seen.add(p.path);
    out.push(p);
  }
  return out;
}

/** 部门路径：从上到下用“ / ”连接。 */
export function departmentPath(id: number | null, byId: Map<number, { name: string; parentId: number | null }>): string {
  const names: string[] = [];
  const seen = new Set<number>();
  let cur = id != null ? byId.get(id) : undefined;
  let curId = id;
  while (cur && curId != null && !seen.has(curId)) {
    seen.add(curId);
    names.unshift(cur.name);
    curId = cur.parentId;
    cur = curId != null ? byId.get(curId) : undefined;
  }
  return names.join(' / ');
}

export interface DeskPosition {
  id: number;
  name: string;
  workspaceType: PositionWorkspaceType;
  level: 'boss' | 'manager' | 'staff';
  departmentId: number | null;
  departmentPath: string;
  assigned: boolean;
  isPrimary: boolean;
}
export interface DeskCatalog { positions: DeskPosition[]; canBrowse: boolean; defaultPositionId: number | null }

/** 工作台菜单分组：一个部门一组，组内一个岗位一个入口；没有部门的归“未分部门”。 */
export function groupDeskPositions(positions: DeskPosition[]): Array<{ title: string; items: DeskPosition[] }> {
  const groups = new Map<string, DeskPosition[]>();
  for (const p of positions) {
    const t = p.departmentPath || '未分部门';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t)!.push(p);
  }
  return [...groups].map(([title, items]) => ({ title, items }));
}

export interface PersonalTaskRow {
  id: number;
  title: string;
  description: string | null;
  status: 'open' | 'done' | 'cancelled';
  /** 页面显示用的状态：new / processing / submitted / done / cancelled */
  stage: 'new' | 'processing' | 'submitted' | 'done' | 'cancelled';
  dueAt: string | null;
  overdue: boolean;
  assigneeId: number;
  assigneeName: string;
  creatorId: number | null;
  creatorName: string;
  doneNote: string | null;
  reviewNote: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  finishedAt: string | null;
  /** 我能对这条任务做什么 */
  can: { start: boolean; complete: boolean; submit: boolean; review: boolean };
}
export interface PersonalTaskList {
  view: TaskView;
  page: number;
  pageSize: number;
  total: number;
  counts: Record<TaskView, number> & { overdue: number };
  rows: PersonalTaskRow[];
}

/** 任务阶段：完成/取消优先，其次已提交复核，其次已开始，否则是新任务。 */
export function taskStage(t: { status: string; startedAt: unknown; submittedAt: unknown }): PersonalTaskRow['stage'] {
  if (t.status === 'done') return 'done';
  if (t.status === 'cancelled') return 'cancelled';
  if (t.submittedAt) return 'submitted';
  if (t.startedAt) return 'processing';
  return 'new';
}

/** 利润率（整数百万分比，1% = 1,000,000）：销售额为 0 时没有利润率。 */
export function marginPpm(profitCents: number | null, salesCents: number): number | null {
  if (profitCents === null || salesCents <= 0) return null;
  return Math.round((profitCents * 100_000_000) / salesCents);
}

/** 运营工作台“每日经营”：某一天各店铺的经营数据，以及这天还没有数据的在用店铺。 */
export interface DailyBusiness {
  date: string;
  stores: Array<{ storeId: number; name: string; platform: string; salesCents: number; adCostCents: number; profitCents: number | null; marginPpm: number | null }>;
  totals: { salesCents: number; adCostCents: number; profitCents: number | null; marginPpm: number | null };
  /** 在用店铺里这天没有经营数据的（提醒去更新） */
  missing: Array<{ storeId: number; name: string }>;
}
