/**
 * 导航注册表：页面、路由、权限键只在这里定义一次。
 * 前端菜单、路由守卫和后端的权限键都从这里派生，不再三处同步。
 *
 * `ready: false` 的页面表示还没做出来，不会出现在菜单里（旧系统把占位页留在导航里，用户分不清哪些能用）。
 * 做完一个页面时，把它的 ready 改成 true 即可。
 */

import { DOC_TYPES } from './finance-documents';
import { RESOURCE_DEFS, RESOURCE_VIEWS } from './resources';

export const OPENING_PREPAYMENT_PERMISSION = 'finance.docs.opening-prepayment';

export interface NavPage {
  id: string;
  label: string;
  /** 完整路由路径 */
  path: string;
  /** 访问这个页面需要的权限键 */
  permission: string;
  ready: boolean;
  /** 左侧菜单里的分组小标题（可选） */
  group?: string;
  /** 菜单条目下方的一行说明（可选，照旧程序二级导航） */
  description?: string;
}

export interface NavSection {
  id: string;
  label: string;
  /** 左侧图标栏用的图标名（图形由前端自己画，这里只记名字） */
  icon: NavIconName;
  pages: NavPage[];
}

export type NavIconName = 'inbox' | 'flow' | 'wallet' | 'database' | 'settings' | 'support' | 'shield' | 'live';

/**
 * 资料菜单的分组与顺序，照旧程序的「资料」导航：
 * 资料首页 / 组织与人员 / 经营资料 / 账号与资质 / 银行卡 / 公司资产 / 公司店铺维护。
 * 条目可以是资源 key、银行卡「视图」（同一份银行账户资料按类型分页）或专门页面。
 */
const RESOURCE_MENU: Array<{ group: string; items: Array<{ id: string; label?: string; description: string }> }> = [
  { group: '资料首页', items: [{ id: 'overview', description: '基础资料数量和最近变更' }] },
  { group: '组织与人员', items: [
    { id: 'org-tree', label: '组织架构', description: '公司、部门、岗位、人员' },
    { id: 'employees', label: '人员档案', description: '员工、岗位、角色绑定' },
    { id: 'position-profiles', description: '岗位、职责、培训和考核' },
    { id: 'duty-groups', description: '流程任务可引用的职责组' },
  ] },
  { group: '经营资料', items: [
    { id: 'licenses', description: '经营/电商主体执照资料' },
    { id: 'tax-profiles', description: '经营/电商税务资料' },
    { id: 'trademarks', description: '商标申请、证书、类别和到期' },
    { id: 'partners', description: '合作人、联系方式、关联主体' },
    { id: 'stores', description: '平台店铺、领取归属、状态' },
    { id: 'self-media', label: '自媒体账号档案', description: '抖音、快手等内容账号资料' },
    { id: 'wechat', description: '公司微信号、账号密码和绑定手机号' },
  ] },
  { group: '账号与资质', items: [
    { id: 'phones', description: '号码、套餐、充值提醒' },
    { id: 'broadband', description: '宽带账号、位置、带宽和绑定手机号' },
    { id: 'fee-settings', description: '手机号套餐、子卡费用、宽带费用' },
    { id: 'qualifications', description: '到期、续期、状态' },
    { id: 'memos', description: '平台账号、云服务、域名和到期提醒' },
  ] },
  { group: '银行卡', items: [
    { id: 'bank-fund', description: '公司和店铺账户余额总览' },
    { id: 'company-public-accounts', description: '公司主体公户和对账提醒' },
    { id: 'company-bank-cards', description: '公司银行卡资料' },
    { id: 'cashier-accounts', description: '出纳账户和保管人' },
    { id: 'store-public-accounts', description: '店铺绑定公户' },
    { id: 'store-personal-cards', description: '店铺个人卡和预留手机号' },
  ] },
  { group: '公司资产', items: [
    { id: 'fixed-assets', description: '电脑、手机、打印机、办公用品' },
    { id: 'locations', description: '房间、柜子、层位、档案定位' },
  ] },
  { group: '公司店铺维护', items: [{ id: 'company-store-maintenance', description: '维护公司店铺独立登录环境和授权电脑' }] },
];

