import { describe, expect, it } from 'vitest';
import { RESOURCE_DEFS, type FieldDef, type FieldType } from './resources';
import { READ_TIME_FIELDS, COL_FILTER_MAX, COL_FILTER_OPS, colFilterKindFor, colFilterKindOf, datePresetRange, describeColFilter, parseColFilters, validateColFilters, type ColFilterOp } from './col-filter';

const f = (type: FieldType, key = 'k'): FieldDef => ({ key, label: '列', type, group: 'g' });
const ok = (fields: FieldDef[], raw: unknown, restricted?: Set<string>) => validateColFilters(raw, { fields, restricted });
const OPS = Object.keys({ contains: 1, eq: 1, neq: 1, startsWith: 1, gt: 1, lt: 1, between: 1, before: 1, after: 1, in: 1, yes: 1, no: 1, empty: 1, notEmpty: 1 }) as ColFilterOp[];
// 每种字段类型的合法示例值（用来验证允许的操作符都能通过校验，其余操作符都被拒）
const SAMPLE: Record<string, Record<string, unknown>> = {
  text: { value: '甲' }, phone: { value: '138' }, number: { value: '10' }, date: { value: '2026-05-01' }, monthday: { value: '05-01' },
  select: { values: ['a'] }, ref: { values: ['3'] },
};

describe('列筛选：操作符矩阵', () => {
  const matrix: Array<[FieldType, ColFilterOp[]]> = [
    ['text', ['contains', 'eq', 'neq', 'startsWith', 'empty', 'notEmpty']],
    ['textarea', ['contains', 'eq', 'neq', 'startsWith', 'empty', 'notEmpty']],
    ['phone', ['contains', 'eq', 'startsWith', 'empty', 'notEmpty']],
    ['number', ['eq', 'gt', 'lt', 'between', 'empty', 'notEmpty']],
    ['decimal', ['eq', 'gt', 'lt', 'between', 'empty', 'notEmpty']],
    ['money', ['eq', 'gt', 'lt', 'between', 'empty', 'notEmpty']],
    ['date', ['between', 'eq', 'before', 'after', 'empty', 'notEmpty']],
    ['select', ['in', 'empty', 'notEmpty']],
    ['bool', ['yes', 'no']],
    ['ref', ['in', 'empty', 'notEmpty']],
    ['refs', ['in', 'empty', 'notEmpty']],
    ['sensitive', ['notEmpty', 'empty']],
    ['secret', ['notEmpty', 'empty']],
    ['files', ['notEmpty', 'empty']],
  ];
  it.each(matrix)('%s 允许的操作符', (type, allowed) => {
    const kind = colFilterKindOf(type)!;
    expect([...COL_FILTER_OPS[kind]].sort()).toEqual([...allowed].sort());
  });
  it('清单和属性不提供列筛选', () => {
    expect(colFilterKindOf('json')).toBeNull();
    expect(colFilterKindOf('attrs')).toBeNull();
  });
  it('允许的操作符能通过校验，其余操作符都被拒绝', () => {
    for (const [type, allowed] of matrix) {
      const kind = colFilterKindOf(type)!;
      const base = type === 'bool' || kind === 'presence' ? {} : SAMPLE[kind] ?? {};
      for (const op of OPS) {
        const extra: Record<string, unknown> = op === 'between' ? { value: kind === 'date' ? '2026-05-01' : '1', value2: kind === 'date' ? '2026-05-31' : '9' } : op === 'empty' || op === 'notEmpty' || op === 'yes' || op === 'no' ? {} : base;
        const r = ok([f(type)], [{ key: 'k', op, ...extra }]);
        expect(r.ok, `${type}.${op}`).toBe(allowed.includes(op));
      }
    }
  });
  it('每个资料定义的每个字段都有明确归类（可筛选或明确不可筛选）', () => {
    const none = new Set<FieldType>(['json', 'attrs']);
    for (const d of RESOURCE_DEFS) for (const fd of d.fields) expect(colFilterKindOf(fd.type) === null, `${d.key}.${fd.key}`).toBe(none.has(fd.type));
  });
});

