/**
 * 组合编码/名称的命名规则（命名中心）——按旧系统的算法恢复：
 *  1. 先把构成合并：同一身份的主品把数量相加；单位可加总（斤、克、千克、个……）的，规格按「总量+单位」合并（5斤×2 合成 10斤），
 *     否则写成「单件规格×数量」；赠品不合并，只按「赠品别名」渲染（名称：简称×数量，编码：编码简称*数量）。
 *  2. 再按命名规则（命名中心里按分类配置，下级沿用上级）里选的字段，逐个主品拼出编码段和名称段。
 *  3. 没有配置规则时用默认规则：ZH- 前缀、名称前缀「组合-」、编码取 品牌+品种+总规格、名称取 分类+品牌+品种+总规格。
 *  平台只加在整个组合编码前面（GENERAL 不加），不进入各个主品的段；赠品统一接在「+ZP-」之后。
 */

export const NAMING_FIELDS: { key: string; label: string }[] = [
  { key: 'category', label: '分类' }, { key: 'platform', label: '销售平台' }, { key: 'scenario', label: '销售场景' },
  { key: 'brand', label: '品牌' }, { key: 'variety', label: '品种' }, { key: 'packageType', label: '包装形态' },
  { key: 'supplyMode', label: '供货方式' }, { key: 'name', label: '商品名称' }, { key: 'shortName', label: '简称' },
  { key: 'style', label: '款式编码' }, { key: 'baseCode', label: '基础编码' }, { key: 'spec', label: '规格' },
  { key: 'quantity', label: '数量' }, { key: 'totalSpec', label: '总规格' }, { key: 'custom', label: '自定义' },
];
export const NAMING_FIELD_KEYS = NAMING_FIELDS.map((f) => f.key);

export interface NamingRule {
  prefix: string;
  namePrefix: string;
  stylePrefix: string;
  codeFields: string[];
  nameFields: string[];
  customCode: string;
  customName: string;
  codeOverrides: Record<string, string>;
  nameOverrides: Record<string, string>;
}

/** 旧系统默认规则：没有给分类配置规则时用它 */
export const DEFAULT_RULE: NamingRule = {
  prefix: 'ZH-', namePrefix: '组合-', stylePrefix: '', codeFields: ['brand', 'variety', 'totalSpec'], nameFields: ['category', 'brand', 'variety', 'totalSpec'],
  customCode: '', customName: '', codeOverrides: {}, nameOverrides: {},
};

export interface NamingItem {
  /** 基础编码记录 id */
  id: number;
  code: string; name: string; shortName: string; styleCode: string; spec: string; qty: number;
  categoryCode: string; categoryName: string; brandCode: string; brandName: string; varietyInitials: string; varietyName: string;
  packageType: string; supplyMode: string; weightG: number;
  /** 真实编码：马甲取它指向的真实基础编码，其余同 code（上传聚水潭子商品用它） */
  realCode?: string;
  /** 规格数量（如 5）与单位（斤）、单位短码（J） */
  amount?: number; unitName?: string; unitCode?: string;
  /** 合并身份：空 = 不跨记录合并 */
  identity?: string;
  /** 是否马甲 */
  isAlias?: boolean;
  /** 赠品别名（没有则不能作赠品） */
  giftName?: string; giftCode?: string;
  /** 品牌可以为空（原料、发货物料类） */
  brandOptional?: boolean;
}

export interface NamingInput {
  mains: NamingItem[];
  gifts: NamingItem[];
  platformCode: string;
  platformName: string;
  scenarioSegment: string;
  scenarioName: string;
  configNo: string;
  /** 组合自己的品牌（覆盖主品品牌，名称/编码里都用它） */
  bundleBrand?: { code: string; name: string } | null;
}

export const PREFIX_RE = /^[A-Z0-9]{1,12}-$/;

export function parseOverrides(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/);
    if (m && NAMING_FIELD_KEYS.includes(m[1])) out[m[1]] = m[2];
  }
  return out;
}

export function parseFieldList(text: string): string[] {
  return [...new Set(text.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean))];
}

