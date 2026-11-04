import { sourcePriceTime } from '@kudesi/shared';
import { EntityManager } from 'typeorm';
import { ResourceRecord } from '../entities';

type Product = Pick<ResourceRecord, 'id' | 'companyId' | 'type' | 'data'>;
interface SourceRow {
  id: number; status: string; updatedAt: Date | string;
  productId: unknown; supplierId: unknown; originArea: unknown;
  priceUpdatedAt: unknown; legacySourceId: unknown;
}
const idOf = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function newestFirst(left: SourceRow, right: SourceRow): number {
  const time = sourcePriceTime(right.priceUpdatedAt, right.updatedAt) - sourcePriceTime(left.priceUpdatedAt, left.updatedAt);
  if (time) return time;
  if (left.legacySourceId && right.legacySourceId) {
    try { return Number(BigInt(String(right.legacySourceId)) - BigInt(String(left.legacySourceId))); }
    catch { /* Malformed legacy metadata cannot identify another supplier or stop a list read. */ }
  }
  return right.id - left.id;
}

/** Read only the current page's source/category facts; prices and historical JSON never leave the database. */
export async function deriveProductReferenceList(em: EntityManager, companyId: number, records: readonly Product[]): Promise<Map<number, Record<string, unknown>>> {
  const products = records.filter(record => record.companyId === companyId && record.type === 'finance-products' && idOf(record.id) !== null);
  const result = new Map<number, Record<string, unknown>>(products.map(product => [product.id, { __sourceCount: 0, __sourceOrigin: '', __sourceSupplier: '', __categoryCode: '' }]));
  if (!result.size) return result;
  const sources = await em.createQueryBuilder(ResourceRecord, 'source')
    .select('source.id', 'id').addSelect('source.status', 'status').addSelect('source.updatedAt', 'updatedAt')
    .addSelect("JSON_EXTRACT(source.data,'$.productId')", 'productId')
    .addSelect("JSON_EXTRACT(source.data,'$.supplierId')", 'supplierId')
    .addSelect("JSON_EXTRACT(source.data,'$.originArea')", 'originArea')
    .addSelect("JSON_EXTRACT(source.data,'$.priceUpdatedAt')", 'priceUpdatedAt')
    .addSelect("JSON_EXTRACT(source.data,'$.legacySourceId')", 'legacySourceId')
    .where('source.companyId = :companyId AND source.type = :type AND source.archivedAt IS NULL AND source.status <> :deleted', { companyId, type: 'finance-product-sources', deleted: 'deleted' })
    .andWhere("JSON_EXTRACT(source.data,'$.productId') IN (:...productIds)", { productIds: [...result.keys()] })
    .orderBy('source.id', 'ASC').getRawMany<SourceRow>();
  const latest = new Map<number, SourceRow>();
  for (const source of sources.sort(newestFirst)) {
    const productId = idOf(source.productId), derived = productId === null ? undefined : result.get(productId);
    if (!derived || productId === null) continue;
    derived.__sourceCount = Number(derived.__sourceCount) + 1;
    if (source.status === 'active' && !latest.has(productId)) { latest.set(productId, source); derived.__sourceOrigin = text(source.originArea); }
  }
  const supplierIds = new Set([...latest.values()].map(source => idOf(source.supplierId)).filter((id): id is number => id !== null));
  const categoryIds = new Set(products.map(product => idOf(product.data.categoryId)).filter((id): id is number => id !== null));
  const ids = [...new Set([...supplierIds, ...categoryIds])];
  if (!ids.length) return result;
  const references = await em.createQueryBuilder(ResourceRecord, 'reference')
    .select('reference.id', 'id').addSelect('reference.type', 'type').addSelect('reference.title', 'title')
    .addSelect("JSON_EXTRACT(reference.data,'$.categoryCode')", 'categoryCode')
    .where('reference.companyId = :companyId AND reference.id IN (:...ids) AND reference.type IN (:...types) AND reference.archivedAt IS NULL AND reference.status <> :deleted', { companyId, ids, types: ['finance-suppliers', 'finance-categories'], deleted: 'deleted' })
    .getRawMany<{ id: number; type: string; title: string; categoryCode: unknown }>();
  const suppliers = new Map(references.filter(row => row.type === 'finance-suppliers' && supplierIds.has(row.id)).map(row => [row.id, row.title]));
  const categories = new Map(references.filter(row => row.type === 'finance-categories' && categoryIds.has(row.id)).map(row => [row.id, text(row.categoryCode)]));
  for (const product of products) {
    const derived = result.get(product.id)!;
    derived.__sourceSupplier = suppliers.get(idOf(latest.get(product.id)?.supplierId) ?? -1) ?? '';
    derived.__categoryCode = categories.get(idOf(product.data.categoryId) ?? -1) ?? '';
  }
  return result;
}
