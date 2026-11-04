import { EntityManager } from 'typeorm';
import { sumUnitCents, LOGISTICS_CENT_SCALE } from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import type { RuleHost } from './resource-rules';
import { withReadonlyAppend } from './append-only';
import { asAdmin } from './product-costs';

type PriceSnapshot = { purchasePrice: number; rawMaterialPurchasePrice?: number; packagingCost?: number; systemSpec: string; priceBasis: string };
type Context = { batch: boolean; baselines: Map<number, PriceSnapshot | null>; pending: Set<number>; recorded: Map<number, number> };
const contexts = new WeakMap<EntityManager, Context>();
const context = (em: EntityManager): Context => { let value = contexts.get(em); if (!value) { value = { batch: false, baselines: new Map(), pending: new Set(), recorded: new Map() }; contexts.set(em, value); } return value; };
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** 当前完整采购事实；OEM/自产从可信总成本扣除本档运装，绝不把缺失值当零。 */
export function purchasePriceSnapshot(product: Pick<ResourceRecord, 'data'>): PriceSnapshot | null {
  const d = product.data;
  if (!['raw', 'shipping_material', 'purchased', 'package', 'oem_package', 'self_made'].includes(String(d.archiveType))) return null;
  const derived = d.archiveType === 'self_made' || d.supplyMode === 'supplier_oem';
  let price = num(d.purchasePrice);
  if (derived) {
    const total = num(d.totalCost), freight = num(d.freight), handling = num(d.handlingFee);
    if (total === null || freight === null || handling === null) return null;
    price = sumUnitCents([total, -freight, -handling],LOGISTICS_CENT_SCALE);
  }
  if (price === null || price < 0) return null;
  const raw = d.supplyMode === 'supplier_oem' ? num(d.purchasePrice) : null;
  const packaging = raw === null ? null : sumUnitCents([price, -raw],LOGISTICS_CENT_SCALE);
  return {
    purchasePrice: price, systemSpec: String(d.purchaseSpec || ''),
    priceBasis: d.supplyMode === 'supplier_oem' ? 'oem_total' : derived ? 'production_total' : 'direct',
    ...(raw !== null && packaging !== null && packaging >= 0 ? { rawMaterialPurchasePrice: raw, packagingCost: packaging } : {}),
  };
}
export function rememberPurchaseBaseline(em: EntityManager, product: ResourceRecord | null) {
  if (product && !context(em).baselines.has(product.id)) context(em).baselines.set(product.id, purchasePriceSnapshot(product));
}
export function beginPurchaseHistoryBatch(em: EntityManager, existing: ResourceRecord | null) {
  context(em).batch = true; rememberPurchaseBaseline(em, existing);
}
export async function recordPurchaseHistory(host: RuleHost, em: EntityManager, user: AuthUser, product: ResourceRecord, previous: ResourceRecord | null) {
  if (em.queryRunner?.data.legacyImport || product.companyId !== user.companyId) return;
  const ctx = context(em);
  if (!ctx.baselines.has(product.id)) ctx.baselines.set(product.id, previous ? purchasePriceSnapshot(previous) : null);
  ctx.pending.add(product.id);
  if (ctx.batch) return;
  await appendPurchaseFact(host, em, user, product, ctx);
}
async function appendPurchaseFact(host: RuleHost, em: EntityManager, user: AuthUser, product: ResourceRecord, ctx: Context) {
  const next = purchasePriceSnapshot(product), before = ctx.baselines.get(product.id);
  if (!next || before?.purchasePrice === next.purchasePrice || ctx.recorded.get(product.id) === next.purchasePrice) return;
  const rows = await host.findWhere(em, user.companyId, 'finance-product-purchase-history', 'productId', product.id);
  const last = rows.sort((a, b) => String(b.data.recordedAtKey || '').localeCompare(String(a.data.recordedAtKey || '')) || b.id - a.id)[0];
  if (last?.data.purchasePrice === next.purchasePrice) return;
  await withReadonlyAppend(em, user.companyId, 'finance-product-purchase-history', () => host.createRecord(em, asAdmin(user), 'finance-product-purchase-history', {
    productId: product.id, label: (product.title + ' · 采购价记录').slice(0, 200), ...next, recordedAtKey: new Date().toISOString(), operatorName: user.name,
  }, '采购价实际变化，追加独立采购历史'));
  ctx.recorded.set(product.id, next.purchasePrice);
}
export async function flushPurchaseHistory(host: RuleHost, em: EntityManager, user: AuthUser) {
  const ctx = context(em); ctx.batch = false;
  for (const id of ctx.pending) {
    const product = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type: 'finance-products' } });
    if (product) await appendPurchaseFact(host, em, user, product, ctx);
  }
  ctx.pending.clear();
}
