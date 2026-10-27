/**
 * 旧系统岗位的“工作台模板”（workspace_template_key，31 种）到新系统岗位类型（workspaceType，9 种）的对应表。
 * 新系统的岗位类型是显式字段，不再按名称猜；迁移旧数据时按旧模板键查这张表，查不到的一律落到“空白”并留待人工核定。
 * 对应的依据是旧系统各工作台的业务入口：财务类归财务、收付款归出纳、仓储发货类归仓库、采购归采购、客服类归客服、
 * 运营类（含店铺运营、内容）；直播主播、直播中控各有自己的类型（排场与提成要靠它认人）归运营；其余通用事务岗位归综合。
 */
export type PositionWorkspaceType = 'boss' | 'general' | 'operations' | 'finance' | 'cashier' | 'warehouse' | 'purchasing' | 'support' | 'live_anchor' | 'live_control' | 'blank';

export const LEGACY_WORKSPACE_TEMPLATE_MAP: Readonly<Record<string, PositionWorkspaceType>> = {
  boss: 'boss',
  assistant: 'boss',
  operations: 'operations',
  operations_manager: 'operations',
  content: 'operations',
  content_manager: 'operations',
  live_anchor: 'live_anchor',
  live_control: 'live_control',
  design: 'operations',
  customer_service: 'support',
  customer_manager: 'support',
  logistics_safety: 'support',
  finance: 'finance',
  finance_manager: 'finance',
  cashier: 'cashier',
  warehouse: 'warehouse',
  warehouse_manager: 'warehouse',
  print_clerk: 'warehouse',
  shipping_staff: 'warehouse',
  procurement: 'purchasing',
  general_admin: 'general',
  hr_admin: 'general',
  hr_manager: 'general',
  branch_manager: 'general',
  sales: 'general',
  retail: 'general',
  technology: 'general',
  technology_manager: 'general',
  automation_operator: 'general',
  personal: 'general',
  blank: 'blank',
};

/** 新系统自己的 9 种岗位类型本身也认（已经是新值的数据原样通过）。 */
const NEW_TYPES: readonly string[] = ['boss', 'general', 'operations', 'finance', 'cashier', 'warehouse', 'purchasing', 'support', 'live_anchor', 'live_control', 'blank'];

/** 旧模板键 → 新岗位类型；不认识的返回 null（调用方保留“空白”并记入待核定清单）。 */
export function workspaceTypeFromLegacyTemplate(key: string | null | undefined): PositionWorkspaceType | null {
  if (!key) return null;
  const mapped = LEGACY_WORKSPACE_TEMPLATE_MAP[key];
  if (mapped) return mapped;
  return NEW_TYPES.includes(key) ? (key as PositionWorkspaceType) : null;
}