/** 不是资源、而是专门页面的资料菜单项：权限跟着它背后的资料走。 */
const RESOURCE_SPECIAL: Record<string, { label: string; permission: string }> = {
  'org-tree': { label: '部门与岗位', permission: 'org.structure.view' },
  'employees': { label: '员工与权限', permission: 'org.staff.view' },
  'position-profiles': { label: '岗位档案', permission: 'org.structure.view' },
  'bank-fund': { label: '资金概况', permission: 'resource.bank-accounts.view' },
  'fee-settings': { label: '费用模块', permission: 'resource.phones.view' },
  'company-store-maintenance': { label: '管理公司店铺维护', permission: 'resource.company-store-maintenance.view' },
};

function resourcePages(): NavPage[] {
  const pages: NavPage[] = [];
  for (const g of RESOURCE_MENU) {
    for (const item of g.items) {
      const id = item.id;
      const def = RESOURCE_DEFS.find((d) => d.key === id);
      const view = RESOURCE_VIEWS.find((v) => v.id === id);
      const special = RESOURCE_SPECIAL[id];
      const extra = { group: g.group, description: item.description };
      if (id === 'overview') continue;
      if (def) pages.push({ ...page('resource', def.key, item.label ?? def.label, true), ...extra });
      else if (view) pages.push({ ...page('resource', view.id, item.label ?? view.label, true), permission: `resource.${view.type}.view`, ...extra });
      else if (special) pages.push({ ...page('resource', id, item.label ?? special.label, true), permission: special.permission, ...extra });
    }
  }
  return pages;
}

/** 已经做完的财务专门页面（做完一个加一个，菜单里不出现占位页）。 */
const FINANCE_BUILT = new Set<string>([
  'overview', 'history', 'drafts', 'cost-table', 'packaging-match', 'zone-suggestion', 'jst-sync', 'cost-history', 'api-keys', 'master-reset', 'pricing-debug', 'inventory', 'cash-bank', 'settlement-detail', 'unsettled-receipts', 'master-import', 'jst-maintenance',
  ...DOC_TYPES.map((d) => `doc-${d.type}`),
]);

/** 财务页面：旧系统的分组顺序。资料类页面由资源定义派生，其余是专门页面。 */
function financePages(): NavPage[] {
  const res = (key: string, group: string): NavPage => {
    const def = RESOURCE_DEFS.find((d) => d.key === key);
    if (!def) throw new Error(`财务导航引用了不存在的资料：${key}`);
    return { id: key, label: def.label, path: `/finance/${key}`, permission: `resource.${key}.view`, ready: true, group };
  };
  const own = (id: string, label: string, group: string): NavPage => ({ ...page('finance', id, label, FINANCE_BUILT.has(id)), group });
  return [
    own('overview', '财务经营', '经营财务'),
    own('doc-withdrawal', '店铺提现', '经营财务'),
    res('finance-products', '基础资料'),
    res('finance-suppliers', '基础资料'),
    res('finance-customers', '基础资料'),
    res('finance-fee-items', '基础资料'),
    own('history', '经营历程', '单据中心'),
    own('drafts', '草稿中心', '单据中心'),
    ...DOC_TYPES.filter((d) => d.type !== 'withdrawal').map((d) => own(`doc-${d.type}`, d.label, '制单中心')),
    own('cost-table', '成本表', '数据'),
    own('pricing-debug', '定价调试表', '数据'),
    res('finance-labor-costs', '数据'),
    res('finance-express-prices', '数据'),
    own('inventory', '库存查询', '实时查询'),
    own('cash-bank', '现金银行查询', '实时查询'),
    own('unsettled-receipts', '未完全结算收付款单', '实时查询'),
    own('settlement-detail', '收付款结算明细表', '实时查询'),
    res('finance-base-codes', '聚水潭分类'),
    res('finance-bundles', '聚水潭分类'),
    own('master-import', '商品数据导入', '聚水潭分类'),
    own('jst-maintenance', '资料维护', '聚水潭分类'),
  ];
}

