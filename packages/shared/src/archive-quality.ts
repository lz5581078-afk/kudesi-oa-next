import { productCapacity } from './product-capacities';
/**
 * 商品档案“核算资料确认”（旧 archive-quality.mjs / ArchiveQualityConfirmation）：
 * 保存商品档案前逐项列出核算相关资料，填 0 的必须明确写原因，缺项列在“尚未完成的项目”里。
 * 原因写在档案的“零值说明”里，每项一行（如“运费：自提”）。纯函数，前后端都能用。
 */
export type QualityMode = 'text' | 'zero' | 'positive' | 'weight' | 'optionalGroup';

export interface QualityField {
  /** 与档案字段 key 一致（组成用 packagingGroup / laborGroup） */
  id: string;
  /** 同时是“零值说明”里这一行的标签 */
  label: string;
  value: unknown;
  mode: QualityMode;
  unit?: string;
}

export interface QualityOptions {
  /** 有成本修改权限才检查采购价、运费、装卸费（没有权限的人表单里就没有这些项） */
  canCost: boolean;
  sourceFacts?: SourceQualityFacts;
  confirmations?: SourceQualityConfirmations;
  /** 已有构成的自制品/OEM 成品：包装组成、人力组成各有几行（新建时还没有构成，传 undefined） */
  composition?: { packaging: number; labor: number };
}

const text = (v: unknown) => String(v ?? '').trim();
const present = (v: unknown) => v !== null && v !== undefined && text(v) !== '';

export function isComposedArchive(values: Record<string, unknown>): boolean {
  return values.archiveType === 'self_made' || (values.archiveType === 'purchased' && values.supplyMode === 'supplier_oem');
}

export function archiveQualityFields(v: Record<string, unknown>, opts: QualityOptions): QualityField[] {
  if (opts.sourceFacts) return sourceQualityFields(opts.sourceFacts, opts.canCost);
  const type = text(v.archiveType);
  const out: QualityField[] = [];
  // 名称、分类、规格数量、规格单位表单本身就是必填，这里不重复检查
  const add = (id: string, label: string, value: unknown, mode: QualityMode, unit?: string) => out.push({ id, label, value, mode, unit });
  const composed = isComposedArchive(v);
  const packaging = type === 'package' || type === 'oem_package';
  const source = type === 'raw' || type === 'shipping_material';
  if (type === 'raw') add('purchaseSpec', '系统规格', v.purchaseSpec, 'text');
  if (type === 'self_made') add('productPackagingSpec', '产品包装规格', v.productPackagingSpec, 'text');
  if (['self_made', 'purchased', 'oem_package'].includes(type)) add('brandId', '品牌', v.brandId, 'text');
  // 重量：自动换算的不在这里检查（保存后才算出来）；人工修正的，0 必须确认“不计重量”
  if (!composed && v.weightManual === true) add('weightG', '重量', v.weightG, 'weight', '克');
  if (packaging) {
    add('packagingCategory', '包装类别', v.packagingCategory, 'text');
    add('capacities', '容量', text(v.capacities).split(/\r?\n/).filter((x) => x.trim()).length, 'positive', '行');
    if (text(v.dimensions)) add('dimensionUnit', '尺寸单位', v.dimensionUnit, 'text');
  }
  if (opts.canCost) {
    if (!composed) add('purchasePrice', '采购价', v.purchasePrice, 'zero');
    if (type !== 'self_made') {
      add('freight', '运费', v.freight, 'zero');
      add('handlingFee', '装卸费', v.handlingFee, 'zero');
    }
  }
  if (composed && opts.composition) {
    add('packagingGroup', '包装组成', opts.composition.packaging, 'optionalGroup', '项');
    add('laborGroup', '人力组成', opts.composition.labor, 'optionalGroup', '项');
  }
  return out;
}

/** 取“零值说明”里每一项已写的原因（按行首标签） */
export function parseQualityReasons(zeroValueReason: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text(zeroValueReason).split(/\r?\n/)) {
    const m = /^([^：:]+)[：:]\s*(.*)$/.exec(line.trim());
    if (m && m[2].trim()) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/** 把确认的原因写回“零值说明”：该项一行，其它行原样保留 */
export function mergeQualityReasons(zeroValueReason: unknown, reasons: Record<string, string>): string {
  const labels = Object.keys(reasons);
  const keep = text(zeroValueReason).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !labels.includes(l.split(/[：:]/)[0].trim()));
  return [...labels.filter((l) => reasons[l].trim()).map((l) => `${l}：${reasons[l].trim()}`), ...keep].join('\n');
}

