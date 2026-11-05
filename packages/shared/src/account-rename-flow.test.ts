import { describe, expect, it } from 'vitest';
import { deskFlows, deskFor, getFlowTemplate, validateSteps } from './index';

describe('账号名称改名流程', () => {
  const t = getFlowTemplate('account-rename')!;
  const withAssignees = t.steps.map((s) => (s.key === 'approve_boss' ? { ...s, assignee: { source: 'employee' as const, id: 1 } }
    : s.type === 'approval' ? { ...s, assignee: { source: 'department' as const, id: 2 } } : s));
  it('节点顺序：申请→刘振先→人事部门→申请人改名→人事部通过→结束', () => {
    expect(t.steps.map((s) => s.key)).toEqual(['apply', 'approve_boss', 'approve_hr', 'rename', 'hr_confirm', 'end']);
  });
  it('只有声明过的改名步骤允许发起人本人办理，审批步骤不允许', () => {
    expect(validateSteps(t, withAssignees, [])).toEqual([]);
    const bad = withAssignees.map((s) => (s.key === 'approve_hr' ? { ...s, assignee: { source: 'requester' as const } } : s));
    expect(validateSteps(t, bad, []).join()).toContain('要指定办理人');
  });
  it('运营、直播、综合（人事）、老板工作台有快捷入口，没有申请中心权限则不显示', () => {
    const can = (p: string) => p === 'flow.apply.view';
    for (const type of ['operations', 'live_anchor', 'live_control', 'general', 'boss']) {
      expect(deskFlows(deskFor(type), can).map((f) => f.key)).toEqual(['account-rename']);
    }
    expect(deskFlows(deskFor('finance'), can)).toEqual([]);
    expect(deskFlows(deskFor('operations'), () => false)).toEqual([]);
  });
});