/**
 * 宿主页面里的标签页：旧程序里这些内容是页面内的 Tab/面板，不是独立菜单。
 * ref 是资源 key（走通用资料页）或专门页面 id；permission 是进入这个标签需要的权限。
 * 第一个标签就是宿主页面本身。
 */
export interface PageTab { id: string; label: string; ref: string; permission: string }
const rtab = (key: string, label: string): PageTab => ({ id: key, label, ref: key, permission: `resource.${key}.view` });
const ptab = (id: string, label: string): PageTab => ({ id, label, ref: id, permission: `finance.${id}.view` });
export const PAGE_TABS: Record<string, readonly PageTab[]> = {
  'finance/cost-table': [ptab('cost-table', 'SKU成本表'), ptab('cost-history', '成本历史'), rtab('finance-margins', '分类利润率')],
  'finance/finance-express-prices': [rtab('finance-express-prices', '快递价格'), rtab('finance-freight-overrides', '成本表预估快递费'), ptab('zone-suggestion', '分区建议')],
  'finance/finance-products': [rtab('finance-products', '商品档案'), rtab('finance-packaging-schemes', '包装方案'), ptab('packaging-match', '包装方案匹配'), rtab('finance-zero-reasons', '零值原因'), rtab('finance-product-units', '单位与规格')],
  'finance/finance-suppliers': [rtab('finance-suppliers', '供应商档案'), rtab('finance-supplier-categories', '供应商分类')],
  'finance/finance-customers': [rtab('finance-customers', '客户档案'), rtab('finance-customer-categories', '客户分类')],
  'finance/finance-fee-items': [rtab('finance-fee-items', '费用档案'), rtab('finance-fee-categories', '费用类别')],
  'finance/finance-base-codes': [rtab('finance-base-codes', '商品基础编码'), rtab('finance-categories', '商品分类'), rtab('finance-brands', '品牌'), rtab('finance-product-exclusives', '专属品')],
  'finance/finance-bundles': [rtab('finance-bundles', '商品组合编码'), rtab('finance-platforms', '销售平台'), rtab('finance-scenarios', '销售场景')],
  'finance/inventory': [ptab('inventory', '库存查询'), rtab('finance-warehouses', '仓库')],
  'finance/master-import': [ptab('master-import', '导入'), ptab('master-reset', '主数据重置')],
  'finance/jst-maintenance': [ptab('jst-upload', '商品资料上传'), ptab('jst-sync', '同步队列')],
  'system/integrations': [{ id: 'integrations', label: '接口设置', ref: 'integrations', permission: 'system.integrations.view' }, ptab('api-keys', 'API 密钥')],
};

function page(section: string, id: string, label: string, ready = false): NavPage {
  return { id, label, path: `/${section}/${id}`, permission: `${section}.${id}.view`, ready };
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'workbench',
    icon: 'inbox',
    label: '工作台',
    pages: [
      page('workbench', 'home', '功能首页', true),
      page('workbench', 'boss', '老板总控台', true),
      page('workbench', 'desk', '岗位工作台', true),
      page('workbench', 'personal', '个人工作台', true),
      page('workbench', 'todos', '我的待办', true),
      page('workbench', 'tasks', '任务中心', true),
      page('workbench', 'started', '我发起的', true),
      page('workbench', 'cc', '抄送我的', true),
    ],
  },
  {
    id: 'flow',
    icon: 'flow',
    label: '流程',
    pages: [
      page('flow', 'apply', '申请中心', true),
      page('flow', 'overview', '流程总览', true),
      page('flow', 'templates', '流程配置', true),
      page('flow', 'node-templates', '节点中心', true),
      page('flow', 'timeouts', '超时与处罚', true),
    ],
  },
  {
    id: 'after-sales',
    icon: 'support',
    label: '售后',
    pages: [
      { ...page('after-sales', 'table', '售后表格', true), group: '售后管理' },
      { ...page('after-sales', 'appeals', '订单申诉', true), group: '售后管理' },
    ],
  },
  {
    id: 'supervision',
    icon: 'shield',
    label: '监督',
    pages: [{ ...page('supervision', 'center', '兜底监督', true), group: '兜底监督' }],
  },
  {
    id: 'finance',
    icon: 'wallet',
    label: '财务',
    pages: financePages(),
  },
  {
    id: 'resource',
    icon: 'database',
    label: '资料',
    pages: [
      { ...page('resource', 'overview', '资料总览', true), group: '资料首页', description: '基础资料数量和最近变更' },
      ...resourcePages(),
    ],
  },
  {
    id: 'features',
    icon: 'live',
    label: '功能',
    pages: [
      // 我的直播：主播、中控、运营的工作台（报上播/下播、提交审核、本人提成）；旧系统的主播/中控工作台
      { ...page('features', 'live-desk', '我的直播', true), group: '直播管理' },
      // 直播管理：全览图、排场、场次记录、待审核、提成记录、主播工资、提成结算、提成规则（页面内标签，按下面的权限显示）
      { ...page('features', 'live', '直播管理', true), group: '直播管理' },
    ],
  },
  {
    id: 'system',
    icon: 'settings',
    label: '系统',
    pages: [
      page('system', 'integrations', '接口设置', true),
      page('system', 'ai-api', 'AI API 接口', true),
      page('system', 'ocr', 'OCR 设置', true),
      page('system', 'settings', '系统设置'),
      page('system', 'audit', '审计日志', true),
    ],
  },
];