export function validateRule(r: { prefix: string; stylePrefix?: string; namePrefix?: string; codeFields: string[]; nameFields: string[]; codeOverrides?: string; nameOverrides?: string; customCode?: string; customName?: string }): string | null {
  if (!PREFIX_RE.test(r.prefix)) return '编码前缀要是 1～12 位大写字母或数字，加一个横线结尾，如 ZH-';
  if (r.stylePrefix && !PREFIX_RE.test(r.stylePrefix)) return '款式编码前缀的格式和编码前缀一样，如 ZH-';
  if ((r.namePrefix ?? '').length > 20) return '名称前缀最多 20 个字';
  if ((r.customName ?? '').length > 80) return '自定义名称最多 80 个字';
  if (r.customCode && !/^[A-Z0-9-]{1,20}$/i.test(r.customCode)) return '自定义编码只允许 20 位以内字母、数字和连字符';
  for (const f of [...r.codeFields, ...r.nameFields]) if (!NAMING_FIELD_KEYS.includes(f)) return `不认识的字段「${f}」`;
  if (r.codeFields.length === 0) return '编码至少要选一个字段';
  if (r.nameFields.length === 0) return '名称至少要选一个字段';
  for (const [text, code] of [[r.codeOverrides ?? '', true], [r.nameOverrides ?? '', false]] as const) {
    for (const line of text.split(/\r?\n/).filter((l) => l.trim())) {
      const m = line.match(/^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/);
      if (!m || !NAMING_FIELD_KEYS.includes(m[1])) return `改写规则「${line.trim()}」格式不对，应为 字段=文字`;
      const v = m[2];
      if (code && v && !/^[A-Za-z0-9]+([-+*][A-Za-z0-9]+)*$/.test(v)) return `编码改写「${line.trim()}」只允许字母、数字及内部连接符 - + *`;
      if (v.length > (code ? 48 : 80)) return `${code ? '编码改写不能超过 48 位' : '名称改写不能超过 80 字'}`;
    }
  }
  return null;
}

// ---------- 合并构成（旧 bundle-composition） ----------

