import { storeJstText } from './StoreJstSelect';
import { unitYuanText, validUnitCents, LOGISTICS_CENT_SCALE, UNIT_CENT_SCALE, formatYuan, type FieldDef, type ResourceDef, type StatusDef } from '@kudesi/shared';
import type { ResourceDto } from './api';
import { unitOptionLabel } from './unitOptions';
import { categoryLabel } from './categoryOptions';

export function statusOf(def: ResourceDef, value: string): StatusDef {
  return def.statuses.find((s) => s.value === value) ?? { value, label: value, tone: 'muted' };
}

/** 展示值：选项显示中文，金额显示元，引用显示名称，密码类显示是否已设置。 */
export function displayValue(f: FieldDef, dto: ResourceDto): string {
  if (dto.type === 'stores' && f.key === 'jushuitanExpireAt' && !dto.data.jushuitanExpireAt) {
    if (dto.data.jushuitanExpiryStatus === 'permanent') return '永久授权';
    if (dto.data.jushuitanExpiryStatus === 'unknown') return '未返回有效到期时间';
  }
  if (dto.type === 'stores' && f.key === 'jushuitanShopId') return storeJstText(dto.data);
  if (f.type === 'secret') return dto.secretConfigured[f.key] ? '已设置' : '';
  const v = dto.data[f.key];
  // 未存储的开关与编辑器未勾选一致；尤其历史账号默认没有直播权限。
  if (f.type === 'bool') return v ? '是' : '否';
  if (v === undefined || v === null || v === '') return '';
  switch (f.type) {
    case 'select':
      { const c = categoryLabel(dto.type, f.key, v); if (c) return c; } // 页签分类：本公司名称（自建、改名、已隐藏）
      if (f.optionsFrom) { const n = unitOptionLabel(f, dto.data, String(v)); if (n) return n; }
      if (f.multi && Array.isArray(v)) return v.map(value => f.options?.find(o => o.value === value)?.label ?? String(value)).join('、');
      return f.options?.find((o) => o.value === v)?.label ?? String(v);
    case 'money':
      if(f.scale===LOGISTICS_CENT_SCALE&&!validUnitCents(v,LOGISTICS_CENT_SCALE))return '';
      return f.scale ? `¥${unitYuanText(Number(v),f.scale===LOGISTICS_CENT_SCALE?LOGISTICS_CENT_SCALE:UNIT_CENT_SCALE)}` : formatYuan(Number(v));
    case 'ref':
    case 'refs':
      return dto.refLabels[f.key] || (Array.isArray(v) ? v : [v]).filter(id => typeof id === 'number').map(id => `#${id}`).join('、');
    case 'json':
      return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    case 'attrs':
      return Object.entries(v as Record<string, string>).map(([k, x]) => `${k}：${x}`).join('；');
    case 'files':
      return Array.isArray(v) && v.length ? `${v.length} 个文件` : '';
    default:
      return String(v);
  }
}
