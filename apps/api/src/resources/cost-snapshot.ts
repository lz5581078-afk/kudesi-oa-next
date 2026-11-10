import { isDeepStrictEqual } from 'node:util';
import { completeCost } from './cost-registration';
import { DataSource, EntityManager } from 'typeorm';
import { FinanceCostSnapshot, ResourceRecord } from '../entities';
import { In } from 'typeorm';
import { COST_TABLE_STATUSES, CostService } from './cost.service';

/** 成本历史的事件类型（旧系统 bundle-cost-history 的事件）：验证发布 / 维护售价 / 来源值变化 / 手动登记 */
export type CostEvent = 'workflow_publish' | 'pricing_update' | 'source_values_update' | 'manual';
export const COST_EVENT_LABEL: Record<CostEvent, string> = { workflow_publish: '验证更新成本', pricing_update: '售价调整', source_values_update: '商品资料联动', manual: '手动登记' };

export async function registerCostSnapshots(
  em: EntityManager, companyId: number, actorId: number | null, bundleIds: number[], reason: string, eventType: CostEvent,
): Promise<{ recorded: number; unchanged: number; missing: number; invalid: number }> {
  let recorded = 0, unchanged = 0, missing = 0, invalid = 0;
  if (!bundleIds.length || batches.get(em)?.companyId === companyId) return { recorded, unchanged, missing, invalid };
  if (em.queryRunner?.isTransactionActive) await em.find(ResourceRecord, { where: { companyId, type: 'finance-bundles', id: In([...new Set(bundleIds)]) }, order: { id: 'ASC' }, lock: { mode: 'pessimistic_write' } });
  const cost = new CostService(em.connection as DataSource);
  const d = await cost.load(companyId, em);
  const byId = new Map(d.bundles.map((b) => [b.id, b]));
  const ids = [...new Set(bundleIds)];
  const raw = new Map(ids.filter(id => byId.has(id)).map(id => [id, cost.row(d, byId.get(id)!)]));
  for (const id of ids) {
    const b = byId.get(id);
    if (!b) { missing++; continue; }
    const row = raw.get(id)!;
    if (!completeCost(row)) { invalid++; continue; }
    const last = await em.findOne(FinanceCostSnapshot, { where: { companyId, bundleId: id }, order: { id: 'DESC' }, ...(em.queryRunner?.isTransactionActive ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    const context = { productCostCents: row.preShipCostCents, categoryId: row.categoryId, carrierName: row.carrierName, explicitMarginPercent: row.marginOverride ? row.marginPercent : null, calculation: { lines: row.lines, breakdown: row.breakdown, freightMethod: row.freightMethod, marginSource: row.marginSource } };
    const same = last && last.code === row.code && last.name === row.name && last.context?.productCostCents === context.productCostCents && last.context?.categoryId === context.categoryId && last.context?.carrierName === context.carrierName && last.context?.explicitMarginPercent === context.explicitMarginPercent && last.preShipCostCents === row.preShipCostCents && last.weightG === row.weightG && last.freightCents === row.freightCents
      && last.minPriceCents === row.minPriceCents && last.marginPercent === row.marginPercent;
    if (same && isDeepStrictEqual(last.context?.calculation?.lines, JSON.parse(JSON.stringify(row.lines))) && last.context?.calculation?.freightMethod === row.freightMethod && last.context?.calculation?.marginSource === row.marginSource) { unchanged++; continue; }
    await em.insert(FinanceCostSnapshot, {
      companyId, bundleId: id, code: row.code, name: row.name, revision: (last?.revision ?? 0) + 1,
      preShipCostCents: row.preShipCostCents, weightG: row.weightG, freightCents: row.freightCents, marginPercent: row.marginPercent, minPriceCents: row.minPriceCents,
      context, reason: reason.slice(0, 200), eventType, actorId,
    });
    recorded++;
  }
  return { recorded, unchanged, missing, invalid };
}

/** 来源（基础编码、人工）变了：在成本表范围内的组合登记一版“来源值变化” */
export async function recordSourceChange(em: EntityManager, companyId: number, actorId: number | null, bundleIds: number[], reason: string): Promise<void> {
  if (!bundleIds.length) return;
  const rows: Array<{ id: number }> = await em.query(
    `SELECT id FROM resource_records WHERE company_id = ? AND type = 'finance-bundles' AND status IN (${COST_TABLE_STATUSES.map(() => '?').join(',')}) AND id IN (${bundleIds.map(() => '?').join(',')})`,
    [companyId, ...COST_TABLE_STATUSES, ...bundleIds]);
  await registerCostSnapshots(em, companyId, actorId, rows.map((r) => r.id), reason, 'source_values_update');
}

const COST_SOURCES = new Set(['finance-products', 'finance-product-sources', 'finance-product-units', 'finance-product-costs', 'finance-product-freight-history', 'finance-product-boms',
  'finance-base-codes', 'finance-base-code-lines', 'finance-bundles', 'finance-bundle-lines', 'finance-labor-costs', 'finance-labor-units',
  'finance-margins', 'finance-categories', 'finance-code-dictionaries', 'finance-freight-estimates',
  'finance-express-carriers', 'finance-express-branches', 'finance-express-versions', 'finance-express-prices']);

export async function preserveSourceCosts(em: EntityManager, companyId: number, actorId: number, type: string, target?: { id?: number; data?: Record<string, unknown> }): Promise<void> {
  if (!COST_SOURCES.has(type) || batches.get(em)?.companyId === companyId || em.queryRunner?.data.legacyImport) return;
  const id = type === 'finance-bundles' && target ? target.id : type === 'finance-bundle-lines' && target ? Number(target.data?.bundleId) : undefined;
  if (target && ['finance-bundles', 'finance-bundle-lines'].includes(type) && !id) return;
  const bundles = await em.find(ResourceRecord, { where: { companyId, type: 'finance-bundles', status: In(COST_TABLE_STATUSES), ...(id ? { id } : {}) }, select: { id: true } });
  await registerCostSnapshots(em, companyId, actorId, bundles.map(row => row.id), '成本来源更新', 'source_values_update');
}

const batches = new WeakMap<EntityManager, { companyId: number; depth: number; type: string; target?: { id?: number; data?: Record<string, unknown> } }>();
export async function beginCostBatch(em: EntityManager, companyId: number, actorId: number, type: string, target?: { id?: number; data?: Record<string, unknown> }) {
  if (!COST_SOURCES.has(type)) return;
  const batch = batches.get(em);
  if (batch) { batch.depth++; return; }
  await preserveSourceCosts(em, companyId, actorId, type, target);
  batches.set(em, { companyId, depth: 1, type, target });
}
export async function finishCostBatch(em: EntityManager, companyId: number, actorId: number, type: string) {
  if (!COST_SOURCES.has(type)) return;
  const batch = batches.get(em);
  if (!batch || --batch.depth > 0) return;
  batches.delete(em);
  await preserveSourceCosts(em, companyId, actorId, batch.type, batch.target);
}
export function endCostBatch(em: EntityManager) { batches.delete(em); }
