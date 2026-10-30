/**
 * 快递价格引擎（沿用旧系统口径，报价按分保留小数，最终售价结算到整数分、重量 kg）：
 *  - 单个版本的价格规则：省份（或全国）+ 重量区间（上下限可以含/不含）+ 固定价或“首重(0/1kg) + 向上取整的续重”
 *  - 每个省取各合作版本里最低的报价 → 典型价估算（相差 15% 内的多数省份均价 ×1.1；6kg 以上凑不成多数时剔除高价尾部）
 *  - 预估运费一览：0~0.5、0.5~1、1~2 … 到单包上限的连续重量段；超过单包上限按拆包求和
 *  - 分区建议：每省每个重量段取最低价，相同来源和价格的省份合并
 * 这里只放纯计算，不碰数据库；上层把“当前版本 + 合作中 + 日期有效”的规则整理成 PriceGroup 再交进来。
 */

import { multiplyUnitCents, sumUnitCents } from './unit-price';

export const ESTIMATE_MAX_WEIGHT_KG = 1000;
export const DEFAULT_RECOMMENDATION_MAX_WEIGHT = 30;

/** 版本里的一条价格规则（已规范化） */
export interface PriceRule {
  /** 'ALL' 或 '全国' 表示全国 */
  province: string;
  start: number;
  /** 无上限用 Infinity */
  end: number;
  startInclusive: boolean;
  endInclusive: boolean;
  formula: boolean;
  /** 固定价，或首重价（分） */
  amount: number;
  /** 续重每 kg（分） */
  continued: number;
  /** 首重 0 或 1（kg） */
  firstWeight: number;
  /** 在版本里的顺序，用来稳定排序 */
  index: number;
  /** 规则说明（给人看） */
  label?: string;
}

/** 一个网点的一个价格版本 */
export interface PriceGroup {
  carrierId: number | string;
  branchId: number | string;
  versionId: number | string;
  carrierName: string;
  branchName: string;
  versionName: string;
  jstLogisticsName?: string;
  /** 版本可发货重量范围；下限含，上限含 */
  limitMin: number;
  limitMax: number;
  rules: PriceRule[];
}

export const provinceKey = (value: unknown) => String(value ?? '').replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市/g, '').trim();
const isNational = (province: unknown) => /^(全国|全部|ALL)$/i.test(String(province ?? '').trim());
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function ruleQuote(rule: PriceRule, weight: number): number {
  return sumUnitCents([rule.amount, rule.formula ? multiplyUnitCents(rule.continued, Math.max(0, Math.ceil(r6(weight - rule.firstWeight)))) : 0]);
}

export function ruleCoversWeight(rule: PriceRule, weight: number): boolean {
  return (rule.startInclusive ? weight >= rule.start : weight > rule.start) && (rule.endInclusive ? weight <= rule.end : weight < rule.end);
}

export function weightAllowed(group: Pick<PriceGroup, 'limitMin' | 'limitMax'>, weight: number): boolean {
  return weight > 0 && weight >= group.limitMin && weight <= group.limitMax;
}

/** 某省、某重量下适用的规则：省份专属 > 全国；区间窄的优先；再按顺序 */
export function applicableRule(rules: PriceRule[], province: string, weight: number): PriceRule | undefined {
  const key = provinceKey(province);
  return rules
    .filter((rule) => (provinceKey(rule.province) === key || isNational(rule.province)) && ruleCoversWeight(rule, weight))
    .sort((a, b) => {
      const specific = (rule: PriceRule) => (isNational(rule.province) ? 1 : 0);
      return specific(a) - specific(b) || a.end - a.start - (b.end - b.start) || a.index - b.index;
    })[0];
}

/** 指定版本、省份、重量的报价；重量超出版本可发货范围或没有适用规则返回 null */
export function quoteForGroup(group: PriceGroup, province: string, weight: number): { cents: number; rule: PriceRule } | null {
  if (!weightAllowed(group, weight)) return null;
  const rule = applicableRule(group.rules, province, weight);
  return rule ? { cents: ruleQuote(rule, weight), rule } : null;
}

