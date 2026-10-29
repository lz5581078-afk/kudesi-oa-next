import type { FieldDef, Option, ResourceDef } from './resources';

/**
 * 资料页签分类的“有效选项”：代码里写死的选项（系统分类）+ 每个公司自己的配置（改名、排序、隐藏、自建分类）。
 * 前后端共用同一套合并与校验规则；配置存在 resource_category_options 表，只按公司隔离。
 *
 * 规则（写进文档 UI-页签分类管理.md）：
 * - 系统分类（代码选项）：只能改显示名和排序，不能删除、不能隐藏——业务规则可能依赖它们的值。
 * - 自建分类：值（key）自动生成、永不改变；可改名、排序、隐藏；只有零记录在用时才能删除。
 * - 记录里存的永远是值，改名不影响记录；隐藏的分类不出现在新建下拉和页签里，已有记录仍显示（带“已隐藏”）。
 * - 只管理 ResourceDef.tabsBy 对应的 select 字段；tabSplit 拆分页签、q: 快捷页签保持原样。
 */

export const CATEGORY_LABEL_MAX = 20;
/** 每个资料最多自建多少个分类 */
export const CATEGORY_CUSTOM_MAX = 50;
/** 自建分类的值：c_ + 8 位小写字母数字，生成后不再改变 */
export const CUSTOM_CATEGORY_VALUE = /^c_[0-9a-z]{8}$/;

/**
 * 不开放“管理分类”的资料（页签取值本身就是业务结构，不是可随意增减的分类）：
 * - 财务区的 4 个资料：商品档案/商品分类的档案类型有自己的“管理档案类型”和编码规则，费用档案的方向决定收支口径，
 *   单位与规格的“种类”是代码里的结构。
 * - 房间与档案位置：页面是专用看板（区域位置 / 储物空间），没有分类页签。
 */
const UNMANAGED: Readonly<Record<string, string>> = {
  'finance-products': '档案类型有自己的“管理档案类型”入口，且参与商品编码规则',
  'finance-categories': '档案类型参与分类树与编码规则',
  'finance-fee-items': '收支方向决定费用的记账口径',
  'finance-product-units': '种类是代码里的结构',
  locations: '页面是专用看板，没有分类页签',
};

/** 该资料用于“管理分类”的字段（tabsBy 对应的 select 字段）；不开放时返回 undefined */
export function categoryFieldOf(def: Pick<ResourceDef, 'key' | 'tabsBy' | 'fields' | 'tabSplit'>): FieldDef | undefined {
  if (!def.tabsBy || UNMANAGED[def.key]) return undefined;
  const f = def.fields.find((x) => x.key === def.tabsBy);
  if (!f || f.type !== 'select' || f.multi || f.optionsFrom || def.tabSplit) return undefined;
  return f;
}

export function categoryUnmanagedReason(key: string): string | undefined {
  return UNMANAGED[key];
}

/** 数据库里的一行配置（系统分类的行只在改名/排序后才有；hidden 对系统分类无效） */
export interface CategoryRow {
  value: string;
  label: string;
  sortOrder: number;
  hidden: boolean;
  custom: boolean;
}

export interface CategoryOption {
  value: string;
  label: string;
  /** 代码里写死的系统分类 */
  system: boolean;
  hidden: boolean;
  sortOrder: number;
  /** 系统分类的代码默认名（改名后用于对照） */
  defaultLabel?: string;
}

/** 代码选项在没有配置行时的排序基数：第 i 个 = (i+1)*10，自建分类排在后面 */
export const categoryDefaultSort = (index: number) => (index + 1) * 10;

/** 合并代码选项与公司配置，按排序返回（含已隐藏的自建分类，调用方按需过滤） */
export function mergeCategoryOptions(codeOptions: readonly Option[], rows: readonly CategoryRow[] = []): CategoryOption[] {
  const byValue = new Map(rows.map((r) => [r.value, r]));
  const out: Array<CategoryOption & { _i: number }> = [];
  codeOptions.forEach((o, i) => {
    const r = byValue.get(o.value);
    out.push({ value: o.value, label: r?.label?.trim() || o.label, system: true, hidden: false, sortOrder: r ? r.sortOrder : categoryDefaultSort(i), defaultLabel: o.label, _i: i });
  });
  const codeValues = new Set(codeOptions.map((o) => o.value));
  let k = 0;
  for (const r of rows) {
    if (codeValues.has(r.value)) continue;
    out.push({ value: r.value, label: r.label, system: false, hidden: r.hidden, sortOrder: r.sortOrder, _i: 1000 + k++ });
  }
  out.sort((a, b) => a.sortOrder - b.sortOrder || a._i - b._i);
  return out.map(({ _i, ...o }) => o);
}

