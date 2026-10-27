import { describe, expect, it } from 'vitest';
import { evalCondition, getFlowTemplate, validateSteps, type FlowTemplate, type StepDef } from './flow';
import { BUILTIN_NODE_TEMPLATES, defaultTimeoutPolicy, normalizeTimeoutPolicy, penaltyCents, resolveTimeoutPolicy, validateCustomTemplate, validateNodeTemplate } from './flow-custom';

const emp = (id: number) => ({ source: 'employee' as const, id });
const tpl = (): FlowTemplate => ({
  key: 'c1', label: '测试', description: '', custom: true,
  fields: [{ key: 'amount', label: '金额', type: 'money', group: '申请', required: true }, { key: 'kind', label: '类型', type: 'select', group: '申请', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
  stepFields: { pay: [{ key: 'voucher', label: '凭证号', type: 'text', group: '付款' }] }, steps: [],
});
const steps = (): StepDef[] => [
  { key: 'apply', name: '申请', type: 'submit', assignee: { source: 'requester' } },
  { key: 'boss', name: '老板审批', type: 'approval', assignee: emp(2), dueMinutes: 60, when: { field: 'payload.amount', op: 'gte', value: 100000 } },
  { key: 'pay', name: '付款', type: 'finance', assignee: emp(3) },
  { key: 'end', name: '结束', type: 'end' },
];

describe('自建流程模板校验', () => {
  it('合法模板通过；条件、退回目标、督促提醒的错误都能指出', () => {
    expect(validateCustomTemplate(tpl(), steps())).toEqual([]);
    const bad = steps();
    bad[1] = { ...bad[1], when: { field: 'payload.nope', op: 'eq', value: 1 }, remind: { beforeMinutes: [90] }, returnToKey: 'pay' };
    const errs = validateCustomTemplate(tpl(), bad).join('；');
    expect(errs).toContain('不存在');
    expect(errs).toContain('小于处理时限');
    expect(errs).toContain('退回目标');
  });
  it('条件只能引用前面步骤的办理字段；结束步不能带条件；会签只能用部门', () => {
    const s = steps();
    s[1] = { ...s[1], when: { field: 'form.pay.voucher', op: 'notempty' } };
    expect(validateCustomTemplate(tpl(), s).join('；')).toContain('必须在它前面');
    const e = steps();
    e[3] = { ...e[3], when: { field: 'payload.amount', op: 'gt', value: 1 } };
    expect(validateCustomTemplate(tpl(), e).join('；')).toContain('不能带条件');
    const m = steps();
    m[2] = { ...m[2], mode: 'all' };
    expect(validateCustomTemplate(tpl(), m).join('；')).toContain('全员会签');
  });
  it('表单字段：键重复、下拉没选项、引用类型都会报错', () => {
    const t = tpl();
    t.fields.push({ key: 'amount', label: '重复', type: 'text', group: 'x' } as never, { key: 'pick', label: '选', type: 'select', group: 'x' } as never, { key: 'who', label: '谁', type: 'ref', ref: 'nope', group: 'x' } as never);
    const errs = validateCustomTemplate(t, steps()).join('；');
    expect(errs).toContain('编号重复');
    expect(errs).toContain('选项');
    expect(errs).toContain('资料类型');
  });
  it('内置业务模板的 locked 步骤不能设置条件/会签', () => {
    const t = getFlowTemplate('license-borrow')!;
    const s = t.steps.map((x) => (x.key === 'approve' ? { ...x, assignee: emp(1), when: { field: 'payload.item', op: 'eq', value: 'copy' } } : x.type !== 'submit' && x.type !== 'end' ? { ...x, assignee: emp(1) } : x)) as StepDef[];
    expect(validateSteps(t, s).join('；')).toContain('不能设置条件');
  });
  it('上一步办理人、发起人的上级不需要选对象', () => {
    const s = steps();
    s[2] = { ...s[2], assignee: { source: 'requester_manager' } };
    s[1] = { ...s[1], assignee: { source: 'previous_handler' } };
    expect(validateCustomTemplate(tpl(), s).join('；')).toContain('上一步办理人');
    s[1] = { ...s[1], assignee: emp(2) };
    expect(validateCustomTemplate(tpl(), s)).toEqual([]);
  });
});

describe('条件求值', () => {
  const ctx = { payload: { amount: 150000, kind: 'a' } as Record<string, unknown>, forms: { pay: { voucher: 'X1' } } };
  it('各种运算', () => {
    expect(evalCondition({ field: 'payload.amount', op: 'gte', value: 100000 }, ctx)).toBe(true);
    expect(evalCondition({ field: 'payload.amount', op: 'lt', value: 100000 }, ctx)).toBe(false);
    expect(evalCondition({ field: 'payload.kind', op: 'in', value: ['a', 'b'] }, ctx)).toBe(true);
    expect(evalCondition({ field: 'payload.kind', op: 'ne', value: 'a' }, ctx)).toBe(false);
    expect(evalCondition({ field: 'payload.none', op: 'ne', value: 'a' }, ctx)).toBe(true);
    expect(evalCondition({ field: 'payload.none', op: 'gt', value: 1 }, ctx)).toBe(false);
    expect(evalCondition({ field: 'form.pay.voucher', op: 'notempty' }, ctx)).toBe(true);
  });
});

describe('节点模板与超时处罚规则', () => {
  it('内置节点模板都合法', () => {
    for (const t of BUILTIN_NODE_TEMPLATES) expect(validateNodeTemplate(t)).toEqual([]);
  });
  it('处罚金额：固定/累计/分档/封顶，整数分', () => {
    const base = { ...defaultTimeoutPolicy().penalties, enabled: true };
    expect(penaltyCents({ ...base, amountCents: 500 }, 59)).toBe(0);
    expect(penaltyCents({ ...base, amountCents: 500 }, 60)).toBe(500);
    const rep = { ...base, mode: 'repeat' as const, amountCents: 500, repeatMinutes: 30, repeatAmountCents: 200, capCents: 700 };
    expect(penaltyCents(rep, 125)).toBe(700);
    expect(penaltyCents({ ...rep, capCents: null }, 125)).toBe(900);
    const tiers = { ...base, mode: 'tiers' as const, tiers: [{ afterMinutes: 30, amountCents: 100 }, { afterMinutes: 120, amountCents: 800 }] };
    expect(penaltyCents(tiers, 29)).toBe(0);
    expect(penaltyCents(tiers, 200)).toBe(800);
    expect(penaltyCents({ ...tiers, enabled: false }, 200)).toBe(0);
  });
  it('规则校验：老板阈值不能早于主管；分档不能递减；沿用上一层', () => {
    const d = defaultTimeoutPolicy();
    expect(normalizeTimeoutPolicy({ notifications: { ...d.notifications, enabled: true, supervisorAfterMinutes: 30, bossAfterMinutes: 10 }, penalties: d.penalties }, true).errors.join()).toContain('老板通知阈值');
    const bad = { ...d.penalties, enabled: true, mode: 'tiers', tiers: [{ afterMinutes: 10, amountCents: 500 }, { afterMinutes: 20, amountCents: 100 }] };
    expect(normalizeTimeoutPolicy({ penalties: bad }, false).errors.join()).toContain('不能随超时增加而减少');
    expect(normalizeTimeoutPolicy({ notifications: null, penalties: null }, false).errors).toEqual([]);
    const rows = [
      { templateKey: '', nodeKey: '', policy: { penalties: { ...d.penalties, enabled: true, amountCents: 100 } } },
      { templateKey: 't', nodeKey: 'n1', policy: { penalties: { ...d.penalties, enabled: true, amountCents: 900 } } },
    ];
    expect(resolveTimeoutPolicy(rows, 't', 'n1').policy.penalties.amountCents).toBe(900);
    expect(resolveTimeoutPolicy(rows, 't', 'n2').policy.penalties.amountCents).toBe(100);
    expect(resolveTimeoutPolicy(rows, 't', 'n1').sources.penalties).toBe('节点独立');
  });
});
