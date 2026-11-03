import { registeredCostValues, costRegistrationFallback } from './cost-registration';
import { DataSource, EntityManager } from 'typeorm';
import { FinanceCostSnapshot, ResourceRecord } from '../entities';
import { In } from 'typeorm';
import { COST_TABLE_STATUSES, CostService } from './cost.service';

/** 成本历史的事件类型（旧系统 bundle-cost-history 的事件）：验证发布 / 维护售价 / 来源值变化 / 手动登记 */
export type CostEvent = 'workflow_publish' | 'pricing_update' | 'source_values_update' | 'manual';
export const COST_EVENT_LABEL: Record<CostEvent, string> = { workflow_publish: '验证发布', pricing_update: '维护售价', source_values_update: '来源值变化', manual: '手动登记' };

/**
 * 登记成本快照：和这个组合上一次登记的相比没变就不记。
 * 成本是实时现算的，所以“基础资料变了”也要在这里留痕，不然成本历史里看不到什么时候变的。
 */
export async function registerCostSnapshots(
  em: EntityManager, companyId: number, actorId: number | null, bundleIds: number[], reason: string, eventType: CostEvent,
): Promise<{ recorded: number; unchanged: number; missing: number }> {
  let recorded = 0, unchanged = 0, missing = 0;
  if (!bundleIds.length) return { recorded, unchanged, missing };
  if (em.queryRunner?.isTransactionActive) await em.find(ResourceRecord, { where: { companyId, type: 'finance-bundles', id: In([...new Set(bundleIds)]) }, order: { id: 'ASC' }, lock: { mode: 'pessimistic_write' } });
  const cost = new CostService(em.connection as DataSource);
  const d = await cost.load(companyId, em);
  const byId = new Map(d.bundles.map((b) => [b.id, b]));
  const ids = [...new Set(bundleIds)];
  const raw = new Map(ids.filter(id => byId.has(id)).map(id => [id, cost.row(d, byId.get(id)!)]));
  const missingIds = ids.filter(id => raw.has(id) && (raw.get(id)!.preShipCostCents === null || raw.get(id)!.weightG === null));
  const previous = await registeredCostValues(em, companyId, missingIds);
  for (const id of ids) {
    const b = byId.get(id);
    if (!b) { missing++; continue; }
    const row = missingIds.includes(id) ? cost.row(d, b, costRegistrationFallback(previous.get(id), b.data.snapshot)) : raw.get(id)!;
    const last = await em.findOne(FinanceCostSnapshot, { where: { companyId, bundleId: id }, order: { id: 'DESC' }, ...(em.queryRunner?.isTransactionActive ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    const same = last && last.preShipCostCents === row.preShipCostCents && last.weightG === row.weightG && last.freightCents === row.freightCents
      && last.minPriceCents === row.minPriceCents && last.marginPercent === row.marginPercent;
    if (same) { unchanged++; continue; }
    await em.insert(FinanceCostSnapshot, {
      companyId, bundleId: id, code: row.code, name: row.name, revision: (last?.revision ?? 0) + 1,
      preShipCostCents: row.preShipCostCents, weightG: row.weightG, freightCents: row.freightCents, marginPercent: row.marginPercent, minPriceCents: row.minPriceCents,
      reason: reason.slice(0, 200), eventType, actorId,
    });
    recorded++;
  }
  return { recorded, unchanged, missing };
}

/** 来源（基础编码、人工）变了：在成本表范围内的组合登记一版“来源值变化” */
export async function recordSourceChange(em: EntityManager, companyId: number, actorId: number | null, bundleIds: number[], reason: string): Promise<void> {
  if (!bundleIds.length) return;
  const rows: Array<{ id: number }> = await em.query(
    `SELECT id FROM resource_records WHERE company_id = ? AND type = 'finance-bundles' AND status IN (${COST_TABLE_STATUSES.map(() => '?').join(',')}) AND id IN (${bundleIds.map(() => '?').join(',')})`,
    [companyId, ...COST_TABLE_STATUSES, ...bundleIds]);
  await registerCostSnapshots(em, companyId, actorId, rows.map((r) => r.id), reason, 'source_values_update');
}