/** 页面之外的、需要单独授权的敏感能力。 */
export const SPECIAL_PERMISSIONS = {
  /** 查看成本金额；运营默认没有 */
  productCostView: 'product.cost.view',
  /** 编辑成本与利润率；财务和管理员才有 */
  productCostEdit: 'product.cost.edit',
  /** 店铺提现登录管理：添加店铺、填账号密码、查看密码、请求登录、管理授权电脑 */
  financeSessionManage: 'finance.session.manage',
  /** 远程协助：对授权电脑上的店铺窗口发起"观看/协助"（电脑要先由管理员开启远程协助） */
  financeSessionRemote: 'finance.session.remote',
  /** 公司店铺维护：添加店铺、填登录账号密码、看密码、请求登录、改店铺状态 */
  companyStoreMaintenanceManage: 'resource.company-store-maintenance.manage',
  /** 给别人指派任务（给自己建任务不需要） */
  tasksAssign: 'tasks.assign',
  /** 创建、修改、停用周期任务 */
  tasksRoutinesManage: 'tasks.routines.manage',
  /** 保存并发布流程配置（办理人、时限、抄送）；看配置页另需 flow.templates.view */
  flowTemplatesManage: 'flow.templates.manage',
  /** 确认或免除流程超时处罚（涉及金额，单独授权）；看台账另需 flow.timeouts.view */
  flowPenaltiesManage: 'flow.penalties.manage',
  /** 查看商品价格 */
  productPriceView: 'product.price.view',
  /** 组合装同步维护：把组合编码加入聚水潭同步队列（上传、改码、归档停用、基本售价同步）、重试/取消组合装任务；旧系统 finance-product-bundles.sync。总开关仍只有公司管理员能动 */
  financeBundleSync: 'finance.bundle-sync.manage',
  /** 兜底监督管理：关闭/升级异常、改监督规则、立即扫描；看监督中心另需 supervision.center.view */
  supervisionManage: 'supervision.manage',
  /** 直播管理：排场、修改提成规则、生成月结单并提交审批 */
  liveManage: 'live.manage',
  /** 直播管理：查看全员的提成、主播工资和月结（没有它只能看本人的） */
  liveCommissionsView: 'live.commissions.view',
} as const;

export interface VisibleSection extends NavSection {
  /** 该一级菜单下第一个可进入的页面路径，点击一级菜单时跳这里 */
  landingPath: string;
}

/** 按权限过滤出可见的一级菜单和页面；只含已完成的页面，没有可见页面的一级菜单会被去掉。 */
export function visibleSections(
  can: (permission: string) => boolean,
  options: { includePlanned?: boolean } = {},
): VisibleSection[] {
  const result: VisibleSection[] = [];
  for (const section of NAV_SECTIONS) {
    const pages = section.pages.filter(
      (p) => (options.includePlanned || p.ready) && can(p.permission),
    );
    if (pages.length === 0) continue;
    result.push({ ...section, pages, landingPath: pages[0].path });
  }
  return result;
}