export interface BandProvinceQuote {
  province: string;
  /** 分 */
  amount: number;
  carrierId: number | string;
  branchId: number | string;
  versionId: number | string;
  carrierName: string;
  branchName: string;
  versionName: string;
  rule: string;
}

export function describeRule(rule: PriceRule): string {
  const lo = `${rule.startInclusive ? '≥' : '>'}${rule.start}kg`;
  const hi = Number.isFinite(rule.end) ? ` 且 ${rule.endInclusive ? '≤' : '<'}${rule.end}kg` : '';
  const price = rule.formula ? `（首重${rule.firstWeight}kg）` : '';
  return `${lo}${hi}${price}`;
}

const zh = (a: string, b: string) => a.localeCompare(b, 'zh-CN');

/**
 * 某个省在这个重量下各合作版本里的最低报价。
 * bandStart：连续重量段的起点；版本可发货下限必须不高于它，这样整个重量段都能发。
 */
export function cheapestProvinceQuote(groups: PriceGroup[], province: string, weight: number, bandStart: number | null = null): BandProvinceQuote | null {
  if (!(weight > 0)) return null;
  const candidates: BandProvinceQuote[] = [];
  for (const group of groups) {
    if (bandStart !== null && group.limitMin > bandStart) continue;
    const q = quoteForGroup(group, province, weight);
    if (!q) continue;
    candidates.push({
      province, amount: q.cents, carrierId: group.carrierId, branchId: group.branchId, versionId: group.versionId,
      carrierName: group.carrierName, branchName: group.branchName, versionName: group.versionName, rule: describeRule(q.rule),
    });
  }
  candidates.sort((a, b) => a.amount - b.amount || zh(a.carrierName, b.carrierName) || zh(a.province, b.province));
  return candidates[0] ?? null;
}

export type EstimateMethod = 'provincial_majority_mean_plus_10_percent' | 'provincial_upper_trimmed_mean_plus_10_percent' | 'split_parcel_sum';

export interface TypicalEstimate {
  method: EstimateMethod;
  /** 上浮 10% 后的预估价（分） */
  amount: number;
  /** 上浮前的样本均价（分，保留两位小数以内） */
  baseAverage: number;
  sampleCount: number;
  includedCount: number;
  includedProvinces: string[];
  excludedLowProvinces: string[];
  excludedHighProvinces: string[];
}

/**
 * 典型价：先取价格相差不超过 15%、覆盖超过半数省份的最大一组（并列时取均价离中位数最近的）；
 * 凑不成多数且是 6kg 以上时，剔除最高约 20% 的省份报价（孤立的最低价也剔除）再取均价；两种都上浮 10%。不足 3 个省份不估价。
 */
