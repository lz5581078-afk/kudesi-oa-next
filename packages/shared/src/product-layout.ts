/**
 * 商品档案“新增 / 编辑 / 详情”共用的一份布局（旧版 10-24 的商品抽屉：每种档案类型一套分区、顺序、必填、显示条件）。
 *
 * 字段本身（类型、选项、权限、服务端规则）仍在 finance-resources.ts 的 finance-products 里定义一次；
 * 这里只回答“这种档案类型的表单怎么排”：分几个区、每区放哪些字段/功能块、先后顺序、这一类里的叫法和必填。
 * 详情页、新增表单、编辑表单都读这一份，所以三处的分区、顺序、显示条件不会各写各的。
 */
import { FINANCE_RESOURCE_DEFS } from './finance-resources';
import type { FieldDef } from './resources';

export type ProductLayoutKey = 'raw' | 'self_made' | 'purchased_original' | 'purchased_oem' | 'package' | 'oem_package' | 'shipping_material' | 'custom';

/** 内置六种档案类型；其余都是公司自建类型（旧版“新增顶级分类”建出来的） */
export const BUILTIN_ARCHIVE_TYPES = ['raw', 'self_made', 'purchased', 'package', 'shipping_material', 'oem_package'] as const;

export function productLayoutKey(values: Record<string, unknown>): ProductLayoutKey {
  const t = String(values.archiveType ?? '');
  if (t === 'purchased') return values.supplyMode === 'supplier_oem' ? 'purchased_oem' : 'purchased_original';
  if ((BUILTIN_ARCHIVE_TYPES as readonly string[]).includes(t)) return t as ProductLayoutKey;
  return 'custom';
}

/** 功能块：不是单个输入框，而是一组联动的界面（表单里可编辑，详情里只读展示） */
export type ProductBlock =
  | 'category'      // 归入分类：路径、最末级校验、搜索/快速新建
  | 'code'          // 系统自动编号：人工修正 / 恢复自动编号、实时预览
  | 'fullName'      // 基础信息全名（自动拼）
  | 'capacities'    // 容量组（包装类：多行 容量 + 单位）
  | 'finishedNames' // 原料成品名（马甲）多行
  | 'supplySources' // 供货来源多行（原料、发货物料）
  | 'composition'   // 生产组成（自制品：原料/产品包装/OEM 包装/人工；OEM 成品：OEM 包装）
  | 'weight'        // 重量：自动换算 / 人工修正 / 带单位输入
  | 'breakdown'     // 构成成本与重量实时汇总（自制品、OEM 成品）
  | 'costSummary';  // 总成本价：采购价 + 运费 + 装卸费，上次/近 3 个月平均/历史采购价

/** 每个功能块包办的字段（用来保证“没有字段被排丢”） */
export const BLOCK_FIELDS: Readonly<Record<ProductBlock, readonly string[]>> = {
  category: ['categoryId'],
  code: ['code'],
  fullName: ['basicInfoFullName'],
  capacities: ['capacities', 'specQty', 'specUnit'],
  finishedNames: ['rawFinishedNames'],
  supplySources: ['supplierId', 'purchasePrice'],
  composition: [],
  weight: ['weightG', 'weightManual', 'weightUnit'],
  breakdown: [],
  costSummary: ['totalCost', 'latestUnitCost', 'latestCostType', 'latestCostFrom', 'migrationNotice'],
};

export interface FieldItem {
  field: string;
  /** 这一类里的叫法（旧版“名称规格”“名称单位”“原料生产编码”…） */
  label?: string;
  /** 覆盖字段定义里的必填：true 必填，false 选填；不写取字段定义 */
  required?: boolean;
  /** 覆盖字段说明；写空串表示不显示 */
  help?: string;
  /** 占满整行 */
  wide?: boolean;
  /** 只在已经有值时才显示（旧版这一类不填，但迁入的旧数据里有，不能藏掉） */
  whenFilled?: boolean;
}
export interface BlockItem { block: ProductBlock; label?: string; required?: boolean; /** composition：这一类有哪几组 */ groups?: readonly CompositionGroup[] }
export type LayoutItem = FieldItem | BlockItem;
export const isBlock = (i: LayoutItem): i is BlockItem => 'block' in i;