/** 新建/编辑表单下拉里能选的：不含已隐藏的；current 是记录原来的值（已隐藏也保留，免得编辑别的字段时丢值） */
export function selectableCategories(options: readonly CategoryOption[], current?: string): Option[] {
  return options.filter((o) => !o.hidden || o.value === current).map((o) => ({ value: o.value, label: o.hidden ? `${o.label}（已隐藏）` : o.label }));
}

/** 显示用的完整选项（含已隐藏的，名称带“已隐藏”）：列表单元格、详情、导出、表格编辑解析用 */
export function displayCategories(options: readonly CategoryOption[]): Option[] {
  return options.map((o) => ({ value: o.value, label: o.label }));
}

/** 页面上方页签用：不含已隐藏的 */
export function visibleCategories(options: readonly CategoryOption[]): Option[] {
  return options.filter((o) => !o.hidden).map((o) => ({ value: o.value, label: o.label }));
}

/** 服务端校验用：能新选的值（系统分类 + 未隐藏的自建分类） */
export function allowedCategoryValues(options: readonly CategoryOption[]): string[] {
  return options.filter((o) => !o.hidden).map((o) => o.value);
}

const normalizeLabel = (s: string) => s.normalize('NFKC').trim().toLowerCase();

/** 名称校验：返回错误文案，null 表示可以。others 是同一资料里其它分类（含已隐藏）的名称 */
export function validateCategoryLabel(raw: unknown, others: readonly string[]): string | null {
  if (typeof raw !== 'string') return '请填写分类名称';
  const s = raw.trim();
  if (!s) return '请填写分类名称';
  if (s.length > CATEGORY_LABEL_MAX) return `分类名称不能超过 ${CATEGORY_LABEL_MAX} 个字`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return '分类名称不能含有特殊字符';
  if (normalizeLabel(s) === '全部') return '“全部”是保留名称，请换一个';
  if (others.some((x) => normalizeLabel(x) === normalizeLabel(s))) return '已经有同名的分类了';
  return null;
}

/** 生成一个不和已有值冲突的自建分类值；rnd 可注入（测试用） */
export function generateCategoryValue(taken: ReadonlySet<string>, rnd: () => number = Math.random): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  for (let n = 0; n < 50; n++) {
    let s = 'c_';
    for (let i = 0; i < 8; i++) s += chars[Math.floor(rnd() * chars.length) % chars.length];
    if (!taken.has(s)) return s;
  }
  throw new Error('无法生成不冲突的分类值');
}

/** 能不能隐藏：只有自建分类可以 */
export function categoryHideBlock(o: Pick<CategoryOption, 'system' | 'label'>): string | null {
  return o.system ? `「${o.label}」是系统自带分类，只能改名和调整顺序，不能隐藏` : null;
}

/** 能不能删除：只有“自建且零记录在用”的可以 */
export function categoryDeleteBlock(o: Pick<CategoryOption, 'system' | 'label'>, inUse: number): string | null {
  if (o.system) return `「${o.label}」是系统自带分类，只能改名和调整顺序，不能删除`;
  if (inUse > 0) return `「${o.label}」还有 ${inUse} 条记录在用，不能删除；可以先隐藏，或把这些记录改到别的分类`;
  return null;
}

/** GET resources/category-options 的返回：只含公司有配置的资料 */
export type CategoryOptionsPayload = Record<string, { field: string; rows: CategoryRow[] }>;

/** 页面页签用：某资料的有效选项（没有配置就是代码选项） */
export function effectiveCategoryOptions(def: Pick<ResourceDef, 'key' | 'tabsBy' | 'fields' | 'tabSplit'>, payload: CategoryOptionsPayload | undefined): CategoryOption[] | undefined {
  const f = categoryFieldOf(def);
  if (!f) return undefined;
  return mergeCategoryOptions(f.options ?? [], payload?.[def.key]?.field === f.key ? payload[def.key].rows : []);
}

/** 管理弹窗里一行：有效选项 + 在用数量 */
export interface CategoryManageItem extends CategoryOption {
  count: number;
}
