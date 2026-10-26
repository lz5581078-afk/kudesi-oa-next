import { yuanToPreciseCents } from '@kudesi/shared';
import { readZipEntries } from '../resources/xlsx-lite';

/** “2026年03月12日”“2026.3.12”统一成 YYYY-MM-DD；认不出来返回空 */
function normalizeDate(input: unknown): string {
  if (typeof input !== 'string') return '';
  const m = input.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
  if (!m) return '';
  const month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 快递价格表 / 临时加收通知的 AI 识别：提示词、读 Excel/CSV 文字、把模型返回的 JSON 整理成可入库的草稿（金额转成分）。
 * 草稿一律交给人核对后才入库；认不准的行带 warnings，前端默认不勾选。
 */
export type RecognitionKind = 'price_table' | 'surcharge_notice';

export const PRICE_TABLE_PROMPT = `你是电商快递价格表录入助手。请识别快递价格表，只返回 JSON，不要解释。
字段格式：
{
  "priceRows": [
    {
      "province": "省份或区域",
      "price500g": 1.25, "price1kg": 1.55, "price2kg": 2.5, "price3kg": 3, "price3_2kg": 3,
      "price4kg": "", "price5kg": "", "price6kg": "", "commonPrice": "",
      "priceRules": [
        {"weightScope":"3.21-7kg","baseAmount":6.8,"ruleType":"fixed"},
        {"weightScope":"7.01-30kg","ruleType":"formula","firstWeightType":"0","firstWeightAmount":3.5,"continuedWeightAmount":0.5}
      ],
      "remark": "原文备注或口径"
    }
  ],
  "effectiveStart": "生效日期 YYYY-MM-DD，无法识别留空",
  "effectiveEnd": "失效日期 YYYY-MM-DD，长期留空",
  "extraRemark": "除价格规则外识别到的合作口径、退改费、其他费用、对账说明、特殊提醒等附加内容，整理成多行条目；没有则留空",
  "rawText": "可读原文汇总",
  "confidence": 0.0
}
要求：
1. 每个省份/区域只返回一行；价格单位是元，数字不要带单位。
2. 0-0.5kg、0.51-1kg、1.01-2kg、2.01-3kg、2.01-3.2kg、3.01-4kg、4.01-5kg、5.01-6kg、通用价，优先分别填写到 price500g、price1kg、price2kg、price3kg、price3_2kg、price4kg、price5kg、price6kg、commonPrice。
3. 非标准区间统一价，例如 3.21-7kg 固定 6.8 元，放到 priceRules，ruleType 使用 fixed，填写 weightScope 和 baseAmount。
4. “多少重量之后，首重多少钱，续重多少钱”的公式，放到 priceRules，ruleType 使用 formula，填写 weightScope、firstWeightType（0 或 1）、firstWeightAmount、continuedWeightAmount。
5. 小数重量或非整数区间必须保留，不要强行归入整数公斤。看不清的字段留空，不要猜。
6. extraRemark 必须整理成清晰条目，如“退改费用：...”“对账口径：...”“特殊提醒：...”，该换行就换行。`;

export const SURCHARGE_PROMPT = `你是电商快递费用规则录入助手。请识别快递临时加收通知，只返回 JSON，不要解释。
字段格式：
{
  "batchName": "本次加收通知名称，请根据通知标题或主要区域/原因提炼",
  "surcharges": [
    {
      "surchargeName": "加收名称或通知标题",
      "effectiveStart": "开始日期 YYYY-MM-DD",
      "effectiveEnd": "结束日期 YYYY-MM-DD，长期留空",
      "areaScope": "适用省份或区域，多个用、分隔；全部省份填 全部省份",
      "provinceList": ["新疆", "西藏"],
      "chargeType": "fixed|percent|per_kg",
      "amount": 1.5,
      "weightMode": "all|below|above|between",
      "weightStart": 1,
      "weightEnd": 5,
      "remark": "原文备注或口径"
    }
  ],
  "rawText": "可读原文汇总",
  "confidence": 0.0
}
要求：
1. 每次上传是一份加收通知批次，batchName 要像“广西云南临时加收通知”这样方便后续查找。
2. 每条加收规则必须拆分出省份、日期、重量范围、加收方式和加收值，不能只把整段原文塞到备注。
3. 如果一条规则适用于多个省份，provinceList 返回省份数组。
4. chargeType 只能使用 fixed 固定金额、percent 按比例（amount 填百分数）、per_kg 按公斤。
5. weightMode 使用 all 全段、below 多少公斤以内、above 多少公斤以上、between 区间；能识别出数字时填 weightStart/weightEnd。
6. 金额看不清不要猜，留 0。`;

// ---------- 数字与重量范围 ----------

const toNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^\d.\-]/g, ''));
    return v.trim() && /\d/.test(v) && Number.isFinite(n) ? n : null;
  }
  return null;
};
const toCents = (v: unknown): number | null => {
  const n = toNum(v);
  if(n===null)return null;
  try{return yuanToPreciseCents(n);}catch{return null;}
};
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());

