import { BadRequestException } from '@nestjs/common';
import { LOGISTICS_CENT_SCALE, sumUnitCents, validUnitCents } from '@kudesi/shared';
import { EntityManager } from 'typeorm';
import { ResourceRecord } from '../entities';
import { deriveProductReferenceList } from './product-reference-list';

export const PRODUCT_REFERENCE_SORT_KEYS = ['__sourceCount', '__sourceSupplier', '__sourceOrigin', '__categoryCode', '__freightHandling'] as const;
export type ProductReferenceSortKey = typeof PRODUCT_REFERENCE_SORT_KEYS[number];
type Product = Pick<ResourceRecord, 'id' | 'type' | 'companyId' | 'data'>;
type Direction = 'asc' | 'desc';
export function isProductReferenceSortKey(value: unknown): value is ProductReferenceSortKey {
  return typeof value === 'string' && (PRODUCT_REFERENCE_SORT_KEYS as readonly string[]).includes(value);
}
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
const text = (value: unknown): string => typeof value === 'string' ? value : '';

/** These are rendered Table values, including currency/count suffixes and empty placeholders. */
function comparable(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const label = String(value).replace(/\s+/g, ' ').trim();
  if (!label || label === '-') return null;
  const numeric = label.replace(/[,¥￥$]/g, '').replace(/\s*(?:kg|g|%|元|条|个|次|项|家|天) *$/i, '').trim();
  if (/^-?\d+(?:\.\d+)?$/.test(numeric)) return Number(numeric);
  if (/^\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/.test(label)) {
    const time = Date.parse(label.replace(' ', 'T'));
    if (Number.isFinite(time)) return time;
  }
  return label;
}
function compare(left: unknown, right: unknown, direction: Direction): number {
  const a = comparable(left), b = comparable(right);
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const difference = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
  return direction === 'desc' ? -difference : difference;
}
function amount(value: unknown): number | null {
  return validUnitCents(value,LOGISTICS_CENT_SCALE) ? value : null;
}
function logisticsText(data: Record<string, unknown>): string | null {
  const freight = amount(data.freight), handling = amount(data.handlingFee);
  if (freight === null || handling === null || !freight && !handling) return null;
  let combined:number;try{combined=sumUnitCents([freight,handling],LOGISTICS_CENT_SCALE);}catch{return null;}
  // The source displays at least three decimals, retaining additional precision up to eight.
  const money = (combined / 100).toFixed(8).replace(/(\.\d{3}.*?)0+$/, '$1');
  const specification = text(data.freightSystemSpecification) || text(data.freightSystemSpec) || text(data.systemSpecification) || text(data.systemSpec)
    || text(data.purchaseSpecification) || text(data.purchaseSpec) || [data.specQty ?? data.amount, data.specUnit ?? data.unit].filter(Boolean).join(' ') || '当前规格';
  return `¥${money} / ${specification}`;
}

/** Pure full-candidate ordering. Stable ties retain the supplied canonical query order, not ID order. */
export function orderProductReferenceIds(records: readonly Product[], derived: ReadonlyMap<number, Record<string, unknown>>, key: ProductReferenceSortKey, direction: Direction): number[] {
  if (!isProductReferenceSortKey(key) || !['asc', 'desc'].includes(direction)) throw new BadRequestException('商品列表排序字段或方向无效');
  return records.map((record, index) => ({ id: record.id, index, value: key === '__freightHandling' ? logisticsText(record.data) : derived.get(record.id)?.[key] }))
    .sort((left, right) => compare(left.value, right.value, direction) || left.index - right.index).map(row => row.id);
}

/** Caller must supply all matched products before pagination and enforce visibility/cost permissions first. */
export async function deriveProductReferenceSortIds(em: EntityManager, companyId: number, records: readonly Product[], key: ProductReferenceSortKey, direction: Direction): Promise<number[]> {
  if (!isProductReferenceSortKey(key) || !['asc', 'desc'].includes(direction)) throw new BadRequestException('商品列表排序字段或方向无效');
  const seen = new Set<number>();
  const products = records.filter(record => {
    if (record.companyId !== companyId || record.type !== 'finance-products' || !Number.isSafeInteger(record.id) || record.id <= 0 || seen.has(record.id)) return false;
    seen.add(record.id); return true;
  });
  const values = key === '__freightHandling' ? new Map<number, Record<string, unknown>>() : await deriveProductReferenceList(em, companyId, products);
  return orderProductReferenceIds(products, values, key, direction);
}