export function estimateTypicalProvinceFreight(provinceQuotes: Array<{ province: string; amount: number }>, opts: { allowHighWeightFallback?: boolean } = {}): TypicalEstimate | null {
  const quotes = (provinceQuotes ?? [])
    .filter((q) => q && Number.isFinite(q.amount) && q.amount >= 0)
    .sort((a, b) => a.amount - b.amount || zh(a.province, b.province));
  if (quotes.length < 3) return null;
  const median = quotes[Math.floor((quotes.length - 1) / 2)].amount;
  let best: { start: number; end: number; group: typeof quotes; average: number; distance: number } | null = null;
  for (let start = 0; start < quotes.length; start++) {
    let end = start;
    while (end + 1 < quotes.length && quotes[end + 1].amount <= quotes[start].amount * 1.15 + 1e-9) end++;
    const group = quotes.slice(start, end + 1);
    const average = group.reduce((sum, q) => sum + q.amount, 0) / group.length;
    const distance = Math.abs(average - median);
    if (!best || group.length > best.group.length || (group.length === best.group.length && distance < best.distance)) best = { start, end, group, average, distance };
  }
  let selected = best!.group;
  let low = quotes.slice(0, best!.start);
  let high = quotes.slice(best!.end + 1);
  let method: EstimateMethod = 'provincial_majority_mean_plus_10_percent';
  if (selected.length <= quotes.length / 2) {
    if (!opts.allowHighWeightFallback) return null;
    const highCount = Math.max(1, Math.floor(quotes.length * 0.2));
    const remaining = quotes.slice(0, -highCount);
    // 孤立的最低价没有代表性；并列的低价保留
    const lowCount = remaining.length > 3 && remaining[0].amount * 1.15 < remaining[1].amount ? 1 : 0;
    selected = remaining.slice(lowCount);
    if (selected.length < 3) return null;
    low = quotes.slice(0, lowCount);
    high = quotes.slice(-highCount);
    method = 'provincial_upper_trimmed_mean_plus_10_percent';
  }
  const average = selected.reduce((sum, q) => sum + q.amount, 0) / selected.length;
  return {
    method, amount: Math.round(average * 1.1 * 100) / 100, baseAverage: Math.round(average * 100) / 100,
    sampleCount: quotes.length, includedCount: selected.length,
    includedProvinces: selected.map((q) => q.province), excludedLowProvinces: low.map((q) => q.province), excludedHighProvinces: high.map((q) => q.province),
  };
}

// ---------- 预估运费一览 ----------

export interface EstimateRow {
  /** "起-止"，如 "1-2" */
  key: string;
  start: number;
  end: number;
  method: EstimateMethod;
  /** 自动估价（分）；无法估价为 null */
  autoAmount: number | null;
  /** 手工金额（分）；null=没有 */
  manualAmount: number | null;
  baseAverage: number | null;
  sampleCount: number;
  includedCount: number;
  includedProvinces: string[];
  excludedLowProvinces: string[];
  excludedHighProvinces: string[];
  provinceQuotes: BandProvinceQuote[];
  /** 超过单包上限时的拆包明细 */
  parcels?: Array<{ count: number; weight: number; amount: number | null; source: 'manual' | 'automatic' | null; key: string | null }>;
  parcelMaxWeight?: number;
}

/** 单包重量段的边界：0、0.5、1、2、…、单包上限 */
export function estimateEdges(parcelLimit: number): number[] {
  return [0, 0.5, ...Array.from({ length: parcelLimit }, (_, i) => i + 1)];
}

export function validParcelLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
}

/** 重量段 (start, end] 的自动估价 */
export function estimateBand(groups: PriceGroup[], provinces: readonly string[], start: number, end: number): EstimateRow {
  const provinceQuotes = provinces.map((p) => cheapestProvinceQuote(groups, p, end, start)).filter((q): q is BandProvinceQuote => q !== null);
  const est = estimateTypicalProvinceFreight(provinceQuotes, { allowHighWeightFallback: start >= 6 });
  return {
    key: `${start}-${end}`, start, end, method: est?.method ?? 'provincial_majority_mean_plus_10_percent', autoAmount: est?.amount ?? null, manualAmount: null,
    baseAverage: est?.baseAverage ?? null, sampleCount: provinceQuotes.length, includedCount: est?.includedCount ?? 0,
    includedProvinces: est?.includedProvinces ?? [], excludedLowProvinces: est?.excludedLowProvinces ?? [], excludedHighProvinces: est?.excludedHighProvinces ?? [], provinceQuotes,
  };
}

/** 单包范围内的所有重量段（不含拆包） */
export function buildEstimateRows(groups: PriceGroup[], provinces: readonly string[], parcelLimit: number): EstimateRow[] {
  if (!validParcelLimit(parcelLimit)) return [];
  const edges = estimateEdges(parcelLimit);
  return edges.slice(1).map((end, i) => ({ ...estimateBand(groups, provinces, edges[i], end), parcelMaxWeight: parcelLimit }));
}

