import { describe, expect, it } from 'vitest';
import type { StepDef } from '@kudesi/shared';
import { conditionValueToStored, describeAssignee, describeCondition, describeRemind, insertStepAfter, moveStep, sanitizeRefs, stepFromNodeTemplate, uniqueKey } from './designerUi';

const st = (key: string, type: StepDef['type'], extra: Partial<StepDef> = {}): StepDef => ({ key, name: key, type, ...extra }) as StepDef;
const steps = [st('apply', 'submit'), st('a', 'approval'), st('b', 'execute', { locked: true }), st('c', 'finance', { locked: true }), st('end', 'end')];

describe('设计器纯函数', () => {
  it('办理人描述：发起人/指定人/岗位/部门会签/上级/未选择', () => {
    const names = (s: string, id: number) => (s === 'employee' ? '张三' : s === 'position' ? '采购' : id === 1 ? '仓库' : undefined);
    expect(describeAssignee(st('apply', 'submit'), names)).toBe('发起人');
    expect(describeAssignee(st('x', 'approval', { assignee: { source: 'employee', id: 3 } }), names)).toBe('张三');
    expect(describeAssignee(st('x', 'approval', { assignee: { source: 'position', id: 3 } }), names)).toBe('岗位 采购');
    expect(describeAssignee(st('x', 'approval', { assignee: { source: 'department', id: 1 }, mode: 'all' }), names)).toBe('仓库（全员会签）');
    expect(describeAssignee(st('x', 'approval', { assignee: { source: 'requester_manager' } }), names)).toBe('发起人的上级');
    expect(describeAssignee(st('x', 'approval', { assignee: { source: 'employee' } }), names)).toBe('未选择');
  });
  it('条件描述：金额按元显示、选项显示名称', () => {
    const t = { fields: [{ key: 'amount', label: '金额', type: 'money', group: 'g' }, { key: 'kind', label: '类型', type: 'select', group: 'g', options: [{ value: 'a', label: '甲' }] }], stepFields: {} } as never;
    expect(describeCondition({ field: 'payload.amount', op: 'gte', value: 100000 }, t, steps)).toBe('金额大于等于 1000 元');
    expect(describeCondition({ field: 'payload.kind', op: 'in', value: ['a'] }, t, steps)).toBe('类型属于其中之一 甲');
    expect(conditionValueToStored({ key: 'amount', label: '', type: 'money', group: '' }, '12.5')).toBe(1250);
  });
  it('督促描述', () => {
    expect(describeRemind(st('x', 'approval', { remind: { beforeMinutes: [60, 10], overdueEveryMinutes: 30 } }))).toBe('到期前 1 小时、10 分钟提醒，超时后每 30 分钟提醒');
  });
  it('插入、挪动：发起/结束固定，locked 步骤顺序不变', () => {
    const ins = insertStepAfter(steps, 3, st('n', 'approval'));
    expect(ins.map((s) => s.key)).toEqual(['apply', 'a', 'b', 'c', 'n', 'end']);
    expect(insertStepAfter(steps, 4, st('n', 'approval')).map((s) => s.key).at(-1)).toBe('end');
    expect(moveStep(steps, 1, 3)?.map((s) => s.key)).toEqual(['apply', 'b', 'c', 'a', 'end']);
  });
  it('挪动 locked 之间的顺序被拒绝；可挪动的能挪', () => {
    const s2 = [st('apply', 'submit'), st('a', 'approval'), st('b', 'execute', { locked: true }), st('c', 'finance', { locked: true }), st('end', 'end')];
    expect(moveStep(s2, 2, 3)).toBeNull();
    expect(moveStep(s2, 1, 3)?.map((s) => s.key)).toEqual(['apply', 'b', 'c', 'a', 'end']);
    expect(moveStep(s2, 0, 2)).toBeNull();
    expect(moveStep(s2, 4, 1)).toBeNull();
  });
  it('清理失效引用', () => {
    const r = sanitizeRefs([st('apply', 'submit'), st('a', 'approval', { returnToKey: 'gone', when: { field: 'form.gone.x', op: 'notempty' } }), st('end', 'end')]);
    expect(r.steps[1].returnToKey).toBeNull();
    expect(r.steps[1].when).toBeNull();
    expect(r.notes).toHaveLength(2);
  });
  it('套用节点模板：生成新步骤和字段副本，来源只做记录', () => {
    const r = stepFromNodeTemplate({ key: 'approval', name: '审批确认', type: 'approval', dueMinutes: 1440, fields: [{ key: 'comment', label: '意见', type: 'text', group: 'g' }] }, steps);
    expect(r.step).toMatchObject({ name: '审批确认', type: 'approval', nodeTemplateKey: 'approval', dueMinutes: 1440 });
    expect(uniqueKey(['step1', 'step2'])).toBe('step3');
    expect(r.fields).toHaveLength(1);
  });
});