export type CompositionGroup = 'raw' | 'package' | 'oem_package' | 'labor';
export const COMPOSITION_GROUP_LABEL: Readonly<Record<CompositionGroup, { title: string; hint: string; archiveType?: string; pick: string }>> = {
  raw: { title: '原料组成', hint: '支持直接搜索，也可按分类逐级选择原料', archiveType: 'raw', pick: '原料档案' },
  package: { title: '产品包装', hint: '产品包装和 OEM 包装统一计入包装成本与包装重量', archiveType: 'package', pick: '产品包装档案' },
  oem_package: { title: 'OEM 包装', hint: '按各 OEM 包装档案采购价 × 用量自动汇总', archiveType: 'oem_package', pick: 'OEM 包装档案' },
  labor: { title: '人工组成', hint: '从已启用的人力成本版本中选择', pick: '人工成本项目' },
};

export interface ProductSection {
  id: string;
  title: string;
  hint?: string;
  /** 旧版里的步骤序号（01 / 02 / 03） */
  step?: string;
  items: readonly LayoutItem[];
}

export interface ProductLayout {
  key: ProductLayoutKey;
  /** 顶部的类型说明（只读，不是输入项）：档案类型、采购方式 */
  header: readonly string[];
  sections: readonly ProductSection[];
}

const F = (field: string, extra: Omit<FieldItem, 'field'> = {}): FieldItem => ({ field, ...extra });
const B = (block: ProductBlock, extra: Omit<BlockItem, 'block'> = {}): BlockItem => ({ block, ...extra });
const S = (id: string, title: string, items: readonly LayoutItem[], extra: { hint?: string; step?: string } = {}): ProductSection => ({ id, title, items, ...extra });

const GIFT_HINT = '两项均填写后才可作为赠品。简称用于组合名称，编码简称用于组合编码；同公司跨档案排重，不修改已生成的组合。';
const CODE_PURCHASED = '编码顺序：外购档案-供货类型（YZ/OEM）-分类-品牌-名称-名称规格+名称单位。系统规格不参与编码。';
const CODE_SELF = '编码顺序：自产档案-分类-品牌-名称-名称规格+名称单位（选填）。可在“人工修正”里手改。';
const LOGISTICS_HINT = '两项费用分别维护、统一汇总，并与当前系统规格和采购价一起留存历史；手工修改后保存会生成新的历史记录。';

const LOGISTICS = S('logistics', '运费与装卸费', [F('freight'), F('handlingFee'), F('zeroValueReason')], { hint: LOGISTICS_HINT });
const TOTAL = S('total', '总成本价', [B('costSummary')], { hint: '采购价 + 运费 + 装卸费' });
const PHOTOS = S('photos', '商品照片', [F('photos')]);
const CATEGORY = S('category', '所属分类', [B('category')]);
const GIFT = S('gift', '赠品简称设置', [F('giftShortName'), F('giftCodeShortName')], { hint: GIFT_HINT });

const RAW: ProductLayout = {
  key: 'raw',
  header: ['archiveType'],
  sections: [
    CATEGORY,
    S('code', '系统自动编号', [B('code')], { hint: '由分类、原料名称、规格和名称单位自动生成' }),
    GIFT,
    S('base', '原料基础信息', [F('name', { label: '原料名称' }), F('specQty', { label: '规格', required: true, help: '与名称单位一起参与编码，如 500 + 克' }), F('specUnit', { label: '名称单位', required: true }), F('materialCode', { label: '原料生产编码', required: false }), F('shape', { whenFilled: true }), F('note'), B('fullName')], { hint: '原料是商品根资料，不包含商品组成。' }),
    S('finished', '原料成品名', [B('finishedNames')], { hint: '原料可对应的成品名（马甲），一行一个；每个成品名按原料规则生成自己的基础信息全名。' }),
    S('sources', '供货来源', [B('supplySources')], { hint: '同一原料可维护多个产区和供应商；系统采用最近更新的有效采购价作为最新成本。' }),
    S('measure', '系统规格与重量', [F('purchaseSpec', { required: true }), B('weight')], { hint: '系统规格用于采购价计量，重量按它自动换算；换算不了时人工修正。' }),
    LOGISTICS, TOTAL, PHOTOS,
  ],
};