export interface ManualAmount { weightFrom: number; weightTo: number; amountCents: number }

/** 单包重量 weight（≤ 上限）所在的基础重量段 (start, end] */
export function bandOf(weight: number, parcelLimit: number): { start: number; end: number } | null {
  if (!(weight > 0) || weight > parcelLimit) return null;
  const edges = estimateEdges(parcelLimit);
  for (let i = 1; i < edges.length; i++) if (weight > edges[i - 1] && weight <= edges[i]) return { start: edges[i - 1], end: edges[i] };
  return null;
}

/** 在基础重量段里取一个单包重量的价格：手工金额优先，其次自动估价 */
export function resolveBaseAmount(rows: EstimateRow[], weight: number, manual: ManualAmount[] = []): { amount: number; source: 'manual' | 'automatic'; key: string } | null {
  if (!(weight > 0) || weight > ESTIMATE_MAX_WEIGHT_KG) return null;
  const row = rows.find((r) => !r.parcels && weight > r.start && weight <= r.end);
  if (!row) return null;
  const own = row.manualAmount;
  if (own !== null && own !== undefined) return { amount: own, source: 'manual', key: row.key };
  const m = manual.find((o) => weight > o.weightFrom && weight <= o.weightTo);
  if (m) return { amount: m.amountCents, source: 'manual', key: row.key };
  if (row.autoAmount === null || row.autoAmount === undefined) return null;
  return { amount: row.autoAmount, source: 'automatic', key: row.key };
}

/** 超过单包上限的总重量落在哪个拆包段：返回该段终点和拆包构成 */
export function splitParcels(weight: number, parcelLimit: number): { start: number; end: number; parts: Array<{ count: number; weight: number }> } | null {
  if (!(weight > parcelLimit) || weight > ESTIMATE_MAX_WEIGHT_KG) return null;
  const offset = (Math.ceil(r6(weight / parcelLimit)) - 1) * parcelLimit;
  const r = r6(weight - offset);
  const ends = estimateEdges(parcelLimit).slice(1);
  const e = ends.find((x) => x >= r) ?? parcelLimit;
  const end = Math.min(r6(offset + e), ESTIMATE_MAX_WEIGHT_KG);
  // 段的起点是前一个边界
  const prevOffset = r6(offset + (ends[ends.indexOf(e) - 1] ?? 0));
  const start = e === ends[0] ? offset : prevOffset;
  const count = Math.floor(r6(end / parcelLimit));
  const remainder = r6(end - count * parcelLimit);
  return { start, end, parts: [...(count ? [{ count, weight: parcelLimit }] : []), ...(remainder > 0 ? [{ count: 1, weight: remainder }] : [])] };
}

/** 把一个总重量按单包上限拆包后各包的价格合计；任何一包缺价格返回 null */
export function splitParcelAmount(rows: EstimateRow[], weight: number, parcelLimit: number, manual: ManualAmount[] = []): { amount: number; parcels: number; parts: NonNullable<EstimateRow['parcels']> } | null {
  const split = splitParcels(weight, parcelLimit);
  if (!split) return null;
  const parts = split.parts.map((part) => {
    const q = resolveBaseAmount(rows, part.weight, manual);
    return { count: part.count, weight: part.weight, amount: q?.amount ?? null, source: q?.source ?? null, key: q?.key ?? null };
  });
  if (parts.some((p) => p.amount === null)) return null;
  return { amount: sumUnitCents(parts.map(p=>multiplyUnitCents(p.amount as number,p.count))), parcels: parts.reduce((sum, p) => sum + p.count, 0), parts };
}