export function findPageByPath(pathname: string): { section: NavSection; page: NavPage } | undefined {
  for (const section of NAV_SECTIONS) {
    const found = section.pages.find((p) => pathname === p.path || pathname.startsWith(`${p.path}/`));
    if (found) return { section, page: found };
  }
  return undefined;
}

/** 平台后台（平台管理员专用，与公司菜单分开；不使用公司权限键，只有“平台管理员”这一种身份）。 */
export const PLATFORM_PAGES = [
  { id: 'applications', title: '企业申请审核' },
  { id: 'companies', title: '企业管理' },
  { id: 'integrations', title: '接口应用' },
] as const;
export type PlatformPageId = (typeof PLATFORM_PAGES)[number]['id'];

/**
 * 资料记录的页面路径（用于“关联”“到期提醒”等处跳转并打开这条记录）。
 * 优先找以资料类型为页面的菜单项；银行卡这类按类型拆成多个入口的，取第一个入口；找不到（只在别的页面里作为页签/子资料出现）返回 null。
 */
export function resourcePagePath(type: string): string | null {
  for (const section of NAV_SECTIONS) {
    if (section.id !== 'resource' && section.id !== 'finance') continue;
    const direct = section.pages.find((p) => p.id === type && p.ready);
    if (direct) return direct.path;
  }
  const view = RESOURCE_VIEWS.find((v) => v.type === type);
  if (view) {
    for (const section of NAV_SECTIONS) {
      const p = section.pages.find((x) => x.id === view.id && x.ready);
      if (p) return p.path;
    }
  }
  return null;
}


/** 手机底部标签栏固定放的一级菜单（按这个顺序，只放当前账号看得到的），其余收进“更多”。 */
export const MOBILE_PRIMARY_SECTIONS = ['workbench', 'flow', 'finance', 'resource', 'features'] as const;

/** 一级菜单下的分组：同一个分组标题连续的页面归为一组；没有分组标题的页面归到以一级菜单名命名的组。 */
export interface PageGroup { title: string; pages: NavPage[] }
export function groupPages(section: Pick<NavSection, 'label' | 'pages'>): PageGroup[] {
  const groups: PageGroup[] = [];
  for (const p of section.pages) {
    const title = p.group ?? section.label;
    const last = groups[groups.length - 1];
    if (last && last.title === title) last.pages.push(p);
    else groups.push({ title, pages: [p] });
  }
  return groups;
}

/** 一级菜单只有一个页面时，点它直接进入，不用再弹二级菜单。 */
export function directPage(section: Pick<NavSection, 'pages'>): NavPage | null {
  return section.pages.length === 1 ? section.pages[0] : null;
}

export interface NavSearchHit { sectionId: string; sectionLabel: string; groupTitle: string; page: NavPage }

/** 菜单搜索：关键词用空格/逗号分开，每个词都要命中页面名、分组名或一级菜单名。 */
export function searchNav(sections: readonly VisibleSection[], query: string): NavSearchHit[] {
  const terms = query.toLowerCase().split(/[\s,，、]+/).filter(Boolean).slice(0, 6);
  if (terms.length === 0) return [];
  const hits: NavSearchHit[] = [];
  for (const section of sections) {
    for (const group of groupPages(section)) {
      for (const page of group.pages) {
        const text = `${page.label} ${group.title} ${section.label}`.toLowerCase();
        if (terms.every((t) => text.includes(t))) hits.push({ sectionId: section.id, sectionLabel: section.label, groupTitle: group.title, page });
      }
    }
  }
  return hits;
}

/** 手机底栏要放的一级菜单和收进“更多”的一级菜单。 */
export function splitMobileSections<T extends { id: string }>(sections: readonly T[]): { primary: T[]; more: T[] } {
  const primary = MOBILE_PRIMARY_SECTIONS.map((id) => sections.find((s) => s.id === id)).filter((s): s is T => Boolean(s));
  const ids = new Set(primary.map((s) => s.id));
  return { primary, more: sections.filter((s) => !ids.has(s.id)) };
}