describe('列筛选：校验', () => {
  it('字段必须属于资料定义，没有权限的字段被拒绝，也不给筛选入口', () => {
    expect(ok([f('text')], [{ key: 'nope', op: 'contains', value: 'a' }]).ok).toBe(false);
    const r = ok([f('money', 'cost')], [{ key: 'cost', op: 'gt', value: '1' }], new Set(['cost']));
    expect(r).toMatchObject({ ok: false });
    expect(colFilterKindFor(f('money', 'cost'), new Set(['cost']))).toBeNull();
    expect(colFilterKindFor(f('money', 'cost'), new Set())).toBe('number');
  });
  it('值的类型、长度、格式', () => {
    const t = (field: FieldDef, c: Record<string, unknown>) => ok([field], [{ key: field.key, ...c }]).ok;
    expect(t(f('text'), { op: 'contains', value: '' })).toBe(false);
    expect(t(f('text'), { op: 'contains', value: 'x'.repeat(101) })).toBe(false);
    expect(t(f('text'), { op: 'contains', value: 5 })).toBe(false);
    expect(t(f('text'), { op: 'empty', value: 'x' })).toBe(false);
    expect(t(f('number'), { op: 'gt', value: 'abc' })).toBe(false);
    expect(t(f('number'), { op: 'between', value: '9', value2: '1' })).toBe(false);
    expect(t(f('number'), { op: 'between', value: '1', value2: '9' })).toBe(true);
    expect(t(f('date'), { op: 'before', value: '2026-02-30' })).toBe(false);
    expect(t(f('date'), { op: 'between', value: '2026-05-31', value2: '2026-05-01' })).toBe(false);
    expect(t(f('phone'), { op: 'contains', value: 'abc' })).toBe(false);
    expect(t(f('ref'), { op: 'in', values: ['abc'] })).toBe(false);
    expect(t(f('ref'), { op: 'in', values: ['0'] })).toBe(false);
    expect(t(f('select'), { op: 'in', values: [] })).toBe(false);
    expect(t(f('select'), { op: 'in', values: Array.from({ length: 51 }, (_, i) => String(i)) })).toBe(false);
    expect(t(f('select'), { op: 'in', values: ['a', 'b'] })).toBe(true);
  });
  it('多余属性、条件数上限、同一列条件数上限', () => {
    expect(ok([f('text')], [{ key: 'k', op: 'empty', companyId: 2 }]).ok).toBe(false);
    expect(ok([f('text')], 'x').ok).toBe(false);
    const many = Array.from({ length: COL_FILTER_MAX + 1 }, () => ({ key: 'k', op: 'empty' }));
    expect(ok([f('text')], many).ok).toBe(false);
    expect(ok([f('text')], Array.from({ length: 4 }, () => ({ key: 'k', op: 'empty' }))).ok).toBe(false);
    expect(ok([f('text')], Array.from({ length: 3 }, () => ({ key: 'k', op: 'empty' }))).ok).toBe(true);
  });
  it('状态列只能多选，且必须是资料定义的状态', () => {
    const c = (values: string[]) => validateColFilters([{ key: '$status', op: 'in', values }], { fields: [], statuses: ['active', 'off'] });
    expect(c(['active']).ok).toBe(true);
    expect(c(['zzz']).ok).toBe(false);
  });
  it('parseColFilters：空串=没有条件，坏 JSON 被拒', () => {
    expect(parseColFilters('', { fields: [] })).toEqual({ ok: true, filters: [] });
    expect(parseColFilters('{', { fields: [] }).ok).toBe(false);
    expect(parseColFilters('x'.repeat(7000), { fields: [] }).ok).toBe(false);
  });
  it('文本值去掉首尾空格', () => {
    const r = ok([f('text')], [{ key: 'k', op: 'contains', value: '  甲  ' }]);
    expect(r).toMatchObject({ ok: true, filters: [{ value: '甲' }] });
  });
});

describe('列筛选：读时才算出来的字段不支持', () => {
  it('手机号的绑定店铺等没有入口，传来也拒绝', () => {
    const computed = new Set(['boundStores']);
    expect(colFilterKindFor(f('text', 'boundStores'), new Set(), computed)).toBeNull();
    expect(validateColFilters([{ key: 'boundStores', op: 'contains', value: 'a' }], { fields: [f('text', 'boundStores')], computed })).toMatchObject({ ok: false });
    for (const [res, keys] of Object.entries(READ_TIME_FIELDS)) {
      const def = RESOURCE_DEFS.find((d) => d.key === res)!;
      for (const k of keys) expect(def.fields.some((x) => x.key === k), `${res}.${k}`).toBe(true);
    }
  });
});

describe('列筛选：日期快捷项与描述', () => {
  it('今天 / 近7天 / 本月 / 上月（含跨年）', () => {
    expect(datePresetRange('today', '2026-03-15')).toEqual({ from: '2026-03-15', to: '2026-03-15' });
    expect(datePresetRange('last7', '2026-03-15')).toEqual({ from: '2026-03-09', to: '2026-03-15' });
    expect(datePresetRange('thisMonth', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(datePresetRange('lastMonth', '2026-03-15')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(datePresetRange('lastMonth', '2026-01-05')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(datePresetRange('yesterday', '2026-03-01')).toEqual({ from: '2026-02-28', to: '2026-02-28' });
  });
  it('标签文字', () => {
    expect(describeColFilter({ key: 'k', op: 'between', value: '1', value2: '9' }, '金额')).toBe('金额：1 ~ 9');
    expect(describeColFilter({ key: 'k', op: 'empty' }, '备注')).toBe('备注 为空');
    expect(describeColFilter({ key: 'k', op: 'in', values: ['a', 'b'] }, '类型', (v) => v.toUpperCase())).toBe('类型：A、B');
  });
});