/** 展开成 1000kg 以内的完整重量段列表：基础段 + 每个拆包段（拆包段不能单独手工调整） */
export function expandParcelEstimates(baseRows: EstimateRow[], parcelLimit: number): EstimateRow[] {
  if (!validParcelLimit(parcelLimit)) return baseRows;
  const base = baseRows.filter((r) => r.end <= parcelLimit && !r.parcels);
  const edges = new Set<number>([parcelLimit, ESTIMATE_MAX_WEIGHT_KG]);
  for (let offset = parcelLimit; offset < ESTIMATE_MAX_WEIGHT_KG; offset += parcelLimit) {
    for (const row of base) {
      const end = r6(offset + row.end);
      if (end <= ESTIMATE_MAX_WEIGHT_KG) edges.add(end);
    }
  }
  const sorted = [...edges].sort((a, b) => a - b);
  const result = [...base];
  for (let i = 1; i < sorted.length; i++) {
    const start = sorted[i - 1], end = sorted[i];
    const count = Math.floor(r6(end / parcelLimit));
    const remainder = r6(end - count * parcelLimit);
    const parcels = [...(count ? [{ count, weight: parcelLimit }] : []), ...(remainder > 0 ? [{ count: 1, weight: remainder }] : [])].map((part) => {
      const q = resolveBaseAmount(base, part.weight);
      return { ...part, amount: q?.amount ?? null, source: q?.source ?? null, key: q?.key ?? null };
    });
    result.push({
      key: `${start}-${end}`, start, end, method: 'split_parcel_sum', manualAmount: null,
      autoAmount: parcels.every((p) => p.amount !== null) ? sumUnitCents(parcels.map(p=>multiplyUnitCents(p.amount as number,p.count))) : null,
      baseAverage: null, sampleCount: 0, includedCount: 0, includedProvinces: [], excludedLowProvinces: [], excludedHighProvinces: [], provinceQuotes: [], parcels, parcelMaxWeight: parcelLimit,
    });
  }
  return result;
}

/** 任意总重量的最终运费：先在基础段里找，超过单包上限就拆包求和；手工金额优先 */
export function freightFromEstimateRows(rows: EstimateRow[], weight: number, parcelLimit: number): { amount: number; source: 'manual' | 'automatic'; method: EstimateMethod | 'manual_override'; parcels?: number } | null {
  if (!(weight > 0) || weight > ESTIMATE_MAX_WEIGHT_KG) return null;
  const base = rows.filter((r) => !r.parcels);
  if (weight <= parcelLimit) {
    const q = resolveBaseAmount(base, weight);
    if (!q) return null;
    const row = base.find((r) => r.key === q.key)!;
    return { amount: q.amount, source: q.source, method: q.source === 'manual' ? 'manual_override' : row.method };
  }
  const split = splitParcelAmount(base, weight, parcelLimit);
  return split ? { amount: split.amount, source: 'automatic', method: 'split_parcel_sum', parcels: split.parcels } : null;
}

// ---------- 分区建议 ----------

export interface RecommendationRow {
  id: string;
  identity: string;
  sourceKey: string;
  province: string;
  rangeStart: number;
  rangeEnd: number;
  startInclusive: boolean;
  endInclusive: boolean;
  /** 固定标准运费（分）；首重续重报价为 null，看 priceLabel */
  amount: number | null;
  priceLabel: string;
  carrierName: string;
  branchName: string;
  jstLogisticsName: string;
  versionName: string;
  rule: string;
  candidateCount: number;
}

const yuan = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

