/**
 * 组合编码/名称的命名规则（命名中心）。
 * 没有规则时用默认格式：ZH-[平台-]主品(*数量)+ZP-赠品[-场景段][-配置号]；名称“组合-主品×数量+赠:赠品”。
 * 有规则时按规则里选的字段拼；规则按主品的分类往上找，下级分类沿用上级的规则。
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

export interface NamingItem {
  code: string; name: string; shortName: string; styleCode: string; spec: string; qty: number;
  categoryCode: string; categoryName: string; brandCode: string; brandName: string; varietyInitials: string; varietyName: string;
  packageType: string; supplyMode: string; weightG: number;
}

export interface NamingInput {
  mains: NamingItem[];
  gifts: NamingItem[];
  platformCode: string;
  platformName: string;
  scenarioSegment: string;
  scenarioName: string;
  configNo: string;
}

const dstr = (n: number) => String(n).replace('.', 'D');
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

export function validateRule(r: { prefix: string; stylePrefix?: string; namePrefix?: string; codeFields: string[]; nameFields: string[]; codeOverrides?: string; nameOverrides?: string }): string | null {
  if (!PREFIX_RE.test(r.prefix)) return '编码前缀要是 1～12 位大写字母或数字，加一个横线结尾，如 ZH-';
  if (r.stylePrefix && !PREFIX_RE.test(r.stylePrefix)) return '款式编码前缀的格式和编码前缀一样，如 ZH-';
  if ((r.namePrefix ?? '').length > 20) return '名称前缀最多 20 个字';
  for (const f of [...r.codeFields, ...r.nameFields]) if (!NAMING_FIELD_KEYS.includes(f)) return `不认识的字段「${f}」`;
  if (r.codeFields.length === 0) return '编码至少要选一个字段';
  for (const text of [r.codeOverrides ?? '', r.nameOverrides ?? '']) {
    for (const line of text.split(/\r?\n/).filter((l) => l.trim())) {
      const m = line.match(/^\s*([A-Za-z]+)\s*=/);
      if (!m || !NAMING_FIELD_KEYS.includes(m[1])) return `改写规则「${line.trim()}」格式不对，应为 字段=文字`;
    }
  }
  return null;
}

const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9+*-]/g, '');
const dedupe = (xs: string[]) => xs.filter((x, i, a) => x && x !== a[i - 1]);

function tok(x: NamingItem) {
  return x.qty === 1 ? x.code : `${x.code}*${dstr(x.qty)}`;
}

/** 默认格式（没有命名规则时） */
export function defaultCompose(i: NamingInput): { code: string; name: string } {
  const plat = i.platformCode.toUpperCase();
  let code = `ZH-${plat && plat !== 'GENERAL' ? `${plat}-` : ''}${i.mains.map(tok).join('+')}`;
  if (i.gifts.length) code += `+ZP-${i.gifts.map(tok).join('+')}`;
  const seg = i.scenarioSegment.toUpperCase();
  if (seg) code += `-${seg}`;
  const cfg = i.configNo;
  if (cfg && cfg !== '01') code += `-${cfg}`;
  const name = `组合-${i.mains.map((m) => (m.qty === 1 ? m.name : `${m.name}×${m.qty}`)).join('+')}${i.gifts.length ? `+赠:${i.gifts.map((g) => g.name).join('+')}` : ''}`.slice(0, 300);
  return { code, name };
}

function codeSegment(field: string, i: NamingInput, rule: NamingRule): string {
  const main = i.mains[0];
  const over = rule.codeOverrides[field];
  if (over !== undefined && over !== '') return clean(over);
  switch (field) {
    case 'category': return clean(main?.categoryCode ?? '');
    case 'platform': return i.platformCode.toUpperCase() === 'GENERAL' ? '' : clean(i.platformCode);
    case 'scenario': return clean(i.scenarioSegment);
    case 'brand': return clean(main?.brandCode ?? '');
    case 'variety': return clean(main?.varietyInitials ?? '');
    case 'packageType': return clean(main?.packageType ?? '');
    case 'supplyMode': return clean(main?.supplyMode ?? '');
    case 'name': return clean(i.mains.map((m) => m.varietyInitials).join('+'));
    case 'shortName': return clean(main?.shortName ?? '');
    case 'style': return clean(i.mains.map((m) => m.styleCode).join('+'));
    case 'baseCode': return i.mains.map(tok).join('+');
    case 'spec': return clean(main?.spec ?? '');
    case 'quantity': return dstr(i.mains.reduce((a, m) => a + m.qty, 0));
    case 'totalSpec': return `${dstr(Math.round(i.mains.reduce((a, m) => a + m.weightG * m.qty, 0)) / 1000)}KG`;
    case 'custom': return clean(rule.customCode);
    default: return '';
  }
}

function nameSegment(field: string, i: NamingInput, rule: NamingRule): string {
  const main = i.mains[0];
  const over = rule.nameOverrides[field];
  if (over !== undefined && over !== '') return over;
  switch (field) {
    case 'category': return main?.categoryName ?? '';
    case 'platform': return i.platformCode.toUpperCase() === 'GENERAL' ? '' : i.platformName;
    case 'scenario': return i.scenarioName;
    case 'brand': return main?.brandName ?? '';
    case 'variety': return main?.varietyName ?? '';
    case 'packageType': return main?.packageType ?? '';
    case 'supplyMode': return main?.supplyMode ?? '';
    case 'name': return i.mains.map((m) => (m.qty === 1 ? m.name : `${m.name}×${m.qty}`)).join('+');
    case 'shortName': return main?.shortName ?? '';
    case 'style': return i.mains.map((m) => m.styleCode).join('+');
    case 'baseCode': return i.mains.map(tok).join('+');
    case 'spec': return main?.spec ?? '';
    case 'quantity': return `×${i.mains.reduce((a, m) => a + m.qty, 0)}`;
    case 'totalSpec': return `${Math.round(i.mains.reduce((a, m) => a + m.weightG * m.qty, 0)) / 1000}KG`;
    case 'custom': return rule.customName;
    default: return '';
  }
}

/** 按规则生成编码、款式编码、名称、简称；规则为空走默认格式。平台“通用”不写进编码；赠品统一加在 +ZP- 之后。 */
export function composeBundle(rule: NamingRule | null, i: NamingInput): { code: string; name: string; styleCode: string; shortName: string } {
  const def = defaultCompose(i);
  const first = i.mains[0];
  const shortName = ((first?.shortName || first?.name || '').slice(0, 30) + (i.gifts.length ? '+赠' : '')).slice(0, 60);
  if (!rule) return { ...def, styleCode: '', shortName };
  const segs = dedupe(rule.codeFields.map((f) => codeSegment(f, i, rule)));
  let code = `${rule.prefix}${segs.join('-')}`;
  if (i.gifts.length) code += `+ZP-${i.gifts.map(tok).join('+')}`;
  const cfg = i.configNo;
  if (cfg && cfg !== '01') code += `-${cfg}`;
  const nameSegs = rule.nameFields.map((f) => nameSegment(f, i, rule)).filter(Boolean);
  let name = `${rule.namePrefix}${nameSegs.join('-')}`;
  if (i.gifts.length) name += `+赠:${i.gifts.map((g) => g.name).join('+')}`;
  const styleSegs = dedupe([clean(i.mains.map((m) => m.styleCode).join('+')), clean(i.platformCode.toUpperCase() === 'GENERAL' ? '' : i.platformCode), clean(i.scenarioSegment)]);
  return { code, name: name.slice(0, 300) || def.name, styleCode: `${rule.stylePrefix || rule.prefix}${styleSegs.join('-')}`, shortName };
}
