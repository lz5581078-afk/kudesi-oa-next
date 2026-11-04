import { LOGISTICS_CENT_SCALE,multiplyUnitCents,sumUnitCentsProducts,type UnitCentsProduct, type CostBreakdownLine, type CostCompositionFacts } from '@kudesi/shared';
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
  const costTerms:UnitCentsProduct[]=[];
  let cost: number | null = 0, weightG: number | null = 0;
  for (const row of d.lines.filter(line => line.data.bundleId === bundleId).sort((a,b) => a.id - b.id)) {
    const line = row.data, qty = num(line.qty) ?? 0, role = str(line.role);
    let unit: number | null = null, weight: number | null = 0, code = '', name = '', unitName = '';
    if (role === 'labor') {
      const labor = d.labor.get(num(line.laborId) ?? -1);
      unit = labor ? num(labor.data.unitPrice) : null;
      name = labor?.title ?? '人工'; code = str(labor?.data.code) || '人工';
      unitName = str(labor?.data.unitName).replace(/^元\s*[\/／]\s*/, '');
    } else if(line.productId!=null){
      const product=d.products.get(Number(line.productId));unit=num(product?.data.totalCost);weight=num(product?.data.weightG);code=str(product?.data.code);name=product?.title ?? '';unitName=str(line.unit)||str(product?.data.specUnit);
    } else {
      const selected = d.baseCodes.get(num(line.baseCodeId) ?? -1);
      const base = typeof selected?.data.canonicalId === 'number' ? d.baseCodes.get(selected.data.canonicalId) : selected;
      const product = base ? d.products.get(num(base.data.productId) ?? -1) : undefined;
      code = str(selected?.data.code); name = str(selected?.data.name) || selected?.title || '';
      unitName = base?.data.origin === 'composed' ? str(line.unit) : str(product?.data.purchaseSpec) || str(line.unit);
      if (base?.data.origin === 'composed') {
        const parts = d.baseCodeLines.filter(part => part.data.baseCodeId === base.id);
        unit = num(base.data.cost); weight = parts.length ? 0 : null;
        for (const part of parts) {
          const product = d.products.get(num(part.data.productId) ?? -1), quantity = num(part.data.qty) ?? 0;
          const grams = product ? num(product.data.weightG) : null;
          weight = weight === null || grams === null || quantity <= 0 ? null : weight + grams * quantity;
        }
      } else if(base?.data.origin==='external_import'){unit=num(base.data.externalCost);weight=num(base.data.weightG);unitName=str(line.unit)||str(base.data.baseUnit)||str(base.data.codeSpecUnit);}
      // 普通基础编码读取真实已存报价：原 DB cost_price 是四位元终点，不能以档案八位总额替换。
      else { unit = base ? num(base.data.cost) : null; weight = product ? num(product.data.weightG) : null; }
      // 专属重量与来源商品的自动重量独立；马甲使用真实编码的专属重量。
      if (base?.data.profileWeightOverride !== undefined) weight = num(base.data.profileWeightOverride);
    }
    const subtotal = unit === null || qty <= 0 ? null : multiplyUnitCents(unit,qty,0,6,LOGISTICS_CENT_SCALE,4);
    const subtotalWeight = weight === null || qty <= 0 ? null : roundWeight(weight * qty);
    if (subtotal === null) { issues.push(`「${name || code}」还没有完整成本或有效数量`); cost = null; }
    else costTerms.push({value:unit!,quantity:qty});
    if (subtotalWeight === null) { issues.push(`「${name || code}」还没有完整重量或有效数量`); weightG = null; }
    else if (weightG !== null) weightG += weight! * qty;
    lines.push({ role, code, name, qty, unitName, unitCostCents: unit, subtotalCents: subtotal, unitWeightG: role === 'labor' ? null : weight, weightG: subtotalWeight });
  }
  if (!lines.length) { cost = null; weightG = null; issues.push('还没有构成'); }
  else if(cost!==null)cost=sumUnitCentsProducts(costTerms,6,LOGISTICS_CENT_SCALE,4);
  return { lines, cost, weightG: weightG === null ? null : roundWeight(weightG), issues };
}

/** 验证时只读取这些组成引用的资料，不为每个组合重新扫描全公司的成本数据。 */
export async function costCompositionFacts(em: EntityManager, companyId: number, bundle: Data, input: Data[]): Promise<CostCompositionFacts> {
  const baseIds = [...new Set(input.map(line => num(line.baseCodeId)).filter((id): id is number => id !== null))];
  const laborIds = [...new Set(input.map(line => num(line.laborId)).filter((id): id is number => id !== null))];
  const bases = baseIds.length ? await em.find(ResourceRecord, { where: { companyId, type: 'finance-base-codes', id: In(baseIds) } }) : [];
  const canonicalIds = [...new Set(bases.map(base => num(base.data.canonicalId)).filter((id): id is number => id !== null && !baseIds.includes(id)))];
  if (canonicalIds.length) bases.push(...await em.find(ResourceRecord, { where: { companyId, type: 'finance-base-codes', id: In(canonicalIds) } }));
  const allBaseIds = bases.map(base => base.id);
  const parts = allBaseIds.length ? await em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :companyId AND r.type = :type', { companyId, type: 'finance-base-code-lines' }).andWhere("JSON_EXTRACT(r.data, '$.baseCodeId') IN (:...baseIds)", { baseIds: allBaseIds }).getMany() : [];
  const productIds = [...new Set([...bases.map(base => num(base.data.productId)), ...parts.map(part => num(part.data.productId)),...input.map(line=>num(line.productId))].filter((id): id is number => id !== null))];
  const products = productIds.length ? await em.find(ResourceRecord, { where: { companyId, type: 'finance-products', id: In(productIds) } }) : [];
  const labor = laborIds.length ? await em.find(ResourceRecord, { where: { companyId, type: 'finance-labor-costs', id: In(laborIds) } }) : [];
  const map = (rows: ResourceRecord[]) => new Map(rows.map(row => [row.id, row]));
  const result = calculateCostComponents({ lines: input.map((data,index) => Object.assign(new ResourceRecord(), { id: index + 1, data: { ...data, bundleId: -1 } })), baseCodeLines: parts, baseCodes: map(bases), products: map(products), labor: map(labor) }, -1);
  return { preShipCostCents: result.cost, weightG: bundle.weightMode === 'manual' ? num(bundle.manualWeightG) : result.weightG, lines: result.lines };
}