const SELF_MADE: ProductLayout = {
  key: 'self_made',
  header: ['archiveType'],
  sections: [
    CATEGORY,
    S('code', '系统自动编号', [B('code')], { hint: CODE_SELF }),
    S('base', '自产成品基础信息', [
      F('name', { label: '商品名称' }), F('brandId', { required: true }),
      F('specQty', { label: '名称规格', required: false, help: '选填；填了会参与编码' }), F('specUnit', { label: '名称单位', required: false }),
      F('productPackagingSpec', { required: true }), F('productPackagingUnit', { required: true }),
      F('shape', { whenFilled: true }), F('note'), B('fullName'),
    ], { step: '01', hint: '维护名称、品牌和产品包装规格；名称规格与名称单位按需填写' }),
    S('production', '生产资料与成本', [B('composition', { groups: ['raw', 'package', 'oem_package', 'labor'] })], { step: '02', hint: '记录自产成品消耗的原料、产品包装和人工成本；选择档案和用量后，采购价、重量及成本会自动汇总' }),
    S('result', '计量与成本结果', [F('purchaseSpec', { required: true }), B('weight'), B('breakdown')], { step: '03', hint: '集中确认系统规格、组成重量和最终采购成本' }),
    LOGISTICS, TOTAL, PHOTOS,
  ],
};

const PURCHASED_BASE = (oem: boolean): ProductSection => S('base', '外购成品基础信息', [
  F('name', { label: '商品名称' }), F('brandId', { required: true }),
  F('specQty', { label: '名称规格', required: true, help: '与名称单位一起参与编码' }), F('specUnit', { label: '名称单位', required: true }),
  F('shape', { whenFilled: true }), F('note'), B('fullName'),
], { step: oem ? '01' : undefined, hint: '维护名称、品牌、名称规格和名称单位' });

const PURCHASED_ORIGINAL: ProductLayout = {
  key: 'purchased_original',
  header: ['archiveType', 'supplyMode'],
  sections: [
    CATEGORY,
    S('code', '系统自动编号', [B('code')], { hint: CODE_PURCHASED }),
    GIFT,
    PURCHASED_BASE(false),
    S('pricing', '采购计价', [F('purchaseSpec', { required: true }), B('weight'), F('supplierId', { help: '' }), F('purchasePrice', { label: '采购价', required: true, help: '按系统规格计价，单位元' })], { hint: '称重重量按名称规格和名称单位自动换算；系统规格用于采购价和后续业务单据。' }),
    LOGISTICS, TOTAL, PHOTOS,
  ],
};

const PURCHASED_OEM: ProductLayout = {
  key: 'purchased_oem',
  header: ['archiveType', 'supplyMode'],
  sections: [
    CATEGORY,
    S('code', '系统自动编号', [B('code')], { hint: CODE_PURCHASED }),
    GIFT,
    PURCHASED_BASE(true),
    S('production', '供应商OEM组成', [B('composition', { groups: ['oem_package'] })], { step: '02', hint: '记录供应商使用公司 OEM 包装形成外购成品的物理组成' }),
    S('pricing', '采购计价', [F('purchaseSpec', { required: true }), B('weight'), F('oemPackageWeightG'), F('supplierId', { help: '' }), F('purchasePrice', { label: '原料采购价', required: true, help: '供应商给的原料价；OEM 包装费用由上面的组成自动加上' }), B('breakdown')], { step: '03', hint: '填写原料采购价，系统自动加上 OEM 包装费用，得出总采购价。' }),
    LOGISTICS, TOTAL, PHOTOS,
  ],
};

const PACKAGE_LIKE = (key: 'package' | 'oem_package'): ProductLayout => ({
  key,
  header: ['archiveType'],
  sections: [
    CATEGORY,
    S('code', key === 'package' ? '产品包装编号' : 'OEM 包装编号', [B('code')], { hint: '系统根据分类、品牌、名称和全部适用容量生成' }),
    S('base', '包装基础信息', [
      F('packagingCategory', { required: true }), F('name', { label: '包装名称' }), F('brandId', { required: true }),
      F('dimensions'), F('dimensionUnit'), F('shape', { whenFilled: true }), F('note'), B('fullName'),
    ], { hint: '只保留建档所需的包装资料' }),
    S('capacities', '容量组', [B('capacities')], { hint: '同一种包装可维护多个容量' }),
    S('production', '生产与重量', [F('printingCompany', { label: '包装印刷公司' }), B('weight', { required: true })], { hint: '记录印刷方和单件重量' }),
    S('stock', '库存与采购价', [F('orderStock'), F('actualStock'), F('purchaseSpec', { required: true }), F('supplierId', { help: '' }), F('purchasePrice', { required: true, help: '按系统规格计价，单位元' })], { hint: '维护库存参数、采购价和库存业务使用的系统规格，不触发自动增减' }),
    LOGISTICS, TOTAL, PHOTOS,
  ],
});

