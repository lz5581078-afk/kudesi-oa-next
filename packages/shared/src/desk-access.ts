import { deskFor, deskLinks, navPageByKey } from './workspace';
import { SPECIAL_PERMISSIONS } from './navigation';
import { resourcePermission } from './resources';

/** 岗位只开放功能入口；审批、办理、财务动作仍走流程，不能批量授予全局操作键。 */
export function deskAccessPermissions(type: string, level: string): string[] {
  const def = deskFor(type);
  const pages = new Set([
    'workbench.desk', 'workbench.personal', 'workbench.todos', 'workbench.tasks',
    'workbench.started', 'workbench.cc', 'flow.apply',
    ...deskLinks(def, level, () => true).map((p) => `${p.sectionId}.${p.id}`),
  ]);
  if (['finance', 'cashier', 'purchasing', 'warehouse', 'boss'].includes(type)) {
    pages.add('finance.drafts'); pages.add('finance.history');
  }
  if (['general', 'operations', 'boss'].includes(type)) pages.add('resource.overview');
  if (type === 'operations') {
    pages.add('resource.store-daily-metrics'); pages.add('features.live-desk');
  }
  if (def.modules?.includes('after-sales')) { pages.add('after-sales.table'); pages.add('after-sales.appeals'); }
  if (def.modules?.includes('supervision')) pages.add('supervision.center');
  const keys = new Set([...pages].map((k) => navPageByKey(k)?.permission).filter((k): k is string => !!k));
  if (type === 'operations') keys.add(resourcePermission('store-daily-metrics', 'view'));
  // 此能力仍须是当前“入库登记”节点的办理人，只能生成本流程草稿，不能开立/过账。
  keys.add(SPECIAL_PERMISSIONS.flowPurchaseInboundDraft);
  return [...keys].sort();
}

export interface DeskAccessPositionChange {
  id: number; name: string; departmentName: string; workspaceType: string;
  preserved: boolean; before: string[]; after: string[]; added: string[]; removed: string[];
  pages: string[];
}
export interface DeskAccessStaffChange {
  id: number; name: string; preserved: boolean; reason: string;
  before: Array<{ permission: string; effect: 'allow' | 'deny' }>;
}
export interface DeskAccessPlan {
  companyId: number; companyName: string; fingerprint: string;
  positions: DeskAccessPositionChange[]; staff: DeskAccessStaffChange[];
  protectedDepartments: string[]; changedPositions: number; changedStaff: number;
}
