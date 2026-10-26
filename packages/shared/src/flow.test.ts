import { describe, expect, it } from 'vitest';
import { FLOW_TEMPLATES, getFlowTemplate, validatePostingDecl, validateSteps, type StepDef } from './flow';
import { validateResourceInput } from './resources';

const tpl = getFlowTemplate('license-borrow')!;
const withPeople = (): StepDef[] => tpl.steps.map((s) => (s.type === 'approval' || s.type === 'execute' ? { ...s, assignee: { source: 'employee' as const, id: 7 } } : { ...s }));

describe('流程模板和步骤校验', () => {
  it('每个模板的字段键不重复、步骤键不重复、第一步发起最后一步结束', () => {
    for (const t of FLOW_TEMPLATES) {
      expect(new Set(t.fields.map((f) => f.key)).size).toBe(t.fields.length);
      expect(new Set(t.steps.map((s) => s.key)).size).toBe(t.steps.length);
      expect(t.steps[0].type).toBe('submit');
      expect(t.steps[t.steps.length - 1].type).toBe('end');
      for (const k of Object.keys(t.stepFields)) expect(t.steps.some((s) => s.key === k)).toBe(true);
    }
  });
  it('默认步骤没有配办理人，不能直接发布；配好后通过', () => {
    expect(validateSteps(tpl, tpl.steps).some((e) => e.includes('要指定办理人'))).toBe(true);
    expect(validateSteps(tpl, withPeople())).toEqual([]);
  });
  it('业务必须的步骤不能删、不能换顺序、不能改类型；新增的只能是审批', () => {
    const base = withPeople();
    expect(validateSteps(tpl, base.filter((s) => s.key !== 'handover')).join()).toContain('缺少业务必须的步骤');
    const swapped = [base[0], base[1], base[3], base[2], base[4]];
    expect(validateSteps(tpl, swapped).join()).toContain('顺序不能改');
    const extra: StepDef = { key: 'boss', name: '老板复核', type: 'approval', assignee: { source: 'position', id: 3 } };
    expect(validateSteps(tpl, [base[0], base[1], extra, ...base.slice(2)])).toEqual([]);
    expect(validateSteps(tpl, [base[0], base[1], { ...extra, type: 'execute' }, ...base.slice(2)]).join()).toContain('只能是审批');
  });
  it('时限、抄送人数、办理人对象都要合法', () => {
    const base = withPeople();
    base[1] = { ...base[1], dueMinutes: 0 };
    expect(validateSteps(tpl, base).join()).toContain('时限');
    base[1] = { ...base[1], dueMinutes: 60, ccUserIds: Array.from({ length: 21 }, (_, i) => i + 1) };
    expect(validateSteps(tpl, base).join()).toContain('最多抄送 20 人');
    base[1] = { ...base[1], ccUserIds: [], assignee: { source: 'position' } };
    expect(validateSteps(tpl, base).join()).toContain('要选择具体的');
  });
  it('发起表单字段能用通用校验器：必填、日期、金额', () => {
    const def = { key: 'flow:x', label: 'x', titleField: 'borrower', statuses: [], defaultStatus: '', fields: tpl.fields } as never;
    const bad = validateResourceInput(def, { borrower: '' }, { status: '' });
    expect(bad.errors.length).toBeGreaterThan(3);
    const ok = validateResourceInput(def, { licenseId: 1, item: 'original', borrower: '张三', purpose: '开户', borrowedAt: '2026-03-01', expectedReturnAt: '2026-03-05' }, { status: '' });
    expect(ok.errors).toEqual([]);
    const exp = getFlowTemplate('expense-request')!;
    const e = validateResourceInput({ key: 'flow:e', label: 'e', titleField: 'reason', statuses: [], defaultStatus: '', fields: exp.fields } as never, { feeItemId: 2, amountCents: 1.5, occurredAt: '2026-03-01', reason: '房租' }, { status: '' });
    expect(e.errors.join()).toContain('整数');
  });
});

describe('流程自动记账声明', () => {
  it('所有模板的声明都合法；费用申请在“财务付款”这一步记账', () => {
    for (const t of FLOW_TEMPLATES) expect(validatePostingDecl(t)).toEqual([]);
    expect(getFlowTemplate('expense-request')!.posting).toMatchObject({ at: 'pay', docType: 'expense', post: true, refNo: 'form.voucher' });
    expect(getFlowTemplate('license-borrow')!.posting).toBeUndefined();
  });
  it('声明引用了不存在的步骤/字段、类型不对、办理字段不必填时报错', () => {
    const t = getFlowTemplate('expense-request')!;
    const bad = (over: Record<string, unknown>) => validatePostingDecl({ ...t, posting: { ...t.posting!, ...over } as never });
    expect(bad({ at: 'nope' }).join()).toMatch(/不存在/);
    expect(bad({ at: 'apply' }).join()).toMatch(/不存在或不是办理步骤/);
    expect(bad({ amountCents: 'payload.reason' }).join()).toMatch(/类型不对/);
    expect(bad({ feeItemId: 'payload.missing' }).join()).toMatch(/不存在/);
    expect(bad({ date: 'paidAt' }).join()).toMatch(/写法不对/);
    expect(bad({ at: 'complete', date: 'form.paidAt' }).join()).toMatch(/没有办理表单/);
    expect(bad({ refNo: 'form.voucher', memo: undefined }).length).toBe(0);
  });
});