export function buildAutomaticRecommendations(groups: PriceGroup[], provinces: readonly string[], maxWeight = DEFAULT_RECOMMENDATION_MAX_WEIGHT): RecommendationRow[] {
  const maximum = Number(maxWeight);
  if (!Number.isFinite(maximum) || maximum <= 0) return [];
  const sources = groups.filter((g) => g.rules.length > 0);
  const output: RecommendationRow[] = [];
  for (const province of provinces) {
    const provinceSources = sources
      .map((source) => ({ ...source, rules: source.rules.filter((rule) => provinceKey(rule.province) === provinceKey(province) || isNational(rule.province)) }))
      .filter((source) => source.rules.length > 0);
    const bounds = new Set<number>([0, 1, maximum]);
    const terms = new Map<string, { slope: number; intercept: number }>();
    for (const source of provinceSources) {
      bounds.add(source.limitMin);
      if (Number.isFinite(source.limitMax)) bounds.add(source.limitMax);
    }
    for (const source of provinceSources) {
      for (const rule of source.rules) {
        bounds.add(rule.start);
        if (Number.isFinite(rule.end)) bounds.add(rule.end);
        const slope = rule.formula ? rule.continued : 0;
        const intercept = rule.amount - (rule.formula ? rule.firstWeight * slope : 0);
        terms.set(`${slope}|${intercept}`, { slope, intercept });
      }
    }
    // 1kg 以上所有公式都是“向上取整重量”的一次函数，只有各线交叉的整数段附近才可能换最低价
    const equations = [...terms.values()];
    for (let i = 0; i < equations.length; i++) {
      for (let j = i + 1; j < equations.length; j++) {
        const a = equations[i], b = equations[j];
        if (a.slope === b.slope) continue;
        const crossing = (b.intercept - a.intercept) / (a.slope - b.slope);
        if (!Number.isFinite(crossing) || crossing < 1) continue;
        for (const edge of [Math.floor(crossing) - 1, Math.floor(crossing), Math.ceil(crossing)]) if (edge >= 1) bounds.add(edge);
      }
    }
    const edges = [...bounds].filter((e) => e <= maximum).sort((a, b) => a - b);
    let previous: (RecommendationRow & { _end: number }) | null = null;
    const atoms: Array<{ start: number; end: number; weight: number; startInclusive: boolean; endInclusive: boolean }> = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const start = edges[i], end = edges[i + 1];
      if (start > 0) atoms.push({ start, end: start, weight: start, startInclusive: true, endInclusive: true });
      atoms.push({ start, end, weight: (start + end) / 2, startInclusive: false, endInclusive: false });
    }
    // 上限本身单独判断，这样各规则的开闭边界保持原样
    atoms.push({ start: maximum, end: maximum, weight: maximum, startInclusive: true, endInclusive: true });
    for (const { start, end, weight, startInclusive, endInclusive } of atoms) {
      const candidates: Array<{ source: PriceGroup; rule: PriceRule; amount: number }> = [];
      for (const source of provinceSources) {
        if (weight < source.limitMin || weight > source.limitMax) continue;
        const rule = applicableRule(source.rules, province, weight);
        if (rule) candidates.push({ source, rule, amount: ruleQuote(rule, weight) });
      }
      candidates.sort((a, b) => a.amount - b.amount);
      const winner = candidates[0];
      if (!winner) { previous = null; continue; }
      const identity = `${winner.source.carrierId}|${winner.source.branchId}|${winner.source.versionId}|${winner.rule.index}`;
      if (previous && previous.identity === identity && previous._end === start && (previous.endInclusive || startInclusive)) {
        previous._end = end;
        previous.rangeEnd = end;
        previous.endInclusive = endInclusive;
        continue;
      }
      const rule = winner.rule;
      const stepped = rule.formula && rule.continued > 0;
      previous = {
        id: `${province}-${start}-${startInclusive}`, identity, sourceKey: `${winner.source.carrierId}|${winner.source.branchId}|${winner.source.versionId}`, province,
        rangeStart: start, rangeEnd: end, _end: end, startInclusive, endInclusive,
        amount: stepped ? null : ruleQuote(rule, weight),
        priceLabel: stepped ? `首重${rule.firstWeight}kg ${yuan(rule.amount)}元，续重每kg ${yuan(rule.continued)}元` : '',
        carrierName: winner.source.carrierName, branchName: winner.source.branchName, jstLogisticsName: winner.source.jstLogisticsName ?? '',
        versionName: winner.source.versionName, rule: rule.label || describeRule(rule), candidateCount: candidates.length,
      };
      output.push(previous);
    }
  }
  return output.map(({ _end: _drop, ...row }: RecommendationRow & { _end?: number }) => row);
}

