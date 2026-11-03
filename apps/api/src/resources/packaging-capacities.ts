import { productCapacity, UNIT_OPTIONS } from '@kudesi/shared';
import type { UnitLists } from './unit-options';

/** 解析既有容量文本；名称、现行编码及历史编码都可识别，是否可新选由保存规则判断。 */
export function capacityUnitCode(units: UnitLists, value: string): string | undefined {
  const text = value.trim();
  const items = units.get('spec_unit') ?? [];
  const matches = (item: { code: string; name: string }) => item.code.toUpperCase() === text.toUpperCase() || item.name === text;
  const maintained = items.find(item => item.active && matches(item)) ?? items.find(matches);
  return maintained?.code || UNIT_OPTIONS.find(item => item.value.toUpperCase() === text.toUpperCase() || item.label === text)?.value;
}
export function packagingCapacities(value: unknown, units: UnitLists) {
  return String(value ?? '').split(/\r?\n/).filter(line => line.trim()).map(line => {
    const parsed = productCapacity(line);
    return { ...parsed, code: capacityUnitCode(units, parsed.unit) };
  });
}
/** 容量编码按旧版数字文字规则规范化：去前导/末尾0，小数点用D。 */
export function capacityQuantityCode(text: string): string {
  const numericText = text.replace(/[^\d.]/g, '');
  const value = Number(numericText);
  return numericText && Number.isFinite(value) ? String(value).replace('.', 'D') : '';
}
