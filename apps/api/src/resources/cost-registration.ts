import { readCostComposition, type CostCompositionFacts } from '@kudesi/shared';
import { EntityManager } from 'typeorm';
export type RegisteredCostValues = Pick<CostCompositionFacts, 'preShipCostCents' | 'weightG'>;
const number = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);

/** 已有记录中最后的有效金额和重量分别读取，兼容此前错误登记过空值的历史。 */
export async function registeredCostValues(em: EntityManager, companyId: number, bundleIds: number[]): Promise<Map<number, RegisteredCostValues>> {
  const ids = [...new Set(bundleIds)];
  if (!ids.length) return new Map();
  const rows = await em.query(`SELECT v.bundle_id AS bundleId,c.pre_ship_cost_cents AS cost,w.weight_g AS weight
    FROM (SELECT bundle_id,
      MAX(CASE WHEN pre_ship_cost_cents IS NOT NULL AND pre_ship_cost_cents>=0 THEN id END) cost_id,
      MAX(CASE WHEN weight_g>0 THEN id END) weight_id
      FROM finance_cost_snapshots WHERE company_id=? AND bundle_id IN (${ids.map(() => '?').join(',')}) GROUP BY bundle_id) v
    LEFT JOIN finance_cost_snapshots c ON c.id=v.cost_id AND c.company_id=?
    LEFT JOIN finance_cost_snapshots w ON w.id=v.weight_id AND w.company_id=?`, [companyId, ...ids, companyId, companyId]);
  return new Map(rows.map((row: { bundleId: number; cost: unknown; weight: unknown }) => [Number(row.bundleId), { preShipCostCents: number(row.cost), weightG: number(row.weight) }]));
}

/** 验证本身已发布过值但尚未有历史行时，用原验证事实作首次登记基线。 */
export function costRegistrationFallback(saved: RegisteredCostValues | undefined, snapshot: unknown): RegisteredCostValues {
  const verified = readCostComposition(snapshot);
  return { preShipCostCents: saved?.preShipCostCents ?? verified?.preShipCostCents ?? null,
    weightG: (saved?.weightG ?? 0) > 0 ? saved!.weightG : (verified?.weightG ?? 0) > 0 ? verified!.weightG : null };
}