export interface QualityIssue { id: string; message: string }

export function archiveQualityIssues(v: Record<string, unknown>, opts: QualityOptions): QualityIssue[] {
  const reasons = parseQualityReasons(v.zeroValueReason);
  const context = opts.sourceFacts ? archiveQualityContext(opts.sourceFacts) : undefined;
  const issues: QualityIssue[] = [];
  for (const f of archiveQualityFields(v, opts)) {
    if (!present(f.value)) {
      // 原料、发货物料的采购价取自供货来源，可以不填
      if (f.id === 'purchasePrice' && ['raw', 'shipping_material'].includes(text(v.archiveType))) continue;
      issues.push({ id: f.id, message: `${f.label}未填写` });
      continue;
    }
    if (f.mode === 'text') continue;
    const n = Number(f.value);
    if (!Number.isFinite(n) || n < 0) { issues.push({ id: f.id, message: `${f.label}必须是非负数` }); continue; }
    if (n === 0) {
      if (f.mode === 'positive') issues.push({ id: f.id, message: `${f.label}必须大于0` });
      else if (opts.sourceFacts ? !validSourceQualityConfirmation(opts.confirmations?.[f.id], context!) : !reasons[f.label]) issues.push({ id: f.id, message: `${f.label}为0，尚未明确确认` });
    }
  }
  return issues;
}