export interface WeightRange { start: number; end: number | null; startInclusive: boolean; endInclusive: boolean }

/** 把“3.21-7kg”“7kg以上”“≤2kg”“通用”这类文字读成重量范围；读不出返回 null（沿用旧系统的口径） */
export function parseWeightScope(raw: string): WeightRange | null {
  const t = String(raw ?? '').split(/[（(]/)[0].replace(/\s/g, '').replace(/公斤/g, 'kg');
  if (!t) return null;
  const startInclusive = !/超过|大于|>(?!=)/.test(t);
  const endInclusive = !/小于|<(?!=)/.test(t);
  const lower = t.match(/(?:>=?|≥)(\d+(?:\.\d+)?)(kg|g|克)?/i);
  const upper = t.match(/(?:<=?|≤)(\d+(?:\.\d+)?)(kg|g|克)?/i);
  const kg = (m: RegExpMatchArray) => Number(m[1]) * (/^(g|克)$/i.test(m[2] ?? '') ? 0.001 : 1);
  if (lower && upper) {
    const s = kg(lower), e = kg(upper);
    return e > s ? { start: s, end: e, startInclusive, endInclusive } : null;
  }
  if (/^(通用|全重量段|不限重量)$/.test(t)) return { start: 0, end: null, startInclusive: true, endInclusive: true };
  const values = [...t.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (!values.length) return null;
  const scale = /克|\dg\b/i.test(t) && !/kg/i.test(t) ? 0.001 : 1;
  if (/以上|起|后|超过|大于|>|≥/.test(t)) return { start: values[0] * scale, end: null, startInclusive, endInclusive: true };
  if (/以内|以下|内|≤|<=/.test(t) || values.length === 1) return { start: 0, end: values[values.length - 1] * scale, startInclusive: true, endInclusive };
  const s = values[0] * scale, e = values[1] * scale;
  return e > s ? { start: s, end: e, startInclusive, endInclusive } : null;
}

// ---------- 价格表草稿 ----------

export interface PriceRuleDraft {
  province: string;
  shipWeightMin: number;
  shipWeightMax: number | null;
  minExclusive: boolean;
  maxExclusive: boolean;
  fixedPrice: number | null;
  firstWeight: number | null;
  firstPrice: number | null;
  extraPrice: number | null;
  warnings: string[];
}

export interface PriceTableDraft {
  rows: PriceRuleDraft[];
  warnings: string[];
  effectiveStart: string;
  effectiveEnd: string;
  extraRemark: string;
  confidence: number;
}

/** 旧系统的固定档位列：[字段, 起, 止, 起是否含] */
const STANDARD_COLUMNS: Array<[string[], number, number | null, boolean]> = [
  [['price500g', 'price_500g'], 0, 0.5, true],
  [['price1kg', 'price_1kg'], 0.5, 1, false],
  [['price2kg', 'price_2kg'], 1, 2, false],
  [['price3kg', 'price_3kg'], 2, 3, false],
  [['price3_2kg', 'price_3_2kg'], 2, 3.2, false],
  [['price4kg', 'price_4kg'], 3, 4, false],
  [['price5kg', 'price_5kg'], 4, 5, false],
  [['price6kg', 'price_6kg'], 5, 6, false],
  [['commonPrice', 'common_price'], 0, null, true],
];

/** 一个省份单元格拆成若干标准省份：“新疆、西藏”“全国”“广东省” */
export function splitProvinces(value: unknown, provinces: readonly string[]): { names: string[]; unknown: string[] } {
  const names: string[] = [];
  const unknown: string[] = [];
  const list = Array.isArray(value) ? value.map(text) : text(value).split(/[、,，;；/\s]+/);
  for (const part of list.filter(Boolean)) {
    if (/^(全国|全部|全部省份|ALL)$/i.test(part)) { names.push('ALL'); continue; }
    const hit = provinces.find((p) => part === p || part.replace(/省|市|自治区|特别行政区|壮族|回族|维吾尔/g, '') === p || part.startsWith(p));
    if (hit) names.push(hit); else unknown.push(part);
  }
  return { names: [...new Set(names)], unknown };
}

export function normalizePriceTable(raw: Record<string, unknown>, provinces: readonly string[]): PriceTableDraft {
  const warnings: string[] = [];
  const list = Array.isArray(raw.priceRows) ? raw.priceRows : Array.isArray(raw.rows) ? raw.rows : [];
  const rows: PriceRuleDraft[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const { names, unknown } = splitProvinces(r.province ?? r.area, provinces);
    const rowWarnings: string[] = [];
    if (unknown.length) rowWarnings.push(`省份「${unknown.join('、')}」不在省份清单里，已忽略`);
    if (!names.length) {
      warnings.push(`有一行省份没认出来（${text(r.province ?? r.area) || '空'}），已跳过`);
      continue;
    }
    const push = (partial: Omit<PriceRuleDraft, 'province' | 'warnings'>, extra: string[] = []) => {
      for (const province of names) rows.push({ province, ...partial, warnings: [...rowWarnings, ...extra] });
    };
    for (const [keys, start, end, startInc] of STANDARD_COLUMNS) {
      const cents = toCents(keys.map((k) => r[k]).find((v) => v !== undefined && v !== ''));
      if (cents === null) continue;
      push({ shipWeightMin: start, shipWeightMax: end, minExclusive: !startInc, maxExclusive: false, fixedPrice: cents, firstWeight: null, firstPrice: null, extraPrice: null });
    }
    const rules = (r.priceRules ?? r.price_rules ?? r.extraRanges ?? r.extra_ranges) as unknown;
    for (const rule of Array.isArray(rules) ? rules : []) {
      if (!rule || typeof rule !== 'object') continue;
      const x = rule as Record<string, unknown>;
      const range = parseWeightScope(text(x.weightScope ?? x.weight_scope));
      if (!range) { rowWarnings.push(`重量范围「${text(x.weightScope) || '空'}」没读懂，这条规则已跳过`); continue; }
      const formula = (x.ruleType ?? x.price_rule_type) === 'formula' || toNum(x.continuedWeightAmount ?? x.continued_weight_amount) !== null;
      const common = { shipWeightMin: range.start, shipWeightMax: range.end, minExclusive: !range.startInclusive, maxExclusive: !range.endInclusive };
      if (formula) {
        const first = text(x.firstWeightType ?? x.first_weight_type);
        const firstCents = toCents(x.firstWeightAmount ?? x.first_weight_amount ?? x.baseAmount);
        const extra = toCents(x.continuedWeightAmount ?? x.continued_weight_amount);
        const ws: string[] = [];
        if (first !== '0' && first !== '1') ws.push('首重不是 0 或 1 公斤，请核对');
        if (firstCents === null || extra === null) ws.push('首重价或续重价缺失');
        push({ ...common, fixedPrice: null, firstWeight: first === '0' ? 0 : 1, firstPrice: firstCents, extraPrice: extra }, ws);
      } else {
        const cents = toCents(x.baseAmount ?? x.base_amount ?? x.amount);
        push({ ...common, fixedPrice: cents, firstWeight: null, firstPrice: null, extraPrice: null }, cents === null ? ['固定价缺失'] : []);
      }
    }
    const hasAny = rows.some((x) => x.province === names[0]);
    if (!hasAny) warnings.push(`「${names.join('、')}」没有识别出任何价格`);
  }
  // 每行价格是否齐全
  for (const row of rows) {
    if (row.fixedPrice === null && (row.firstPrice === null || row.extraPrice === null)) row.warnings.push('价格不全');
  }
  if (!rows.length) warnings.push('没有识别出价格行');
  const conf = Number(raw.confidence);
  return {
    rows, warnings, effectiveStart: normalizeDate(raw.effectiveStart), effectiveEnd: normalizeDate(raw.effectiveEnd),
    extraRemark: text(raw.extraRemark ?? raw.extra_remark).slice(0, 5000), confidence: Number.isFinite(conf) ? conf : 0.78,
  };
}

// ---------- 加收通知草稿 ----------

export interface SurchargeDraft {
  name: string;
  effectiveStart: string;
  effectiveEnd: string;
  areaScope: string;
  chargeType: 'fixed' | 'percent' | 'per_kg';
  /** 分；percent 时为 null */
  amount: number | null;
  percent: number | null;
  weightMode: 'all' | 'below' | 'above' | 'between';
  weightStart: number | null;
  weightEnd: number | null;
  warnings: string[];
}

export interface SurchargeNoticeDraft { batchName: string; rows: SurchargeDraft[]; warnings: string[] }

export function normalizeSurchargeNotice(raw: Record<string, unknown>, provinces: readonly string[]): SurchargeNoticeDraft {
  const warnings: string[] = [];
  const list = Array.isArray(raw.surcharges) ? raw.surcharges : [];
  const rows: SurchargeDraft[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const rw: string[] = [];
    const type = ['fixed', 'percent', 'per_kg'].includes(text(r.chargeType ?? r.charge_type)) ? (text(r.chargeType ?? r.charge_type) as SurchargeDraft['chargeType']) : 'fixed';
    const value = toNum(r.amount ?? r.value);
    if (value === null || value <= 0) rw.push('加收金额没识别出来');
    let modeRaw = text(r.weightMode ?? r.weight_mode);
    const ws = toNum(r.weightStart ?? r.weight_start), we = toNum(r.weightEnd ?? r.weight_end);
    if (!['all', 'below', 'above', 'between'].includes(modeRaw)) modeRaw = ws !== null && we !== null ? 'between' : we !== null ? 'below' : ws !== null ? 'above' : 'all';
    const mode = modeRaw as SurchargeDraft['weightMode'];
    if (mode === 'between' && (ws === null || we === null || we <= ws)) rw.push('区间重量没识别全');
    if (mode === 'below' && we === null) rw.push('“以内”的重量没识别出来');
    if (mode === 'above' && ws === null) rw.push('“以上”的重量没识别出来');
    // 适用省份：provinceList 优先，其次 areaScope 文字；一条规则多个省份时每个省份一条
    const fromList = Array.isArray(r.provinceList ?? r.province_list) ? (r.provinceList ?? r.province_list) : text(r.areaScope ?? r.area_scope ?? r.province ?? r.area);
    const { names, unknown } = splitProvinces(fromList, provinces);
    if (unknown.length) rw.push(`省份「${unknown.join('、')}」不在省份清单里，已忽略`);
    const targets = names.length ? names : ['ALL'];
    if (!names.length) rw.push('没有识别出适用省份，按“全部省份”处理，请核对');
    for (const area of targets) {
      rows.push({
        name: (text(r.surchargeName ?? r.surcharge_name ?? r.name) || '临时加收').slice(0, 160),
        effectiveStart: normalizeDate(r.effectiveStart ?? r.effective_start), effectiveEnd: normalizeDate(r.effectiveEnd ?? r.effective_end),
        areaScope: area === 'ALL' ? '全部省份' : area, chargeType: type,
        amount: type === 'percent' ? null : value === null ? null : Math.round(value * 100), percent: type === 'percent' ? value : null,
        weightMode: mode, weightStart: mode === 'below' || mode === 'all' ? null : ws, weightEnd: mode === 'above' || mode === 'all' ? null : we, warnings: [...rw],
      });
    }
  }
  if (!rows.length) warnings.push('没有识别出加收规则');
  return { batchName: text(raw.batchName ?? raw.batch_name).slice(0, 160), rows, warnings };
}

// ---------- 读文件 ----------

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** xlsx → 制表符分隔的文字（每个工作表一段）。只读文字和数字，不执行公式。 */
export function xlsxToText(buf: Buffer): string {
  const entries = readZipEntries(buf);
  const shared: string[] = [];
  for (const m of (entries['xl/sharedStrings.xml'] ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(unescapeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  }
  const sections: string[] = [];
  for (const name of Object.keys(entries).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()) {
    const lines: string[] = [];
    for (const row of entries[name].matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], body = c[2] ?? '';
        const t = attrs.match(/t="(\w+)"/)?.[1];
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (t === 's') cells.push(shared[Number(v)] ?? '');
        else if (t === 'inlineStr') cells.push(unescapeXml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
        else cells.push(v === undefined ? '' : unescapeXml(v));
      }
      if (cells.some(Boolean)) lines.push(cells.join('\t'));
    }
    if (lines.length) sections.push(`【${name.replace(/^.*\//, '')}】\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}