const SHIPPING: ProductLayout = {
  key: 'shipping_material',
  header: ['archiveType'],
  sections: [
    CATEGORY,
    GIFT,
    S('base', '发货物料基础信息', [
      F('name', { label: '物料名称' }), F('brandId', { required: false }),
      F('specQty', { label: '规格数量', required: true, help: '与规格单位一起参与编码' }), F('specUnit', { label: '规格单位', required: true }),
      F('materialCode', { label: '物料生产编码', required: false }), F('shape', { whenFilled: true }), F('note'), B('fullName'),
    ], { hint: '当前档案资料归入已选末级分类，基础字段可在这里维护。' }),
    S('code', '发货物料编号', [B('code')], { hint: '由分类、物料名称、规格和规格单位自动生成' }),
    S('sources', '供货来源', [B('supplySources')], { hint: '同一物料可维护多个产区和供应商；每个来源各有自己的系统规格；系统采用最近更新的有效采购价作为最新成本。' }),
    S('weight', '物料重量', [B('weight', { required: true })]),
    LOGISTICS, TOTAL, PHOTOS,
  ],
};

const CUSTOM: ProductLayout = {
  key: 'custom',
  header: ['archiveType'],
  sections: [
    S('category', '分类与状态', [B('category')], { hint: '商品只能建在最下级分类里，后续可按分类做成本和采购。' }),
    S('code', '商品编号', [B('code')], { hint: '默认自动生成，需要人工修正时点“人工修正”。' }),
    S('base', '基础资料', [
      F('brandId', { required: false }), F('name', { label: '商品名称' }),
      F('specQty', { label: '规格数量', required: true, help: '与规格单位一起参与编码' }), F('specUnit', { label: '单位', required: true }),
      F('shape'), F('note'), B('fullName'), B('weight', { required: true }),
    ], { hint: '名称和规格会参与编号生成；品牌和形态样式是可选编码段，未填写时直接省略。' }),
    S('cost', '采购与成本', [F('supplierId', { help: '' }), F('purchasePrice', { help: '单位元' }), F('freight'), F('handlingFee'), F('zeroValueReason')]),
    TOTAL, PHOTOS,
  ],
};

export const PRODUCT_LAYOUTS: Readonly<Record<ProductLayoutKey, ProductLayout>> = {
  raw: RAW,
  self_made: SELF_MADE,
  purchased_original: PURCHASED_ORIGINAL,
  purchased_oem: PURCHASED_OEM,
  package: PACKAGE_LIKE('package'),
  oem_package: PACKAGE_LIKE('oem_package'),
  shipping_material: SHIPPING,
  custom: CUSTOM,
};

export const productLayout = (values: Record<string, unknown>): ProductLayout => PRODUCT_LAYOUTS[productLayoutKey(values)];

const PRODUCT_DEF = () => FINANCE_RESOURCE_DEFS.find((d) => d.key === 'finance-products')!;
export const productFieldDef = (key: string): FieldDef | undefined => PRODUCT_DEF().fields.find((f) => f.key === key);

/** 每种布局代表的档案类型取值（用来按字段定义里的显示条件筛字段） */
export const LAYOUT_SAMPLE_VALUES: Readonly<Record<ProductLayoutKey, Record<string, unknown>>> = {
  raw: { archiveType: 'raw' }, self_made: { archiveType: 'self_made' },
  purchased_original: { archiveType: 'purchased', supplyMode: 'original_purchase' }, purchased_oem: { archiveType: 'purchased', supplyMode: 'supplier_oem' },
  package: { archiveType: 'package' }, oem_package: { archiveType: 'oem_package' }, shipping_material: { archiveType: 'shipping_material' }, custom: { archiveType: 'custom' },
};

/** 字段定义里的显示条件（showWhen）对这种布局成不成立 */
export function fieldAppliesTo(layoutKey: ProductLayoutKey, key: string): boolean {
  const f = productFieldDef(key);
  if (!f?.showWhen) return true;
  return f.showWhen.in.includes(String(LAYOUT_SAMPLE_VALUES[layoutKey][f.showWhen.field] ?? ''));
}

/** 一个布局里出现的全部字段 key（含功能块包办的；块里按显示条件不适用于这一类的字段不算） */
export function layoutFieldKeys(layout: ProductLayout): string[] {
  const out = new Set<string>(layout.header);
  for (const s of layout.sections) for (const i of s.items) {
    if (isBlock(i)) BLOCK_FIELDS[i.block].filter((k) => fieldAppliesTo(layout.key, k)).forEach((k) => out.add(k)); else out.add(i.field);
  }
  return [...out];
}

