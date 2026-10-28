import { describe, expect, it } from 'vitest';
import { RESOURCE_DEFS, getResourceDef, type FieldDef, type FieldType } from './resources';
import { formatGridCell, gridFieldAccess, gridPolicyOf, gridStatusAccess, normalizeDateText, parseAttrsText, parseGridCell } from './grid-edit';

const f = (over: Partial<FieldDef>): FieldDef => ({ key: 'k', label: '字段', type: 'text', group: 'g', ...over });
const all = () => true;

describe('表格编辑：可编辑性', () => {
  it('只有系统计算和没有字段权限的才只读；文件、属性、清单、多引用、多行文本都可以改', () => {
    expect(gridFieldAccess(f({ readonly: true }), all, true).editable).toBe(false);
    const kinds: Record<string, string> = { files: 'files', attrs: 'attrs', json: 'json', refs: 'refs', textarea: 'textarea', date: 'date' };
    for (const [t, k] of Object.entries(kinds)) expect(gridFieldAccess(f({ type: t as FieldType }), all, true)).toEqual({ editable: true, kind: k });
    expect(gridFieldAccess(f({ type: 'money', permission: 'product.cost.view' }), () => false, true).editable).toBe(false);
    expect(gridFieldAccess(f({ type: 'money', writePermission: 'x' }), (p) => p !== 'x', true).editable).toBe(false);
    expect(gridFieldAccess(f({ type: 'money' }), all, false)).toEqual({ editable: true, kind: 'money' });
  });
  it('证件号/密钥只有“查看明文”权限者可改', () => {
    expect(gridFieldAccess(f({ type: 'sensitive' }), all, false).editable).toBe(false);
    expect(gridFieldAccess(f({ type: 'secret' }), all, false).editable).toBe(false);
    expect(gridFieldAccess(f({ type: 'sensitive' }), all, true).editable).toBe(true);
  });
  it('矩阵：所有资料的所有字段——详情表单里能改的（非 readonly、有权限），表格里都能改；每种字段类型都有编辑器', () => {
    const types = new Set<string>();
    let editable = 0, readonly = 0;
    for (const d of RESOURCE_DEFS) {
      for (const fd of d.fields) {
        types.add(fd.type);
        const a = gridFieldAccess(fd, all, true);
        if (fd.readonly) { expect(a.editable, `${d.key}.${fd.key}`).toBe(false); readonly++; }
        else { expect(a.editable, `${d.key}.${fd.key}`).toBe(true); editable++; }
      }
    }
    // 配置里出现过的每种类型都至少被覆盖到
    expect([...types].sort()).toEqual(expect.arrayContaining(['text', 'textarea', 'files', 'refs', 'attrs', 'money', 'date', 'select', 'secret', 'sensitive']));
    expect(editable).toBeGreaterThan(readonly);
  });
  it('状态列：要有“停用”权限，只有一个状态的资料没有可改的', () => {
    expect(gridStatusAccess(getResourceDef('stores')!, true).editable).toBe(true);
    expect(gridStatusAccess(getResourceDef('stores')!, false)).toMatchObject({ editable: false });
    expect(gridStatusAccess({ ...getResourceDef('stores')!, statuses: [getResourceDef('stores')!.statuses[0]] }, true).editable).toBe(false);
  });
  it('不适合网格的资料（全是系统生成字段，或走专属接口）被禁用；专属品等只剩状态可改的资料可进入', () => {
    expect(gridPolicyOf('finance-bundles').enabled).toBe(false);
    expect(gridPolicyOf('finance-product-exclusives').enabled).toBe(true);
    expect(gridPolicyOf('finance-product-boms').enabled).toBe(true);
    expect(gridPolicyOf('finance-express-fee-batches').enabled).toBe(true);
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
  it('多行文本保留换行；属性接受“名称：内容；…”或 JSON；清单必须是合法 JSON 对象/数组', () => {
    expect(parseGridCell(f({ type: 'textarea', maxLength: 50 }), 'textarea', '第一行\n第二行 ')).toEqual({ ok: true, value: '第一行\n第二行' });
    expect(parseGridCell(f({ type: 'textarea' }), 'textarea', 'x'.repeat(201)).ok).toBe(false);
    expect(parseGridCell(f({ type: 'attrs' }), 'attrs', '颜色：黑；尺寸：大')).toEqual({ ok: true, value: { 颜色: '黑', 尺寸: '大' } });
    expect(parseGridCell(f({ type: 'attrs' }), 'attrs', '{"颜色":"黑","空":""}')).toEqual({ ok: true, value: { 颜色: '黑' } });
    expect(parseGridCell(f({ type: 'attrs' }), 'attrs', '没有冒号').ok).toBe(false);
    expect(parseAttrsText('a:1\nb：2')).toEqual({ a: '1', b: '2' });
    expect(parseGridCell(f({ type: 'attrs' }), 'attrs', Array.from({ length: 31 }, (_, i) => `k${i}：v`).join('；')).ok).toBe(false);
    expect(parseGridCell(f({ type: 'json' }), 'json', '[{"a":1}]')).toEqual({ ok: true, value: [{ a: 1 }] });
    expect(parseGridCell(f({ type: 'json' }), 'json', '123').ok).toBe(false);
    expect(parseGridCell(f({ type: 'json' }), 'json', '{坏').ok).toBe(false);
    expect(parseGridCell(f({ type: 'files' }), 'files', 'a.png').ok).toBe(false); // 文件、多引用不能靠打字
    expect(parseGridCell(f({ type: 'refs' }), 'refs', '甲').ok).toBe(false);
  });
  it('格式化与解析互逆', () => {
    expect(formatGridCell(f({ type: 'attrs' }), 'attrs', { 颜色: '黑', 尺寸: '大' })).toBe('颜色：黑；尺寸：大');
    expect(formatGridCell(f({ type: 'files' }), 'files', [1, 2])).toBe('2 个文件');
    expect(formatGridCell(f({ type: 'json' }), 'json', [{ a: 1 }])).toBe('[{"a":1}]');
    expect(formatGridCell(f({ type: 'money' }), 'money', 1234)).toBe('12.34');
    expect(formatGridCell(f({ type: 'money', scale: 4 }), 'money', 12.3456)).toBe('0.123456');
    expect(formatGridCell(f({}), 'bool', true)).toBe('是');
  });
});
