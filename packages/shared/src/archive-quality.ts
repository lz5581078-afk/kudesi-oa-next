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
  /** 已有构成的自制品/OEM 成品：包装组成、人力组成各有几行（新建时还没有构成，传 undefined） */
  composition?: { packaging: number; labor: number };
}

const text = (v: unknown) => String(v ?? '').trim();
const present = (v: unknown) => v !== null && v !== undefined && text(v) !== '';

export function isComposedArchive(values: Record<string, unknown>): boolean {
  return values.archiveType === 'self_made' || (values.archiveType === 'purchased' && values.supplyMode === 'supplier_oem');
}

export function archiveQualityFields(v: Record<string, unknown>, opts: QualityOptions): QualityField[] {
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
      else if (!reasons[f.label]) issues.push({ id: f.id, message: `${f.label}为0，尚未明确确认` });
    }
  }
  return issues;
}