/** 这个字段在这种档案类型里叫什么、是否必填（布局覆盖优先，其次字段定义） */
export function layoutFieldMeta(layout: ProductLayout, key: string): { label: string; required: boolean; help?: string } | null {
  const def = productFieldDef(key);
  if (!def) return null;
  for (const s of layout.sections) for (const i of s.items) {
    if (!isBlock(i) && i.field === key) return { label: i.label ?? def.label, required: i.required ?? Boolean(def.required), help: i.help ?? def.help };
  }
  return { label: def.label, required: Boolean(def.required), help: def.help };
}

const present = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'number' && Number.isNaN(v));

export interface ProductProblemContext {
  /** 当前用户能不能填成本（没有 product.cost.edit 时，采购价、运费、装卸费不要求） */
  canCost: boolean;
  /** 已有的（或表单里填好的）供货来源行数 / 构成行数，由界面传入 */
  sources?: Array<{ supplierId?: unknown; originArea?: unknown; systemSpec?: unknown; purchasePrice?: unknown }> | null;
  composition?: Array<{ group: CompositionGroup; id?: unknown; qty?: unknown }> | null;
  /** 编辑已有档案时，状态切换等场景不卡必填（和服务端一致） */
  lenient?: boolean;
}

/**
 * 按旧版 saveProduct 的校验整理出的“逐字段问题”：返回 字段 key → 提示。
 * 功能块的问题用块名当 key（capacities、supplySources、composition）。
 * 服务端仍是最终裁判；这里让表单在提交前就把缺的项标出来。
 */
export function productFormProblems(values: Record<string, unknown>, ctx: ProductProblemContext): Record<string, string> {
  const layout = productLayout(values);
  const out: Record<string, string> = {};
  const keys = new Set(layoutFieldKeys(layout));
  const meta = (k: string) => layoutFieldMeta(layout, k)!;
  const req = (k: string, msg?: string) => { if (keys.has(k) && meta(k).required && !present(values[k])) out[k] = msg ?? `请填写${meta(k).label}`; };
  const t = layout.key;
  if (!present(values.archiveType)) out.archiveType = '请选择档案类型';
  if (t === 'purchased_original' || t === 'purchased_oem') { /* 采购方式由所在入口决定，必有 */ }
  req('categoryId', '请选择最下级分类');
  req('name');
  for (const k of ['brandId', 'packagingCategory', 'productPackagingSpec', 'productPackagingUnit', 'purchaseSpec']) req(k);
  if (t !== 'self_made' && !['package', 'oem_package'].includes(t)) {
    if (!(Number(values.specQty) > 0)) out.specQty = `${meta('specQty').label}必须大于 0`;
    req('specUnit');
  }
  if (['package', 'oem_package'].includes(t)) {
    const lines = String(values.capacities ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!lines.length) out.capacities = '请至少填写一个容量（数量和单位）';
    if (present(values.dimensions) && !present(values.dimensionUnit)) out.dimensionUnit = '填了尺寸，请选择尺寸单位';
    for (const k of ['orderStock', 'actualStock']) if (present(values[k]) && Number(values[k]) < 0) out[k] = '库存不能小于 0';
  }
  // 重量：包装类、发货物料、自建类型手填；原料自动换算也可人工修正；其余自动
  const manualWeight = ['package', 'oem_package', 'shipping_material', 'custom'].includes(t) || values.weightManual === true;
  if (manualWeight && keys.has('weightG')) {
    const w = values.weightG;
    if (!present(w)) out.weightG = '请填写重量';
    else if (Number(w) < 0) out.weightG = '重量不能小于 0';
  }
  if (t === 'raw' && values.weightManual !== true && present(values.purchaseSpec) && values.weightG === undefined) { /* 服务端按系统规格换算 */ }
  if (ctx.canCost) {
    const priced = ['purchased_original', 'purchased_oem', 'package', 'oem_package'].includes(t);
    if (priced && !present(values.purchasePrice)) out.purchasePrice = `请填写${meta('purchasePrice').label}`;
    if (!ctx.lenient && t !== 'self_made') {
      for (const k of ['freight', 'handlingFee']) if (!present(values[k])) out[k] = `请填写${meta(k).label}（没有就填 0 并说明原因）`;
    }
    for (const k of ['purchasePrice', 'freight', 'handlingFee']) if (present(values[k]) && Number(values[k]) < 0) out[k] = `${meta(k).label}不能小于 0`;
  }
  if (t === 'raw' || t === 'shipping_material') {
    const rows = ctx.sources ?? [];
    const bad = ctx.sources === null ? undefined : rows.find((r) => !present(r.supplierId) || !present(r.originArea) || (t === 'shipping_material' && !present(r.systemSpec)) || (ctx.canCost && (!present(r.purchasePrice) || Number(r.purchasePrice) < 0)));
    if (ctx.sources !== null && (!rows.length || bad)) out.supplySources = t === 'raw' ? '请至少维护一条完整供货来源：选择供应商，并填写产区和非负数采购价' : '请至少维护一条完整供货来源：选择供应商，并填写产区、系统规格和非负数采购价';
  }
  if (t === 'self_made') {
    const rows = ctx.composition ?? [];
    if (ctx.composition === null) { /* 没有读取构成的权限：交给服务端 */ }
    else if (!rows.length) out.composition = '请至少增加一条原料、包装或人工成本';
    else if (rows.some((r) => !present(r.id) || !(Number(r.qty) > 0))) out.composition = '原料、包装和人工明细必须选择档案，并填写大于 0 的倍数';
  }
  if (t === 'purchased_oem' && (ctx.composition ?? []).some((r) => !present(r.id) || !(Number(r.qty) > 0))) out.composition = 'OEM 包装明细必须选择档案，并填写大于 0 的用量';
  return out;
}