export interface RecommendationRule extends Omit<RecommendationRow, 'province'> {
  provinces: string[];
  provinceScope: string;
  suggestedRuleName: string;
  weightStart: number;
  weightStartOperator: '>=' | '>';
  weightEndOperator: '<=' | '<';
  /** 空串=不限 */
  weightEnd: number | '';
}

/** 同来源、同重量段、同价格的省份合并成一条建议规则 */
export function groupAutomaticRecommendations(rows: RecommendationRow[]): RecommendationRule[] {
  const groups = new Map<string, RecommendationRule>();
  for (const row of rows) {
    const key = JSON.stringify([row.rangeStart, Number.isFinite(row.rangeEnd) ? row.rangeEnd : null, row.startInclusive, row.endInclusive, row.sourceKey, row.amount, row.priceLabel]);
    if (!groups.has(key)) {
      const { province: _p, ...rest } = row;
      groups.set(key, { ...rest, provinces: [], provinceScope: '', suggestedRuleName: '', weightStart: row.rangeStart, weightStartOperator: row.startInclusive ? '>=' : '>', weightEndOperator: row.endInclusive ? '<=' : '<', weightEnd: Number.isFinite(row.rangeEnd) ? row.rangeEnd : '' });
    }
    groups.get(key)!.provinces.push(row.province);
  }
  return [...groups.values()].map((row) => ({
    ...row,
    provinces: [...new Set(row.provinces)],
    provinceScope: [...new Set(row.provinces)].join('、'),
    suggestedRuleName: `${row.jstLogisticsName || `${row.carrierName}-${row.branchName}`}-${row.rangeStart}至${Number.isFinite(row.rangeEnd) ? row.rangeEnd : '不限'}kg`,
  }));
}

/** 只用于显示和导出的排序：快递公司 → 网点 → 重量从轻到重 → 省份；不改历史快照 */
export function sortRecommendationRules<T extends { carrierName: string; branchName: string; weightStart: number; weightEnd: number | ''; provinceScope: string; suggestedRuleName: string }>(rows: T[]): T[] {
  const text = (a: string, b: string) => String(a || '').localeCompare(String(b || ''), 'zh-CN');
  const upper = (row: { weightEnd: number | '' }) => (row.weightEnd === '' || row.weightEnd == null ? Infinity : Number(row.weightEnd));
  return [...(rows ?? [])].sort(
    (a, b) => text(a.carrierName, b.carrierName) || text(a.branchName, b.branchName) || Number(a.weightStart) - Number(b.weightStart) || upper(a) - upper(b) || text(a.provinceScope, b.provinceScope) || text(a.suggestedRuleName, b.suggestedRuleName),
  );
}

// ---------- 从资料记录转换 ----------

const dnum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 把“快递价格表”记录的数据转成引擎规则；缺价格返回 null。minExclusive/maxExclusive 没填时上下限都含（与旧口径一致） */
export function ruleFromRecordData(data: Record<string, unknown>, index = 0): PriceRule | null {
  const fixed = dnum(data.fixedPrice);
  const first = dnum(data.firstPrice);
  if (fixed === null && (first === null || dnum(data.firstWeight) === null)) return null;
  const start = dnum(data.shipWeightMin) ?? 0;
  const max = dnum(data.shipWeightMax);
  const rule: PriceRule = {
    province: String(data.province ?? 'ALL'), start, end: max ?? Infinity,
    startInclusive: data.minExclusive !== true, endInclusive: data.maxExclusive !== true,
    formula: fixed === null, amount: fixed ?? (first as number), continued: dnum(data.extraPrice) ?? 0,
    firstWeight: fixed === null ? (dnum(data.firstWeight) as number) : 1, index,
  };
  return rule;
}
