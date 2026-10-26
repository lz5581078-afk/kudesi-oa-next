import { formatYuan, type FieldDef, type ResourceDef, type StatusDef } from '@kudesi/shared';
import type { ResourceDto } from './api';

export function statusOf(def: ResourceDef, value: string): StatusDef {
  return def.statuses.find((s) => s.value === value) ?? { value, label: value, tone: 'muted' };
}

/** 展示值：选项显示中文，金额显示元，引用显示名称，密码类显示是否已设置。 */
export function displayValue(f: FieldDef, dto: ResourceDto): string {
  if (f.type === 'secret') return dto.secretConfigured[f.key] ? '已设置' : '';
  const v = dto.data[f.key];
  if (v === undefined || v === null || v === '') return '';
  switch (f.type) {
    case 'select':
      return f.options?.find((o) => o.value === v)?.label ?? String(v);
    case 'money':
      return formatYuan(Number(v));
    case 'bool':
      return v ? '是' : '否';
    case 'ref':
    case 'refs':
      return dto.refLabels[f.key] ?? '';
    case 'attrs':
      return Object.entries(v as Record<string, string>).map(([k, x]) => `${k}：${x}`).join('；');
    case 'files':
      return Array.isArray(v) && v.length ? `${v.length} 个文件` : '';
    default:
      return String(v);
  }
}
