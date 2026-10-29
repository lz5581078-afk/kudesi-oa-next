import { describe, expect, it } from 'vitest';
import { normalizeStarterScope, starterScopeAllows, starterScopeEmpty, type StarterWho } from './flow-starter';
import { getFlowTemplate, validateSteps, SKU_DUE_MINUTES, SKU_REMIND, type StepDef } from './flow';

const who = (o: Partial<StarterWho> = {}): StarterWho => ({ userId: 5, departmentId: 18, positionIds: [3], positionTypes: ['operations'], dutyGroupIds: [], ...o });

describe('发起人范围', () => {
  it('范围为空（没配、null、全是空数组）= 不限制，沿用原有行为', () => {
    expect(starterScopeAllows(null, who())).toBe(true);
    expect(starterScopeAllows({}, who())).toBe(true);
    expect(starterScopeAllows({ users: [], departments: [] }, who())).toBe(true);
    expect(starterScopeEmpty({ users: [] })).toBe(true);
  });
  it('部门、岗位、角色、职责组、员工任一命中即可；都不命中则不能发起', () => {
    expect(starterScopeAllows({ departments: [18] }, who())).toBe(true);
    expect(starterScopeAllows({ departments: [20, 31] }, who())).toBe(false);
    expect(starterScopeAllows({ positions: [3] }, who())).toBe(true);
    expect(starterScopeAllows({ positions: [4] }, who())).toBe(false);
    expect(starterScopeAllows({ positionTypes: ['operations'] }, who())).toBe(true);
    expect(starterScopeAllows({ positionTypes: ['finance'] }, who())).toBe(false);
    expect(starterScopeAllows({ users: [5] }, who())).toBe(true);
    expect(starterScopeAllows({ dutyGroups: [9] }, who({ dutyGroupIds: [9] }))).toBe(true);
    // 采购式配置：多个来源取并集
    expect(starterScopeAllows({ positionTypes: ['finance'], departments: [18, 20, 31] }, who())).toBe(true);
    expect(starterScopeAllows({ departments: [18] }, who({ departmentId: null }))).toBe(false);
  });
  it('整理：去重、全空返回 null；不认识的键、非法编号、未知角色都报错', () => {
    expect(normalizeStarterScope({ departments: [1, 1, 2], users: [] })).toEqual({ scope: { departments: [1, 2] }, errors: [] });
    expect(normalizeStarterScope({ users: [] })).toEqual({ scope: null, errors: [] });
    expect(normalizeStarterScope(undefined).scope).toBeNull();
    expect(normalizeStarterScope({ foo: [1] }).errors.join()).toContain('不认识');
    expect(normalizeStarterScope({ users: [0] }).errors.join()).toContain('编号不合法');
    expect(normalizeStarterScope({ users: ['a'] }).errors.join()).toContain('编号不合法');
    expect(normalizeStarterScope({ positionTypes: ['ghost'] }).errors.join()).toContain('不认识的角色');
    expect(normalizeStarterScope({ positionTypes: ['finance', 'warehouse'] }).scope).toEqual({ positionTypes: ['finance', 'warehouse'] });
    expect(normalizeStarterScope({ users: Array.from({ length: 201 }, (_, i) => i + 1) }).errors.join()).toContain('最多');
    expect(normalizeStarterScope([1]).errors.length).toBe(1);
  });
});

describe('SKU 申请节点默认时限（旧版实际 60 分钟 + 提前 20、10 分钟提醒）', () => {
  const sku = getFlowTemplate('sku-batch-apply')!;
  it('仓库、财务默认 60 分钟，提醒 20/10 分钟、超时每 5 分钟；专属品审批同样沿用旧配置', () => {
    expect(SKU_DUE_MINUTES).toBe(60);
    for (const k of ['warehouse', 'review']) expect(sku.steps.find((s) => s.key === k)).toMatchObject({ dueMinutes: 60, remind: { beforeMinutes: [20, 10], overdueEveryMinutes: 5 } });
    expect(getFlowTemplate('product-exclusive')!.steps.find((s) => s.key === 'approve')).toMatchObject({ dueMinutes: 60, remind: SKU_REMIND });
  });
  it('默认值本身能通过步骤校验，管理员改时限后提醒必须仍小于时限', () => {
    const people: StepDef[] = sku.steps.map((s) => (s.type === 'execute' || s.type === 'finance' ? { ...s, assignee: { source: 'employee' as const, id: 7 } } : { ...s }));
    expect(validateSteps(sku, people)).toEqual([]);
    const shorter = people.map((s) => (s.key === 'warehouse' ? { ...s, dueMinutes: 15 } : s));
    expect(validateSteps(sku, shorter).join()).toContain('小于处理时限');
    const longer = people.map((s) => (s.key === 'warehouse' ? { ...s, dueMinutes: 240, remind: { beforeMinutes: [30], overdueEveryMinutes: 10 } } : s));
    expect(validateSteps(sku, longer)).toEqual([]);
  });
});