/** 复制新增时不带到新记录里的字段（旧 sanitizeProductCopy：编号、赠品简称、库存清零、停用信息、最新成本） */
export const COPY_OMIT_FIELDS: readonly string[] = ['code', 'giftShortName', 'giftCodeShortName', 'orderStock', 'actualStock', 'latestUnitCost', 'latestCostType', 'latestCostFrom', 'migrationNotice', 'zeroValueReason', 'basicInfoFullName', 'totalCost', 'photos'];

export type ResolvedNode =
  | { kind: 'field'; field: FieldDef; wide?: boolean }
  | { kind: 'block'; block: ProductBlock; label?: string; required?: boolean; groups?: readonly CompositionGroup[]; /** 这个块包办的字段（已按显示条件、权限筛过） */ fields: FieldDef[] };
export interface ResolvedSection { id: string; title: string; hint?: string; step?: string; nodes: ResolvedNode[] }

/**
 * 把布局按当前取值解析成“这一刻该显示什么”：字段套上这一类的叫法/必填/说明，按显示条件、权限、
 * “有值才显示”筛选，分区标题写进 field.group（详情“编辑本区”和表单分区共用）。
 * 表单、详情都从这里取，所以显示条件只在这一处判断。
 */
export function resolveProductSections(values: Record<string, unknown>, opts: { canUse?: (permission: string) => boolean } = {}): ResolvedSection[] {
  const layout = productLayout(values);
  const canUse = opts.canUse ?? (() => true);
  const applies = (f: FieldDef) => (!f.permission || canUse(f.permission)) && (!f.showWhen || f.showWhen.in.includes(String(values[f.showWhen.field] ?? '')));
  const out: ResolvedSection[] = [];
  for (const s of layout.sections) {
    const nodes: ResolvedNode[] = [];
    for (const i of s.items) {
      if (isBlock(i)) {
        // 供货来源是一组来源行（供应商/产区/规格/采购价），最新采购价由来源汇出，不是档案上直接填的字段
        const fields = (i.block === 'supplySources' ? [] : i.block === 'capacities' ? ['capacities'] : BLOCK_FIELDS[i.block]).map((k) => productFieldDef(k)).filter((f): f is FieldDef => Boolean(f) && applies(f!)).map((f) => ({ ...f, group: s.title }));
        nodes.push({ kind: 'block', block: i.block, label: i.label, required: i.required, groups: i.groups, fields });
        continue;
      }
      const def = productFieldDef(i.field);
      if (!def || !applies(def)) continue;
      if (i.whenFilled && !present(values[i.field])) continue;
      const help = i.help !== undefined ? (i.help || undefined) : def.help;
      nodes.push({ kind: 'field', wide: i.wide, field: { ...def, group: s.title, label: i.label ?? def.label, required: i.required ?? def.required, help } });
    }
    if (nodes.length) out.push({ id: s.id, title: s.title, hint: s.hint, step: s.step, nodes });
  }
  return out;
}