/** Source 原子表单完整事实；金额单位为分，普通逐字段 API 不启用此模式。 */
export interface SourceQualitySource {
  key: string; id?: number; status?: string; supplierId: unknown; originArea: unknown;
  systemSpec: unknown; purchasePrice: unknown;
}
export interface SourceQualityComposition {
  key: string; id?: number;
  kind: 'raw' | 'package' | 'oem_package' | 'labor' | 'imported_labor' | 'unknown';
  referenceId: unknown; qty: unknown; unit: unknown; lossPercent: unknown;
  importedLaborName?: unknown;
}
export interface SourceQualityFacts {
  version: 1; productId: number | null; parent: Record<string, unknown>;
  sources: SourceQualitySource[]; composition: SourceQualityComposition[];
}
export interface SourceQualityConfirmation { reason: string; context: string }
export type SourceQualityConfirmations = Record<string, SourceQualityConfirmation>;
export interface SourceQualityRowBinding {
  type: 'finance-product-sources' | 'finance-product-boms'; index: number; key: string; id?: number;
}
export interface SourceQualityCommand {
  version: 1; rows: SourceQualityRowBinding[]; confirmations: SourceQualityConfirmations;
}
const stableRows = (rows: unknown[][]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const activeQualitySources = (facts: SourceQualityFacts) => facts.sources.filter(row => !['inactive', 'stopped', 'deleted'].includes(row.status ?? 'active'));
/** 不含金额；价格变化须重新验证零值，但不把成本写进公开确认上下文。 */
export function archiveQualityContext(facts: SourceQualityFacts): string {
  const p = facts.parent;
  return JSON.stringify([
    p.archiveType === 'purchased' ? (p.supplyMode === 'supplier_oem' ? 'supplier_oem' : 'original_purchase') : text(p.archiveType), text(p.purchaseSpec), text(p.weightUnit || 'KG'),
    stableRows(facts.sources.map(row => [row.key, text(row.supplierId), text(row.originArea), text(row.systemSpec)])),
    stableRows(facts.composition.map(row => [row.kind, row.kind === 'imported_labor' ? row.key : text(row.referenceId), Number(row.qty), text(row.unit), Number(row.lossPercent || 0)])),
  ]);
}
export function validSourceQualityConfirmation(value: unknown, context: string): value is SourceQualityConfirmation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.reason === 'string' && !!receipt.reason.trim() && receipt.reason.trim().length <= 180 && receipt.context === context;
}
export function archiveQualityFingerprint(facts: SourceQualityFacts, confirmations: SourceQualityConfirmations = {}): string {
  return JSON.stringify([archiveQualityContext(facts), sourceQualityFields(facts, true).map(field => [field.id, text(field.value)]), Object.keys(confirmations).sort().map(key => [key, confirmations[key]])]);
}
function sourceQualityFields(facts: SourceQualityFacts, canCost: boolean): QualityField[] {
  const p = facts.parent, type = text(p.archiveType), oem = type === 'purchased' && p.supplyMode === 'supplier_oem';
  const source = type === 'raw' || type === 'shipping_material', packaging = type === 'package' || type === 'oem_package';
  const out: QualityField[] = [];
  const add = (id: string, label: string, value: unknown, mode: QualityMode, unit?: string) => out.push({ id, label, value, mode, unit });
  add('code', '商品编号', p.code, 'text'); add('name', '名称', p.name, 'text'); add('categoryId', '所属分类', p.categoryId, 'text');
  if (type !== 'shipping_material') add('purchaseSpec', '系统规格', p.purchaseSpec, 'text');
  if (!source) add('brandId', '品牌', p.brandId, 'text');
  if (!['self_made', 'package', 'oem_package'].includes(type)) { add('specQty', '规格', p.specQty, 'text'); add('specUnit', '规格单位', p.specUnit, 'text'); }
  add('weightG', '重量', p.weightG, type === 'purchased' || type === 'self_made' ? 'positive' : 'weight', '克');
  if (source) {
    const rows = activeQualitySources(facts); add('sources', '供货来源', rows.length, 'positive', '项');
    rows.forEach((row, i) => {
      const key = `source:${row.key}:`, label = `来源${i + 1}`;
      add(`${key}supplierId`, `${label}供应商`, row.supplierId, 'text'); add(`${key}originArea`, `${label}产区`, row.originArea, 'text');
      if (type === 'shipping_material') add(`${key}systemSpec`, `${label}系统规格`, row.systemSpec, 'text');
      if (canCost) add(`${key}purchasePrice`, `${label}采购价`, row.purchasePrice, 'zero');
    });
  } else if (canCost && type !== 'self_made') {
    add('purchasePrice', '采购价', p.purchasePrice, 'zero');
  }
  if (packaging) {
    add('packagingCategory', '包装类别', p.packagingCategory, 'text'); add('weightUnit', '重量单位', p.weightUnit, 'text');
    const capacities = text(p.capacities).split(/\r?\n/).filter(Boolean).map(productCapacity);
    add('capacities', '容量组', capacities.length, 'positive', '行');
    capacities.forEach((capacity, i) => { add(`capacity:${i}:quantity`, '容量', capacity.quantity, 'positive'); add(`capacity:${i}:unit`, '容量单位', capacity.unit, 'text'); });
    if (text(p.dimensions)) add('dimensionUnit', '尺寸单位', p.dimensionUnit, 'text');
  }
  const counts = (kinds: SourceQualityComposition['kind'][]) => facts.composition.filter(row => kinds.includes(row.kind)).length;
  if (type === 'self_made') {
    add('productPackagingSpec', '产品包装规格', p.productPackagingSpec, 'text'); add('productPackagingUnit', '产品包装单位', p.productPackagingUnit, 'text');
    add('rawGroup', '原料组成', counts(['raw']), 'positive', '项');
    add('packagingGroup', '包装组成', counts(['package', 'oem_package']), 'optionalGroup', '项');
    add('laborGroup', '人力组成', counts(['labor', 'imported_labor']), 'optionalGroup', '项');
  } else if (oem) add('packagingGroup', '包装组成', counts(['oem_package']), 'optionalGroup', '项');
  facts.composition.forEach((row, i) => {
    add(`composition:${row.key}:referenceId`, '组成项目', row.kind === 'imported_labor' ? row.importedLaborName : row.kind === 'unknown' ? null : row.referenceId, 'text');
    add(`composition:${row.key}:qty`, '组成用量', row.qty, 'positive');
  });
  if (canCost) { add('freight', '运费', p.freight, 'zero'); add('handlingFee', '装卸费', p.handlingFee, 'zero'); }
  return out;
}
