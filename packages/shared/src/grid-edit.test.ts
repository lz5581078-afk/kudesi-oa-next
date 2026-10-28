import { describe, expect, it } from 'vitest';
import { getResourceDef, type FieldDef } from './resources';
import { formatGridCell, gridFieldAccess, gridPolicyOf, normalizeDateText, parseGridCell } from './grid-edit';

const f = (over: Partial<FieldDef>): FieldDef => ({ key: 'k', label: '字段', type: 'text', group: 'g', ...over });
const all = () => true;

describe('表格编辑：可编辑性', () => {
  it('系统计算、文件、清单、多选引用只读；无字段权限只读', () => {
    expect(gridFieldAccess(f({ readonly: true }), all, true).editable).toBe(false);
    for (const t of ['files', 'attrs', 'json', 'refs'] as const) expect(gridFieldAccess(f({ type: t }), all, true).editable).toBe(false);
    expect(gridFieldAccess(f({ type: 'money', permission: 'product.cost.view' }), () => false, true).editable).toBe(false);
    expect(gridFieldAccess(f({ type: 'money', writePermission: 'x' }), (p) => p !== 'x', true).editable).toBe(false);
    expect(gridFieldAccess(f({ type: 'money' }), all, false)).toEqual({ editable: true, kind: 'money' });
  });
  it('证件号/密钥只有“查看明文”权限者可改', () => {
    expect(gridFieldAccess(f({ type: 'sensitive' }), all, false).editable).toBe(false);
    expect(gridFieldAccess(f({ type: 'secret' }), all, false).editable).toBe(false);
    expect(gridFieldAccess(f({ type: 'sensitive' }), all, true).editable).toBe(true);
  });
  it('不适合网格的资料被禁用，商品档案不能网格新增', () => {
    expect(gridPolicyOf('finance-bundles').enabled).toBe(false);
    expect(gridPolicyOf('finance-products')).toMatchObject({ enabled: true, canCreate: false });
    expect(gridPolicyOf('stores')).toMatchObject({ enabled: true, canCreate: true, canArchive: true });
    for (const k of ['finance-bundles', 'finance-products']) expect(getResourceDef(k)).toBeTruthy();
  });
});

describe('表格编辑：单元格解析', () => {
  it('金额按元转整数分，走定点运算', () => {
    expect(parseGridCell(f({ type: 'money' }), 'money', '12.34')).toEqual({ ok: true, value: 1234 });
    expect(parseGridCell(f({ type: 'money' }), 'money', '¥1,000')).toEqual({ ok: true, value: 100000 });
    expect(parseGridCell(f({ type: 'money' }), 'money', '19.99')).toEqual({ ok: true, value: 1999 });
    expect(parseGridCell(f({ type: 'money' }), 'money', '1.005').ok).toBe(false);
    expect(parseGridCell(f({ type: 'money', scale: 4 }), 'money', '0.123456')).toEqual({ ok: true, value: 12.3456 });
    expect(parseGridCell(f({ type: 'money', scale: 4 }), 'money', '0.1234567').ok).toBe(false);
    expect(parseGridCell(f({ type: 'money' }), 'money', '-3').ok).toBe(false);
  });
  it('数字、日期、月日、手机、布尔、选项', () => {
    expect(parseGridCell(f({}), 'integer', '12')).toEqual({ ok: true, value: 12 });
    expect(parseGridCell(f({}), 'integer', '1.5').ok).toBe(false);
    expect(parseGridCell(f({ scale: 2 }), 'decimal', '1.25')).toEqual({ ok: true, value: 1.25 });
    expect(parseGridCell(f({ scale: 2 }), 'decimal', '1.255').ok).toBe(false);
    expect(normalizeDateText('2024/3/5')).toBe('2024-03-05');
    expect(normalizeDateText('2024年3月5日')).toBe('2024-03-05');
    expect(normalizeDateText('2024-02-30')).toBeNull();
    expect(parseGridCell(f({}), 'monthday', '3-5')).toEqual({ ok: true, value: '03-05' });
    expect(parseGridCell(f({}), 'phone', '+86 138-0013-8000')).toEqual({ ok: true, value: '13800138000' });
    expect(parseGridCell(f({}), 'bool', '是')).toEqual({ ok: true, value: true });
    expect(parseGridCell(f({}), 'bool', '也许').ok).toBe(false);
    const sel = f({ type: 'select', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }] });
    expect(parseGridCell(sel, 'select', '甲')).toEqual({ ok: true, value: 'a' });
    expect(parseGridCell(sel, 'select', 'b')).toEqual({ ok: true, value: 'b' });
    expect(parseGridCell(sel, 'select', '丙').ok).toBe(false);
    expect(parseGridCell({ ...sel, multi: true }, 'select', '乙、甲')).toEqual({ ok: true, value: 'a、b' });
    expect(parseGridCell(f({}), 'text', '  ')).toEqual({ ok: true, value: null });
    expect(parseGridCell(f({ maxLength: 3 }), 'text', '四个字啊').ok).toBe(false);
  });
  it('格式化与解析互逆', () => {
    expect(formatGridCell(f({ type: 'money' }), 'money', 1234)).toBe('12.34');
    expect(formatGridCell(f({ type: 'money', scale: 4 }), 'money', 12.3456)).toBe('0.123456');
    expect(formatGridCell(f({}), 'bool', true)).toBe('是');
  });
});
