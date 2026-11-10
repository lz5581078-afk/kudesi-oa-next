import { costBreakdown, sumUnitCents, percentToMicro } from '@kudesi/shared';
import { EntityManager } from 'typeorm';
import { FinanceCostSnapshot } from '../entities';
import type { CostRow } from './cost.service';

export function completeCost(row: Pick<CostRow, 'preShipCostCents' | 'weightG' | 'freightCents' | 'marginPercent' | 'minPriceCents'> & { issues?: string[] }): boolean {
  const nonnegative = (n: number | null) => n !== null && Number.isFinite(n) && n >= 0;
  return !row.issues?.length && nonnegative(row.preShipCostCents) && nonnegative(row.freightCents)
    && row.weightG !== null && Number.isFinite(row.weightG) && row.weightG > 0
    && row.marginPercent !== null && percentToMicro(row.marginPercent) !== null
    && nonnegative(row.minPriceCents) && Number.isSafeInteger(row.minPriceCents);
}

export async function lastCompleteCosts(em: EntityManager, companyId: number, bundleIds: number[]): Promise<Map<number, FinanceCostSnapshot>> {
  const ids = [...new Set(bundleIds)];
  if (!ids.length) return new Map();
  const rows = await em.createQueryBuilder(FinanceCostSnapshot, 's').where('s.companyId = :companyId', { companyId })
    .andWhere(`s.id IN (SELECT MAX(id) FROM finance_cost_snapshots WHERE company_id = :companyId AND bundle_id IN (:...ids)
      AND pre_ship_cost_cents >= 0 AND weight_g > 0 AND freight_cents >= 0 AND margin_percent >= 0 AND margin_percent < 100 AND min_price_cents >= 0
      GROUP BY bundle_id)`, { ids }).getMany();
  return new Map(rows.filter(completeCost).map(row => [row.bundleId, row]));
}

export function effectiveCost(row: CostRow, saved?: FinanceCostSnapshot): CostRow {
  if (completeCost(row)) return { ...row, costState: 'current' };
  row = { ...row, issues: row.issues.length ? row.issues : ['成本、重量、运费或利润率不完整，请核对来源资料'] };
  if (!saved || !completeCost(saved)) return { ...row, costState: 'incomplete', minPriceCents: null };
  const details = saved.context?.calculation;
  const values = { preShipCostCents: saved.preShipCostCents, weightG: saved.weightG, freightCents: saved.freightCents,
    marginPercent: saved.marginPercent, minPriceCents: saved.minPriceCents };
  const lines = details?.lines ?? [];
  return { ...row, ...values, costState: 'fallback', lastSuccessfulAt: new Date(saved.createdAt).toISOString(),
    pricingSettings: { carrierName: row.carrierName, ownPercent: row.marginOverride ? row.marginPercent : null },
    costIncludingFreightCents: sumUnitCents([saved.preShipCostCents!, saved.freightCents!]),
    carrierName: saved.context?.carrierName ?? '', freightMethod: details?.freightMethod ?? null,
    marginSource: details?.marginSource ?? '上次有效成本', marginOverride: saved.context?.explicitMarginPercent != null,
    lines, breakdown: details?.breakdown ?? costBreakdown({ ...values, lines }, null),
  };
}
