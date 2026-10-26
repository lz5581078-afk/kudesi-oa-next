/** 资料定义用的小工具：字段构造函数和常用状态。只依赖类型，避免与 resources.ts 循环引用。 */
import type { FieldDef, Option, StatusDef } from './resources';

export const o = (...pairs: string[]): Option[] =>
  pairs.map((p) => {
    const [value, label] = p.split(':');
    return { value, label };
  });

export const NORMAL: StatusDef = { value: 'normal', label: '正常', tone: 'ok' };
export const ABNORMAL: StatusDef = { value: 'abnormal', label: '异常', tone: 'warn' };
export const INACTIVE: StatusDef = { value: 'inactive', label: '停用', tone: 'muted', requiresReason: true, hidden: true };
export const CANCELLED: StatusDef = { value: 'cancelled', label: '注销', tone: 'bad', requiresReason: true, hidden: true };

export const text = (key: string, label: string, group: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  key, label, group, type: 'text', maxLength: 200, ...extra,
});
export const textarea = (key: string, label: string, group: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  key, label, group, type: 'textarea', maxLength: 2000, ...extra,
});
export const select = (key: string, label: string, group: string, options: Option[], extra: Partial<FieldDef> = {}): FieldDef => ({
  key, label, group, type: 'select', options, ...extra,
});
export const date = (key: string, label: string, group: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  key, label, group, type: 'date', ...extra,
});
export const money = (key: string, label: string, group: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  key, label, group, type: 'money', ...extra,
});
export const ref = (key: string, label: string, group: string, target: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  key, label, group, type: 'ref', ref: target, ...extra,
});
export const refs = (key: string, label: string, group: string, target: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  key, label, group, type: 'refs', ref: target, ...extra,
});
export const files = (key: string, label: string, group: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  key, label, group, type: 'files', ...extra,
});
export const secret = (key: string, label: string, group: string): FieldDef => ({ key, label, group, type: 'secret', maxLength: 200 });
export const sensitive = (key: string, label: string, group: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  key, label, group, type: 'sensitive', maxLength: 64, ...extra,
});
export const NOTE = (group = '备注'): FieldDef => textarea('note', '备注', group);


export const attrs = (key: string, label: string, group: string, attrsFrom: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, group, type: 'attrs', attrsFrom, ...extra });
