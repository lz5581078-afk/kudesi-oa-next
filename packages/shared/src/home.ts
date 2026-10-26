/**
 * 首页（工作台）配置：按岗位的 workspace_type 决定首页展示哪些卡片、放哪些常用入口。
 * 入口只写导航注册表里的“分区.页面id”，菜单、路径、权限都从 navigation.ts 取，这里不再重复定义。
 * 旧系统的做法：老板看经营总控台，其余人进岗位工作台（常用业务 + 流程待办 + 个人任务 + 发起申请）。
 */

export const HOME_WORKSPACE_TYPES = ['boss', 'general', 'operations', 'finance', 'cashier', 'warehouse', 'purchasing', 'support', 'blank'] as const;
export type HomeWorkspaceType = (typeof HOME_WORKSPACE_TYPES)[number];

/** 首页卡片。每张卡片的数据都由服务端按权限算好，没权限的卡片服务端不返回。 */
export const HOME_WIDGETS = ['todos', 'started', 'tasks', 'apply', 'flowAlerts', 'people', 'finance', 'stores', 'stock', 'resourceAlerts'] as const;
export type HomeWidget = (typeof HOME_WIDGETS)[number];

export interface HomeWorkspaceDef {
  title: string;
  focus: string;
  /** 这个岗位类型的首页要展示的卡片（顺序即展示顺序） */
  widgets: readonly HomeWidget[];
  /** 常用入口：导航注册表里的“分区.页面id”；有权限且页面已完成才显示 */
  links: readonly string[];
}

const BASE: readonly HomeWidget[] = ['todos', 'started', 'tasks', 'apply'];

export const HOME_WORKSPACES: Record<HomeWorkspaceType, HomeWorkspaceDef> = {
  boss: {
    title: '老板工作台',
    focus: '经营总览 · 异常跟进',
    widgets: ['finance', 'stores', 'flowAlerts', 'people', 'resourceAlerts', ...BASE],
    links: ['finance.overview', 'flow.overview', 'finance.history', 'resource.org-tree', 'resource.overview'],
  },
  general: {
    title: '综合部工作台',
    focus: '经营资料 · 账号与资产',
    widgets: ['resourceAlerts', ...BASE],
    links: ['resource.stores', 'resource.licenses', 'resource.phones', 'resource.qualifications', 'resource.memos', 'resource.fixed-assets'],
  },
  operations: {
    title: '运营工作台',
    focus: '店铺经营 · SKU 申请',
    widgets: ['apply', 'todos', 'started', 'tasks'],
    links: ['flow.apply', 'finance.pricing-debug'],
  },
  finance: {
    title: '财务工作台',
    focus: '经营核对 · 财务单据',
    widgets: ['finance', 'stores', 'stock', ...BASE],
    links: ['finance.cost-table', 'finance.history', 'finance.drafts', 'finance.finance-express-prices', 'finance.cash-bank', 'finance.finance-products'],
  },
  cashier: {
    title: '出纳工作台',
    focus: '收付款 · 资金核对',
    widgets: ['finance', ...BASE],
    links: ['finance.cash-bank', 'finance.doc-receipt', 'finance.doc-payment', 'finance.doc-transfer', 'finance.drafts'],
  },
  warehouse: {
    title: '仓库工作台',
    focus: '库存 · 发货组成',
    widgets: ['stock', ...BASE],
    links: ['finance.inventory', 'finance.finance-bundles'],
  },
  purchasing: {
    title: '采购工作台',
    focus: '供应商 · 采购入库',
    widgets: ['stock', ...BASE],
    links: ['finance.finance-suppliers', 'finance.finance-products', 'finance.doc-purchase-in', 'finance.history'],
  },
  support: {
    title: '客服工作台',
    focus: '售后待办 · 逾期跟进',
    widgets: ['todos', 'flowAlerts', 'tasks', 'started', 'apply'],
    links: ['resource.stores'],
  },
  blank: {
    title: '我的工作台',
    focus: '待办 · 申请',
    widgets: BASE,
    links: [],
  },
};

export function isHomeWorkspaceType(value: unknown): value is HomeWorkspaceType {
  return typeof value === 'string' && (HOME_WORKSPACE_TYPES as readonly string[]).includes(value);
}

/** 多个岗位（主岗位 + 兼任）合并：卡片取并集，顺序按主岗位优先。 */
export function mergedHomeWidgets(types: readonly HomeWorkspaceType[]): HomeWidget[] {
  const out: HomeWidget[] = [];
  for (const t of types) for (const w of HOME_WORKSPACES[t].widgets) if (!out.includes(w)) out.push(w);
  return out;
}
export function mergedHomeLinks(types: readonly HomeWorkspaceType[]): string[] {
  const out: string[] = [];
  for (const t of types) for (const l of HOME_WORKSPACES[t].links) if (!out.includes(l)) out.push(l);
  return out;
}

// ---------- 接口返回 ----------

export interface HomeTodoRow { id: number; runId: number | null; title: string; templateLabel: string; stepName: string | null; dueAt: string | null; overdue: boolean; returned: boolean }
export interface HomeRunRow { id: number; title: string; templateLabel: string; requesterName: string; stepName: string | null; handlers: string[]; dueAt: string | null; overdue: boolean }

export interface HomeDto {
  workspace: { type: HomeWorkspaceType; title: string; focus: string; positionName: string | null; types: HomeWorkspaceType[] };
  /** 本次返回了数据的卡片（没权限的卡片不在里面），顺序即展示顺序 */
  widgets: HomeWidget[];
  /** 读取失败的卡片（其余卡片照常显示） */
  failed?: HomeWidget[];
  todos?: { pending: number; overdue: number; returned: number; cc: number; rows: HomeTodoRow[] };
  started?: { running: number; rows: HomeRunRow[] };
  /** 我指派出去、还没完成的任务 */
  tasks?: { open: number; overdue: number };
  apply?: { templates: Array<{ key: string; label: string; description: string }> };
  /** 全公司逾期未办结的流程 */
  flowAlerts?: { overdue: number; rows: HomeRunRow[] };
  /** 各人逾期/待办（兜底监督） */
  people?: { rows: Array<{ userId: number; name: string; pending: number; overdue: number }> };
  /** 本月经营；成本相关（毛利/净利）没有成本查看权限时为 null，服务端就不给 */
  finance?: {
    month: string; revenueCents: number; expenseCents: number; netProfitCents: number | null; bankCents: number | null;
    receivableCents: number; payableCents: number; drafts: number; issued: number;
    trend: Array<{ date: string; revenueCents: number; profitCents: number | null }>;
  };
  stores?: { rows: Array<{ storeId: number; name: string; platform: string; salesCents: number; profitCents: number | null }> };
  stock?: { outCount: number; rows: Array<{ productName: string; code: string; warehouseName: string; qty: number; unit: string }> };
  resourceAlerts?: {
    abnormalTotal: number;
    abnormal: Array<{ type: string; label: string; abnormal: number }>;
    alerts: Array<{ type: string; typeLabel: string; id: number; title: string; label: string; days: number }>;
  };
}
