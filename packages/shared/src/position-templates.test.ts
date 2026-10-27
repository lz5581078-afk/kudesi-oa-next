import { describe, expect, it } from 'vitest';
import { LEGACY_WORKSPACE_TEMPLATE_MAP, workspaceTypeFromLegacyTemplate } from './position-templates';

describe('旧工作台模板到新岗位类型的对应', () => {
  it('旧系统 31 个模板键都有明确的对应，且都落在新系统的 11 种类型里', () => {
    const legacy = ['operations', 'customer_service', 'customer_manager', 'general_admin', 'hr_admin', 'boss', 'warehouse_manager', 'print_clerk', 'finance', 'procurement', 'warehouse', 'design', 'content', 'technology', 'personal', 'assistant', 'shipping_staff', 'logistics_safety', 'cashier', 'branch_manager', 'sales', 'retail', 'automation_operator', 'finance_manager', 'hr_manager', 'operations_manager', 'technology_manager', 'content_manager', 'live_anchor', 'live_control', 'blank'];
    const types = ['boss', 'general', 'operations', 'finance', 'cashier', 'warehouse', 'purchasing', 'support', 'live_anchor', 'live_control', 'blank'];
    expect(Object.keys(LEGACY_WORKSPACE_TEMPLATE_MAP).sort()).toEqual([...legacy].sort());
    for (const k of legacy) expect(types).toContain(workspaceTypeFromLegacyTemplate(k));
    expect(workspaceTypeFromLegacyTemplate('procurement')).toBe('purchasing');
    expect(workspaceTypeFromLegacyTemplate('support')).toBe('support'); // 新值原样通过
    expect(workspaceTypeFromLegacyTemplate('不认识')).toBeNull();
    expect(workspaceTypeFromLegacyTemplate(null)).toBeNull();
  });
});
