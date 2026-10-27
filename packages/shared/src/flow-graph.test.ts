import { describe, expect, it } from 'vitest';
import { LEGACY_NODE_TEMPLATES, validateCustomTemplate, validateGraph, type FlowTemplate, type StepDef } from './index';

const tpl = (fields: FlowTemplate['fields'] = []): FlowTemplate => ({ key: 'c1', label: '自建', description: '', custom: true, fields, stepFields: {}, steps: [] });
const emp = { source: 'employee' as const, id: 3 };
const st = (o: Partial<StepDef> & { key: string }): StepDef => ({ name: o.key, type: 'approval', assignee: emp, ...o });
const base = (mid: StepDef[]): StepDef[] => [{ key: 'apply', name: '发起', type: 'submit', assignee: { source: 'requester' } }, ...mid, { key: 'end', name: '结束', type: 'end' }];

describe('并行分支与异常连线校验', () => {
  it('分支至少 2 个且必须相邻', () => {
    expect(validateGraph(base([st({ key: 'a', parallel: 'g' }), st({ key: 'b' })]))).toEqual([expect.stringContaining('至少要有 2 个')]);
    expect(validateGraph(base([st({ key: 'a', parallel: 'g' }), st({ key: 'b' }), st({ key: 'c', parallel: 'g' })]))).toEqual([expect.stringContaining('必须相邻')]);
    expect(validateGraph(base([st({ key: 'a', parallel: 'g' }), st({ key: 'b', parallel: 'g' })]))).toEqual([]);
  });
  it('分支里不能用上一步办理人、异常连线、退回到分支内', () => {
    const errs = validateGraph(base([st({ key: 'a', parallel: 'g', assignee: { source: 'previous_handler' } }), st({ key: 'b', parallel: 'g', returnToKey: 'a' })]));
    expect(errs.join('；')).toMatch(/上一步办理人/);
    expect(errs.join('；')).toMatch(/同一并行分支/);
  });
  it('异常连线必须指向仅异常步骤，仅异常步骤必须被指向', () => {
    expect(validateGraph(base([st({ key: 'a', exceptionToKey: 'x' }), st({ key: 'x' })])).join('；')).toMatch(/仅异常/);
    expect(validateGraph(base([st({ key: 'a', exceptionToKey: 'x' }), st({ key: 'x', onlyOnException: true })]))).toEqual([]);
    expect(validateGraph(base([st({ key: 'a' }), st({ key: 'x', onlyOnException: true })])).join('；')).toMatch(/没有任何步骤的异常连线/);
  });
});

describe('新的办理人来源', () => {
  const run = (a: StepDef['assignee'], fields = [{ key: 'storeId', label: '店铺', type: 'ref' as const, ref: 'stores', group: '申请' }]) => validateCustomTemplate(tpl(fields), base([st({ key: 'a', assignee: a })]));
  it('岗位类型要选合法类型', () => {
    expect(run({ source: 'position_type', key: 'finance' })).toEqual([]);
    expect(run({ source: 'position_type', key: 'nope' }).join('')).toMatch(/岗位类型/);
  });
  it('职责组要选具体职责组', () => {
    expect(run({ source: 'duty_group', id: 5 })).toEqual([]);
    expect(run({ source: 'duty_group' }).join('')).toMatch(/职责组/);
  });
  it('关联资料负责人：字段必须是指向对应资料的引用字段', () => {
    expect(run({ source: 'related_owner', key: 'store_owner', field: 'storeId' })).toEqual([]);
    expect(run({ source: 'related_owner', key: 'phone_user', field: 'storeId' }).join('')).toMatch(/字段/);
    expect(run({ source: 'related_owner', key: 'store_owner' }).join('')).toMatch(/字段/);
  });
});

describe('旧系统节点模板迁移', () => {
  it('41 个迁入，键唯一，可插入的节点有类型合法且字段都存在', () => {
    expect(LEGACY_NODE_TEMPLATES.length).toBe(41);
    expect(new Set(LEGACY_NODE_TEMPLATES.map((t) => t.key)).size).toBe(41);
    for (const t of LEGACY_NODE_TEMPLATES.filter((x) => x.insertable)) {
      expect(['approval', 'execute', 'finance']).toContain(t.type);
      expect(t.fields.every((f) => f && f.key && f.label)).toBe(true);
    }
    expect(LEGACY_NODE_TEMPLATES.filter((t) => t.category === '业务专用').every((t) => t.insertable === false)).toBe(true);
  });
});
