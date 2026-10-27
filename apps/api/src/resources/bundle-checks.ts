import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ResourceRecord } from '../entities';

type Data = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const rec = (em: EntityManager, companyId: number, type: string, id: unknown) =>
  typeof id === 'number' ? em.findOne(ResourceRecord, { where: { id, companyId, type } }) : Promise.resolve(null);

/** 构成行上除“用途、基础编码/人工、数量”之外的旧系统 BOM 行字段 */
export const LINE_EXTRA_KEYS = ['unit', 'lossRate', 'isRequired', 'includeInJst', 'costBucket', 'costTreatment', 'sortOrder', 'effectiveFrom', 'effectiveTo', 'note'] as const;
export const COST_BUCKET_VALUES = ['purchase', 'transfer', 'pre_ship_package', 'production', 'shipping_package', 'express'];
export const COST_TREATMENT_VALUES = ['include', 'included_in_parent', 'reference_only'];
export const SHIPPING_ROLES = ['package', 'label', 'instruction', 'other', 'auxiliary'];

/** 补默认值并检查一行的额外字段（新建构成行、构成修订、批量生成共用） */
export function normalizeLineExtras(data: Data, bc: ResourceRecord | null, product: ResourceRecord | null): void {
  const role = str(data.role);
  if (role === 'labor') {
    delete data.unit; delete data.includeInJst;
  } else {
    if (!str(data.unit)) data.unit = str(product?.data.specUnit) || undefined;
    if (data.includeInJst === undefined || data.includeInJst === null) data.includeInJst = role === 'main' || role === 'gift';
  }
  if (data.isRequired === undefined || data.isRequired === null) data.isRequired = true;
  if (!str(data.costTreatment)) data.costTreatment = 'include';
  if (!str(data.costBucket)) data.costBucket = SHIPPING_ROLES.includes(role) ? 'shipping_package' : 'purchase';
  if (!COST_BUCKET_VALUES.includes(str(data.costBucket))) throw new BadRequestException('成本归集无效');
  if (!COST_TREATMENT_VALUES.includes(str(data.costTreatment))) throw new BadRequestException('成本处理方式无效');
  const loss = data.lossRate === undefined || data.lossRate === null ? 0 : num(data.lossRate);
  if (loss === null || loss < 0) throw new BadRequestException('损耗率不能为负数');
  data.lossRate = loss;
  const from = str(data.effectiveFrom), to = str(data.effectiveTo);
  if (from && to && to < from) throw new BadRequestException('失效日不能早于生效日');
  if (data.includeInJst === true) {
    if (role === 'labor') throw new BadRequestException('人工不能进入聚水潭组合装');
    if (!Number.isSafeInteger(num(data.qty))) throw new BadRequestException('进入聚水潭组合装的行数量必须是正整数');
  }
  for (const k of ['effectiveFrom', 'effectiveTo', 'unit', 'costBucket', 'costTreatment', 'note'] as const) if (!str(data[k])) delete data[k];
}

/** 取一行的额外字段（修订、复制构成时原样带上） */
export function pickLine(d: Data): Data {
  const out: Data = { role: d.role, qty: d.qty };
  if (d.baseCodeId !== undefined) out.baseCodeId = d.baseCodeId;
  if (d.laborId !== undefined) out.laborId = d.laborId;
  for (const k of LINE_EXTRA_KEYS) if (d[k] !== undefined && d[k] !== null && d[k] !== '') out[k] = d[k];
  return out;
}

export async function hasChildren(em: EntityManager, companyId: number, categoryId: number): Promise<boolean> {
  const rows = await em.query("SELECT 1 FROM resource_records WHERE company_id = ? AND type = 'finance-categories' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.parentId')) = ? AND status = 'active' LIMIT 1", [companyId, String(categoryId)]);
  return rows.length > 0;
}

export interface BundleIssue { message: string }

/**
 * 验证问题清单（旧系统 bundle-verification）：返回所有问题，空数组表示可以验证。
 * lines 是将要验证的构成（含待发布修订里的）。
 */
export async function bundleIssues(em: EntityManager, companyId: number, bundle: Data, lines: Data[], platformStatus?: string): Promise<string[]> {
  const issues: string[] = [];
  const cat = await rec(em, companyId, 'finance-categories', bundle.bundleCategoryId);
  if (!cat || cat.status !== 'active' || cat.data.archiveType !== 'bundle') issues.push('组合分类不存在或已停用（请选组合分类树里的最末级分类）');
  else if (await hasChildren(em, companyId, cat.id)) issues.push('组合分类必须选最末级');
  if (platformStatus && platformStatus !== 'active') issues.push('销售平台已停用');
  const labels: Array<[string, string]> = [['code', '组合编码'], ['styleCode', '款式编码'], ['name', '商品名称'], ['shortName', '商品简称'], ['propertiesValue', '规格值'], ['baseUnit', '计量单位']];
  for (const [k, label] of labels) if (!str(bundle[k]).trim()) issues.push(`${label}未填写`);
  if (str(bundle.code).startsWith('ZH-待配置')) issues.push('组合编码还没生成（先添加主品）');
  let weight = 0, weightKnown = true, jstLines = 0;
  for (const l of lines) {
    const role = str(l.role);
    const qty = num(l.qty);
    if (role === 'labor') {
      const lab = await rec(em, companyId, 'finance-labor-costs', l.laborId);
      if (!lab || lab.status !== 'active') issues.push('人工来源停用、失效或成本无效');
      else if (!(qty && qty > 0)) issues.push(`${lab.title}：用量必须大于0`);
      continue;
    }
    const bc = await rec(em, companyId, 'finance-base-codes', l.baseCodeId);
    const name = bc?.title ?? '组成商品';
    if (!bc) { issues.push(`${name}：来源不存在`); continue; }
    if (!(qty && qty > 0)) issues.push(`${name}：用量必须大于0`);
    if (bc.status !== 'verified') issues.push(`${name}：基础编码尚未验证或需二次验证`);
    const real = typeof bc.data.canonicalId === 'number' ? (await rec(em, companyId, 'finance-base-codes', bc.data.canonicalId)) ?? bc : bc;
    const p = await rec(em, companyId, 'finance-products', real.data.productId);
    if (!str(l.unit) && !str(p?.data.specUnit)) issues.push(`${name}：缺少计量单位，请维护基础商品单位`);
    const cost = num(real.data.cost) ?? num(p?.data.totalCost);
    if (cost === null || cost < 0) issues.push(`${name}：缺少有效总成本`);
    const w = num(real.data.weightG) ?? num(p?.data.weightG);
    if (w === null) weightKnown = false; else weight += w * (qty ?? 0);
    if (l.includeInJst === true) {
      jstLines++;
      if (!Number.isSafeInteger(qty)) issues.push(`${name}：聚水潭组合装数量必须为正整数`);
    }
  }
  if (!lines.some((l) => l.role === 'main')) issues.push('组合至少需要一条主商品');
  if (jstLines === 0) issues.push('没有可上传的组合明细');
  const manualW = str(bundle.weightMode) === 'manual' ? num(bundle.manualWeightG) : null;
  if (str(bundle.weightMode) === 'manual' ? !(manualW && manualW > 0) : !(weightKnown && weight > 0)) issues.push('组合重量缺失或无效，请检查组成重量');
  return [...new Set(issues)];
}
