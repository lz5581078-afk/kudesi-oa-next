import { sumUnitCents } from '@kudesi/shared';
import type { ResourceDto } from './api';
const number = (value: unknown): number | null => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
/** 生产/OEM的完整采购事实与本档运装分开；缺项不能回退成原料价格。 */
export function currentProductPurchasePrice(source: Pick<ResourceDto, 'data'>): number | null {
  const d = source.data;
  if (d.supplyMode !== 'supplier_oem' && d.archiveType !== 'self_made') return number(d.purchasePrice);
  const total = number(d.totalCost), freight = number(d.freight), handling = number(d.handlingFee);
  if (total === null || freight === null || handling === null) return null;
  const price = sumUnitCents([total, -freight, -handling]);
  return price < 0 ? null : price;
}