const ADDITIVE = new Set(['斤', '公斤', '千克', '克', 'kg', 'g', '毫克', 'mg', '吨', 't', '升', 'l', '毫升', 'ml', '粒', '棵', '株', '根', '个', '袋', '包', '瓶', '盒', '箱', '罐', '件', '套', '支', '片', '张', '只']);
const numeric = (v: number) => Number(Number(v || 0).toFixed(6));
export const token = (v: string) => String(v || '').toUpperCase().replace(/[^A-Z0-9+*-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
const qtyCode = (v: number) => String(numeric(v)).replace('.', 'P');

export interface ComposedGroup {
  items: NamingItem[];
  first: NamingItem;
  quantity: number;
  /** 汇总规格，如「10斤」或「5斤×2」 */
  spec: string;
  specCode: string;
  singleSpec: string;
  singleSpecCode: string;
  /** 商品名称（合并后）：能加总的把名称里的规格替换成总规格，否则「名称×数量」 */
  displayName: string;
}

function groupsOf(items: NamingItem[], gift: boolean): ComposedGroup[] {
  const map = new Map<string, { items: NamingItem[]; quantity: number; totalAmount: number }>();
  for (const it of items) {
    const key = gift || !it.identity ? `id:${it.id}` : it.identity;
    const amount = it.amount ?? 0;
    const prev = map.get(key);
    if (prev) { prev.items.push(it); prev.quantity = numeric(prev.quantity + it.qty); prev.totalAmount = numeric(prev.totalAmount + amount * it.qty); }
    else map.set(key, { items: [it], quantity: it.qty, totalAmount: numeric(amount * it.qty) });
  }
  return [...map.values()].map(({ items: members, quantity, totalAmount }) => {
    const p = members[0];
    const unitName = p.unitName ?? '', amount = p.amount ?? 0;
    const canSum = ADDITIVE.has(unitName.toLowerCase()) && amount > 0;
    const singleSpec = p.spec || (amount > 0 && unitName ? `${numeric(amount)}${unitName}` : '');
    const spec = canSum ? `${totalAmount}${unitName}` : `${singleSpec}×${numeric(quantity)}`;
    const unitCode = token(p.unitCode ?? '');
    const singleSpecCode = amount > 0 && unitCode ? `${qtyCode(amount)}${unitCode}` : token(p.spec);
    const specCode = canSum ? `${qtyCode(totalAmount)}${unitCode}` : `${singleSpecCode || 'SPEC'}X${qtyCode(quantity)}`;
    const baseName = p.name || p.shortName || '';
    const sourceSpec = [p.spec, `${numeric(amount)}-${unitName}`].find((v) => v && baseName.includes(v));
    const displayName = canSum && sourceSpec ? baseName.replace(sourceSpec, spec) : `${baseName}×${numeric(quantity)}`;
    return { items: members, first: p, quantity, spec, specCode, singleSpec, singleSpecCode, displayName };
  });
}

export interface Composition { mains: ComposedGroup[]; gifts: ComposedGroup[]; specification: string }

export function composeGroups(i: NamingInput): Composition {
  const mains = groupsOf(i.mains, false);
  const gifts = groupsOf(i.gifts, true);
  return { mains, gifts, specification: mains.map((g) => g.spec).join('+') };
}

/** 没有别名的赠品不能用：返回提示文字 */
export function giftAliasIssue(g: NamingItem): string {
  return g.giftName && g.giftCode ? '' : '请先在商品档案填写赠品简称和赠品编码简称';
}

// ---------- 按规则渲染 ----------

export interface Composed { code: string; name: string; styleCode: string; shortName: string; propertiesValue: string; errors: string[] }

const dedupeSegs = (xs: string[]) => xs.filter(Boolean);

function fieldValue(field: string, mode: 'code' | 'name', g: ComposedGroup, i: NamingInput, rule: NamingRule, mainIndex: number): string {
  const p = g.first;
  const code = mode === 'code';
  switch (field) {
    case 'category': return code ? p.categoryCode : p.categoryName;
    case 'platform': return '';
    case 'scenario': return code ? i.scenarioSegment : i.scenarioName;
    case 'brand': return i.bundleBrand && mainIndex >= 0 ? (code ? i.bundleBrand.code : i.bundleBrand.name) : code ? p.brandCode : p.brandName;
    case 'variety': return code ? p.varietyInitials : p.varietyName;
    case 'packageType': return p.packageType;
    case 'supplyMode': return p.supplyMode;
    case 'name': return code ? p.varietyInitials : g.displayName;
    case 'shortName': return code ? p.varietyInitials : p.shortName || p.name;
    case 'style': return p.styleCode;
    case 'baseCode': return p.code;
    case 'spec': return code ? g.singleSpecCode : g.singleSpec;
    case 'quantity': return code ? qtyCode(g.quantity) : String(g.quantity);
    case 'totalSpec': return code ? g.specCode : g.spec;
    case 'custom': return code ? rule.customCode : rule.customName;
    default: return '';
  }
}

function render(g: ComposedGroup, mode: 'code' | 'name', i: NamingInput, rule: NamingRule, mainIndex: number, errors: string[], style = false): string {
  const label = (f: string) => NAMING_FIELDS.find((x) => x.key === f)?.label ?? f;
  const overrides = mode === 'code' ? rule.codeOverrides : rule.nameOverrides;
  const fields = (mode === 'code' ? rule.codeFields : rule.nameFields).filter((f) => f !== 'platform' && (!style || !['quantity', 'totalSpec'].includes(f)));
  const out: string[] = [];
  for (const f of fields) {
    const over = overrides[f]?.trim();
    const value = over || fieldValue(f, mode, g, i, rule, mainIndex);
    // 原料、发货物料类允许没有品牌：只省略空的品牌段
    if (f === 'brand' && !value && g.first.brandOptional && !i.bundleBrand) continue;
    if (!value && f !== 'scenario') errors.push(`${g.first.name || g.first.code}：字段“${label(f)}”未填写${mode === 'code' ? '或缺少短码' : ''}`);
    const rendered = mode === 'code' ? token(value) : value;
    if (value && !rendered) errors.push(`${g.first.name || g.first.code}：所选编码字段缺少有效短码`);
    out.push(rendered);
  }
  return out.filter(Boolean).join('-');
}

/**
 * 按规则生成编码、款式编码、名称、简称、规格值；规则为空走默认规则。
 * errors 非空表示信息不全（缺品牌、缺赠品别名等），调用方应当拒绝保存。
 */
export function composeBundle(ruleIn: NamingRule | null, i: NamingInput): Composed {
  const rule = ruleIn ?? DEFAULT_RULE;
  const errors: string[] = [];
  const c = composeGroups(i);
  const mains = c.mains.map((g, idx) => ({ code: render(g, 'code', i, rule, idx, errors), style: render(g, 'code', i, rule, idx, errors, true), name: render(g, 'name', i, rule, idx, errors) }));
  const gifts = c.gifts.map((g) => {
    const issue = giftAliasIssue(g.first);
    if (issue) { errors.push(`${g.first.name || g.first.code}：${issue}`); return { code: '', name: '' }; }
    return { code: `${g.first.giftCode}*${g.quantity}`, name: `${g.first.giftName}×${g.quantity}` };
  });
  const giftCode = gifts.length ? `+ZP-${gifts.map((g) => g.code).join('+')}` : '';
  const platform = token(i.platformCode);
  const platformPrefix = platform && platform !== 'GENERAL' ? `${platform}-` : '';
  let code = `${rule.prefix}${platformPrefix}${mains.map((m) => m.code).join('+')}`;
  // 规则没选“销售场景”时，非标准场景的段仍要写进编码，否则同一商品在不同场景下编码会重复
  const seg = token(i.scenarioSegment);
  if (seg && !rule.codeFields.includes('scenario')) code += `-${seg}`;
  code += giftCode;
  const cfg = i.configNo;
  if (cfg && cfg !== '01') code += `-${token(cfg)}`;
  const mainStyle = `${rule.stylePrefix || rule.prefix}${mains.map((m) => m.style).join('+')}`;
  const styleCode = mainStyle + giftCode;
  const bodyName = mains.map((m) => m.name).join('+') + (gifts.length ? `+赠:${gifts.map((g) => g.name).join('+')}` : '');
  const name = `${rule.namePrefix}${bodyName}`;
  return {
    code, name: name.slice(0, 255), styleCode, shortName: bodyName.slice(0, 160), propertiesValue: c.specification.slice(0, 255),
    errors: [...new Set(errors)],
  };
}
