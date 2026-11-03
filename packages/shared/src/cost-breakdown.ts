import { multiplyUnitCents, sumUnitCents } from './unit-price';

/** 金额以分、重量以克记录；快照明细不能用后来改名或改单位的当前资料补写。 */
export interface CostBreakdownLine {
  role: string; code: string; name: string; qty: number | null; unitName?: string;
  unitCostCents: number | null; subtotalCents: number | null;
  unitWeightG: number | null; weightG: number | null;
}
export interface CostCompositionFacts { preShipCostCents: number | null; weightG: number | null; lines: CostBreakdownLine[] }
export interface CostBreakdownDimension {
  source: string; total: number | null; componentTotal: number | null; difference: number | null; matches: boolean; lines: CostBreakdownLine[];
}
export interface CostBreakdown { cost: CostBreakdownDimension; weight: CostBreakdownDimension }
const number = (value: unknown): number | null => (typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const roundWeight = (value: number) => Math.round(value * 1e6) / 1e6;

function totals(lines: CostBreakdownLine[], manualWeight?: number | null): CostCompositionFacts {
  const cost = lines.length && lines.every(line => line.subtotalCents !== null) ? sumUnitCents(lines.map(line => line.subtotalCents!)) : null;
  const weights = lines.filter(line => line.role !== 'labor');
  const weight = weights.length && weights.every(line => line.weightG !== null) ? roundWeight(weights.reduce((sum, line) => sum + line.weightG!, 0)) : null;
  return { preShipCostCents: cost, weightG: manualWeight === undefined ? weight : manualWeight, lines };
}

/** 兼容此前仅保存ref/qty/cost的验证快照；没有保存过的名称、计价单位保持未知。 */
export function readCostComposition(value: unknown): CostCompositionFacts | null {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  const snapshot = object(value);
  if (!snapshot) return null;
  const saved = object(snapshot.breakdown);
  if (saved && Array.isArray(saved.lines)) {
    const lines = saved.lines.map(raw => {
      const row = object(raw) ?? {};
      return { role: text(row.role), code: text(row.code), name: text(row.name), qty: number(row.qty), unitName: text(row.unitName) || undefined, unitCostCents: number(row.unitCostCents), subtotalCents: number(row.subtotalCents), unitWeightG: number(row.unitWeightG), weightG: number(row.weightG) };
    });
    return { preShipCostCents: number(saved.preShipCostCents), weightG: number(saved.weightG), lines };
  }
  if (!Array.isArray(snapshot.lines)) return null;
  const profile = object(snapshot.profile);
  const lines: CostBreakdownLine[] = snapshot.lines.map(raw => {
    const row = object(raw) ?? {};
    const qty = number(row.qty), unit = number(row.cost), weight = number(row.weightG);
    return { role: text(row.role), code: text(row.ref), name: text(row.name) || text(row.ref), qty, unitName: text(row.unitName) || undefined,
      unitCostCents: unit, subtotalCents: qty !== null && qty > 0 && unit !== null ? multiplyUnitCents(unit, qty) : null,
      unitWeightG: weight, weightG: row.role === 'labor' ? 0 : qty !== null && qty > 0 && weight !== null ? roundWeight(weight * qty) : null };
  });
  return totals(lines, profile?.weightMode === 'manual' ? number(profile.manualWeightG) : undefined);
}

/** 成本和重量分别选能解释表格记录的快照，不能因其中一项一致就套用另一项。 */
export function costBreakdown(current: CostCompositionFacts, verified: CostCompositionFacts | null, target: Pick<CostCompositionFacts, 'preShipCostCents' | 'weightG'> = current): CostBreakdown {
  const dimension = (kind: 'cost' | 'weight'): CostBreakdownDimension => {
    const key = kind === 'cost' ? 'preShipCostCents' : 'weightG';
    const total = target[key];
    const candidates = [{ source: '验证快照', facts: verified }, { source: '当前组成', facts: current }];
    const close = (value: number | null) => value !== null && total !== null && (kind === 'cost' ? Math.round(Math.abs(value - total) * 1e4) / 1e4 : roundWeight(Math.abs(value - total))) < (kind === 'cost' ? 0.0001 : 0.001);
    const selected = candidates.find(candidate => candidate.facts && close(candidate.facts[key])) ?? candidates.find(candidate => candidate.facts !== null)!;
    const lines = selected.facts!.lines.filter(line => kind === 'cost' || line.role !== 'labor');
    const complete = lines.length > 0 && lines.every(line => (kind === 'cost' ? line.subtotalCents : line.weightG) !== null);
    const componentTotal = !complete ? null : kind === 'cost' ? sumUnitCents(lines.map(line => line.subtotalCents!)) : roundWeight(lines.reduce((sum, line) => sum + line.weightG!, 0));
    const difference = componentTotal === null || total === null ? null : kind === 'cost' ? Math.round((total - componentTotal) * 1e4) / 1e4 : roundWeight(total - componentTotal);
    return { source: selected.source, total, componentTotal, difference, matches: componentTotal !== null && close(componentTotal), lines };
  };
  return { cost: dimension('cost'), weight: dimension('weight') };
}
