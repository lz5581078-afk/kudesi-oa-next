import { multiplyUnitCents, sumUnitCents, type CostBreakdownLine, type CostCompositionFacts } from '@kudesi/shared';
import { EntityManager, In } from 'typeorm';
import { ResourceRecord } from '../entities';

type Data = Record<string, unknown>;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = (value: unknown) => typeof value === 'string' ? value : '';
const roundWeight = (value: number) => Math.round(value * 1e6) / 1e6;
export interface CostLine extends CostBreakdownLine { qty: number }
interface ComponentContext {
  lines: ResourceRecord[]; baseCodeLines: ResourceRecord[];
  baseCodes: Map<number, ResourceRecord>; products: Map<number, ResourceRecord>; labor: Map<number, ResourceRecord>;
}

/** 成本表与验证快照使用同一份组成计算，缺失重量不能当成0混入合计。 */
export function calculateCostComponents(d: ComponentContext, bundleId: number): { lines: CostLine[]; cost: number | null; weightG: number | null; issues: string[] } {
  const lines: CostLine[] = [], issues: string[] = [];
  let cost: number | null = 0, weightG: number | null = 0;
  for (const row of d.lines.filter(line => line.data.bundleId === bundleId).sort((a,b) => a.id - b.id)) {
    const line = row.data, qty = num(line.qty) ?? 0, role = str(line.role);
    let unit: number | null = null, weight: number | null = 0, code = '', name = '', unitName = '';
    if (role === 'labor') {
      const labor = d.labor.get(num(line.laborId) ?? -1);
      unit = labor ? num(labor.data.unitPrice) : null;
      name = labor?.title ?? '人工'; code = str(labor?.data.code) || '人工';
      unitName = str(labor?.data.unitName).replace(/^元\s*[\/／]\s*/, '');
    } else {
      const base = d.baseCodes.get(num(line.baseCodeId) ?? -1);
      const product = base ? d.products.get(num(base.data.productId) ?? -1) : undefined;
      code = str(base?.data.code); name = str(base?.data.name) || base?.title || '';
      unitName = base?.data.origin === 'composed' ? str(line.unit) : str(product?.data.purchaseSpec) || str(line.unit);
      if (base?.data.origin === 'composed') {
        const parts = d.baseCodeLines.filter(part => part.data.baseCodeId === base.id);
        unit = parts.length ? 0 : null; weight = parts.length ? 0 : null;
        for (const part of parts) {
          const product = d.products.get(num(part.data.productId) ?? -1), quantity = num(part.data.qty) ?? 0;
          const price = product ? num(product.data.totalCost) : null, grams = product ? num(product.data.weightG) : null;
          unit = unit === null || price === null || quantity <= 0 ? null : sumUnitCents([unit, multiplyUnitCents(price, quantity)]);
          weight = weight === null || grams === null || quantity <= 0 ? null : weight + grams * quantity;
        }
      } else { unit = product ? num(product.data.totalCost) : null; weight = product ? num(product.data.weightG) : null; }
    }
    const subtotal = unit === null || qty <= 0 ? null : multiplyUnitCents(unit, qty);
    const subtotalWeight = weight === null || qty <= 0 ? null : roundWeight(weight * qty);
    if (subtotal === null) { issues.push(`「${name || code}」还没有完整成本或有效数量`); cost = null; }
    else if (cost !== null) cost = sumUnitCents([cost, subtotal]);
    if (subtotalWeight === null) { issues.push(`「${name || code}」还没有完整重量或有效数量`); weightG = null; }
    else if (weightG !== null) weightG += weight! * qty;
    lines.push({ role, code, name, qty, unitName, unitCostCents: unit, subtotalCents: subtotal, unitWeightG: role === 'labor' ? null : weight, weightG: subtotalWeight });
  }
  if (!lines.length) { cost = null; weightG = null; issues.push('还没有构成'); }
  return { lines, cost, weightG: weightG === null ? null : roundWeight(weightG), issues };
}

/** 验证时只读取这些组成引用的资料，不为每个组合重新扫描全公司的成本数据。 */
export async function costCompositionFacts(em: EntityManager, companyId: number, bundle: Data, input: Data[]): Promise<CostCompositionFacts> {
  const baseIds = [...new Set(input.map(line => num(line.baseCodeId)).filter((id): id is number => id !== null))];
  const laborIds = [...new Set(input.map(line => num(line.laborId)).filter((id): id is number => id !== null))];
  const bases = baseIds.length ? await em.find(ResourceRecord, { where: { companyId, type: 'finance-base-codes', id: In(baseIds) } }) : [];
  const parts = baseIds.length ? await em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :companyId AND r.type = :type', { companyId, type: 'finance-base-code-lines' }).andWhere("JSON_EXTRACT(r.data, '$.baseCodeId') IN (:...baseIds)", { baseIds }).getMany() : [];
  const productIds = [...new Set([...bases.map(base => num(base.data.productId)), ...parts.map(part => num(part.data.productId))].filter((id): id is number => id !== null))];
  const products = productIds.length ? await em.find(ResourceRecord, { where: { companyId, type: 'finance-products', id: In(productIds) } }) : [];
  const labor = laborIds.length ? await em.find(ResourceRecord, { where: { companyId, type: 'finance-labor-costs', id: In(laborIds) } }) : [];
  const map = (rows: ResourceRecord[]) => new Map(rows.map(row => [row.id, row]));
  const result = calculateCostComponents({ lines: input.map((data,index) => Object.assign(new ResourceRecord(), { id: index + 1, data: { ...data, bundleId: -1 } })), baseCodeLines: parts, baseCodes: map(bases), products: map(products), labor: map(labor) }, -1);
  return { preShipCostCents: result.cost, weightG: bundle.weightMode === 'manual' ? num(bundle.manualWeightG) : result.weightG, lines: result.lines };
}
