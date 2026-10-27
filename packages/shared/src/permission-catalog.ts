/**
 * 可授予的权限清单：岗位权限、员工个人允许/拒绝都只能从这里选。
 * 全部由导航注册表和资料定义派生，新增页面或资料后自动出现，不用另外维护。
 */
import { NAV_SECTIONS, PAGE_TABS, SPECIAL_PERMISSIONS, OPENING_PREPAYMENT_PERMISSION } from './navigation';
import { RESOURCE_ACTIONS, RESOURCE_DEFS, permissionOwner, resourcePermission, type ResourceAction } from './resources';

export interface CatalogItem {
  key: string;
  label: string;
}
export interface CatalogGroup {
  id: string;
  label: string;
  items: CatalogItem[];
}

const ACTION_LABEL: Record<ResourceAction, string> = {
  view: '查看', create: '新增', edit: '修改', disable: '停用/注销', delete: '删除', import: '导入', export: '导出', secret: '查看密码明文',
};

/** 单据操作权限（新建/改草稿、开立、过账、红冲、删除草稿） */
export const FINANCE_DOC_ACTIONS = [
  { key: 'finance.docs.create', label: '新建、修改单据草稿' },
  { key: 'finance.docs.issue', label: '开立单据' },
  { key: 'finance.docs.post', label: '过账' },
  { key: OPENING_PREPAYMENT_PERMISSION, label: '登记已有预付款余额（不扣银行）' },
  { key: 'finance.docs.reverse', label: '红冲已过账单据' },
  { key: 'finance.docs.edit-header', label: '修改已过账单据的日期、经手人、说明' },
  { key: 'finance.docs.audit', label: '财务审核（审核后不能再红冲、修改）' },
  { key: 'finance.docs.delete', label: '删除草稿' },
] as const;

/** 组织管理自己的操作权限（页面查看权限已在导航里） */
const ORG_ACTIONS: CatalogGroup = {
  id: 'org-actions',
  label: '组织与权限管理',
  items: [
    { key: 'org.structure.view', label: '查看「部门与岗位」「岗位档案」' },
    { key: 'org.staff.view', label: '查看「员工与权限」' },
    { key: 'org.structure.create', label: '新增部门/岗位' },
    { key: 'org.structure.edit', label: '修改部门/岗位及岗位权限' },
    { key: 'org.structure.delete', label: '删除部门/岗位' },
    { key: 'org.staff.create', label: '新增员工' },
    { key: 'org.staff.edit', label: '修改员工及个人权限' },
    { key: 'org.staff.disable', label: '停用/启用员工' },
    { key: 'org.staff.reset', label: '重置员工密码' },
    { key: 'org.staff.salary', label: '查看、设置员工底薪' },
  ],
};

export function permissionCatalog(): CatalogGroup[] {
  const groups: CatalogGroup[] = [];
  for (const section of NAV_SECTIONS) {
    if (section.id === 'resource') continue; // 资料按类型单独列
    if (section.id === 'finance') continue; // 财务单独列
    const items = section.pages.filter((p) => p.ready).map((p) => ({ key: p.permission, label: `查看「${p.label}」` }));
    if (items.length > 0) groups.push({ id: section.id, label: section.label, items });
  }
  groups.push(ORG_ACTIONS);
  groups.push({ id: 'flow-actions', label: '流程与任务', items: [
    { key: SPECIAL_PERMISSIONS.flowTemplatesManage, label: '保存并发布流程配置（含自建流程、节点模板、超时规则）' },
    { key: SPECIAL_PERMISSIONS.flowPenaltiesManage, label: '确认或免除流程超时处罚' },
    { key: SPECIAL_PERMISSIONS.financeSessionManage, label: '店铺提现：管理店铺登录、查看密码' },
    { key: SPECIAL_PERMISSIONS.financeSessionRemote, label: '店铺提现：发起远程协助（看/操作授权电脑上的店铺窗口）' },
    { key: SPECIAL_PERMISSIONS.companyStoreMaintenanceManage, label: '公司店铺维护：管理店铺登录、查看密码、改店铺状态' },
    { key: SPECIAL_PERMISSIONS.tasksAssign, label: '给别人指派任务' },
    { key: SPECIAL_PERMISSIONS.tasksRoutinesManage, label: '管理周期任务' },
    { key: SPECIAL_PERMISSIONS.supervisionManage, label: '兜底监督：关闭异常、改监督规则、立即扫描' },
  ] });
  groups.push({
    id: 'product-sensitive',
    label: '商品敏感数据',
    items: [
      { key: SPECIAL_PERMISSIONS.productCostView, label: '查看成本金额' },
      { key: SPECIAL_PERMISSIONS.productCostEdit, label: '编辑成本与利润率' },
      { key: SPECIAL_PERMISSIONS.productPriceView, label: '查看商品价格' },
    ],
  });
  groups.push({ id: 'resource-overview', label: '资料总览', items: [{ key: 'resource.overview.view', label: '查看「资料总览」' }] });
  // 财务：专门页面 + 单据操作
  groups.push({
    id: 'finance-pages',
    label: '财务 · 页面',
    items: (() => {
      const items = NAV_SECTIONS.find((x) => x.id === 'finance')!.pages.filter((p) => !p.permission.startsWith('resource.')).map((p) => ({ key: p.permission, label: `查看「${p.label}」` }));
      // 宿主页里的标签页（成本历史、分区建议、API 密钥等）没有菜单入口，权限单独列出
      for (const tabs of Object.values(PAGE_TABS)) {
        for (const t of tabs) {
          if (t.permission.startsWith('finance.') && !items.some((i) => i.key === t.permission)) items.push({ key: t.permission, label: `查看「${t.label}」` });
        }
      }
      return items;
    })(),
  });
  groups.push({
    id: 'finance-jst-actions',
    label: '财务 · 聚水潭同步',
    items: [{ key: SPECIAL_PERMISSIONS.financeBundleSync, label: '组合装同步维护（加入同步队列、改码、归档停用、基本售价同步）' }],
  });
  groups.push({
    id: 'finance-doc-actions',
    label: '财务 · 单据操作',
    items: FINANCE_DOC_ACTIONS.map((a) => ({ key: a.key, label: a.label })),
  });
  const navGroups = [...new Set(RESOURCE_DEFS.filter((d) => d.nav).map((d) => `${d.nav!.section ?? 'resource'}|${d.nav!.group}`))];
  for (const sg of navGroups) {
    const [sec, g] = sg.split('|');
    const defs = RESOURCE_DEFS.filter((d) => d.nav?.group === g && (d.nav.section ?? 'resource') === sec && permissionOwner(d.key) === d.key);
    const items: CatalogItem[] = [];
    for (const d of defs) {
      const hasSecret = d.fields.some((f) => f.type === 'secret' || f.type === 'sensitive');
      for (const a of RESOURCE_ACTIONS) {
        if (a === 'secret' && !hasSecret) continue;
        items.push({ key: resourcePermission(d.key, a), label: `${d.label}：${ACTION_LABEL[a]}` });
      }
    }
    groups.push({ id: `${sec}-${g}`, label: `${sec === 'finance' ? '财务' : '资料'} · ${g}`, items });
  }
  return groups;
}

export function allGrantableKeys(): Set<string> {
  return new Set(permissionCatalog().flatMap((g) => g.items.map((i) => i.key)));
}
