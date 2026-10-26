/**
 * 运费预估（沿用旧系统口径）：
 *  - 单条规则：固定价，或 首重价 + ceil(重量 − 首重) × 续重价
 *  - 选择规则：省份专属 > 全国；重量区间更窄的优先；再次靠前
 *  - 每个省取最便宜的承运商报价；取相互差在 15% 内的最大一簇，均值 ×1.1
 *  - 有效省份样本少于 3 个，返回 null（不猜）
 *  - 超过单包上限（默认 30kg）拆成多包求和；重量 ≤0 或 >1000kg 返回 null
 * 金额一律整数分，重量单位 kg。
 */
export interface ExpressRule {
  carrier: string;
  branch?: string;
  /** 'ALL' = 全国 */
  province: string;
  shipWeightMin?: number | null;
  shipWeightMax?: number | null;
  firstWeight?: number | null;
  firstPriceCents?: number | null;
  extraPriceCents?: number | null;
  fixedPriceCents?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
}

export const MAX_FREIGHT_WEIGHT_KG = 1000;
export const DEFAULT_PARCEL_LIMIT_KG = 30;

export function ruleApplies(rule: ExpressRule, weightKg: number, day?: string): boolean {
  if (weightKg <= 0) return false;
  if (weightKg < (rule.shipWeightMin ?? 0)) return false;
  if (rule.shipWeightMax != null && weightKg > rule.shipWeightMax) return false;
  if (day) {
    if (rule.validFrom && day < rule.validFrom) return false;
    if (rule.validTo && day > rule.validTo) return false;
  }
  return true;
}

/** 单个包裹按一条规则的价格；规则缺价格返回 null */
export function ruleFreightCents(rule: ExpressRule, weightKg: number): number | null {
  if (rule.fixedPriceCents != null) return rule.fixedPriceCents;
  if (rule.firstWeight == null || rule.firstPriceCents == null) return null;
  const over = Math.max(0, Math.ceil(Math.round((weightKg - rule.firstWeight) * 1e6) / 1e6));
  return rule.firstPriceCents + over * (rule.extraPriceCents ?? 0);
}

/** 同一承运商+网点+省份里挑最合适的一条规则 */
export function pickRule(rules: ExpressRule[], weightKg: number, day?: string): ExpressRule | null {
  const ok = rules.filter((r) => ruleApplies(r, weightKg, day) && ruleFreightCents(r, weightKg) !== null);
  if (ok.length === 0) return null;
  const span = (r: ExpressRule) => (r.shipWeightMax ?? Infinity) - (r.shipWeightMin ?? 0);
  return ok
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(b.r.province !== 'ALL') - Number(a.r.province !== 'ALL') || span(a.r) - span(b.r) || a.i - b.i)[0].r;
}

export interface ProvinceQuote { province: string; cents: number; carrier: string }

/** 每个省取最便宜的报价。provinces 为需要覆盖的省份清单。 */
export function provinceQuotes(rules: ExpressRule[], provinces: readonly string[], weightKg: number, day?: string): ProvinceQuote[] {
  const byCarrier = new Map<string, ExpressRule[]>();
  for (const r of rules) {
    const k = `${r.carrier}/${r.branch ?? ''}`;
    byCarrier.set(k, [...(byCarrier.get(k) ?? []), r]);
  }
  const out: ProvinceQuote[] = [];
  for (const province of provinces) {
    let best: ProvinceQuote | null = null;
    for (const list of byCarrier.values()) {
      const rule = pickRule(list.filter((r) => r.province === province || r.province === 'ALL'), weightKg, day);
      const cents = rule ? ruleFreightCents(rule, weightKg) : null;
      if (rule && cents !== null && (best === null || cents < best.cents)) best = { province, cents, carrier: rule.carrier };
    }
    if (best) out.push(best);
  }
  return out;
}

/** 相互差在 15% 内的最大一簇（按价格排序后滑窗）；返回该簇 */
export function majorityCluster(values: number[], tolerance = 0.15): number[] {
  const s = [...values].sort((a, b) => a - b);
  let best: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const group = s.filter((v) => v >= s[i] && v <= s[i] * (1 + tolerance));
    if (group.length > best.length) best = group;
  }
  return best;
}

export type FreightMethod = 'provincial_majority_mean_plus_10_percent' | 'provincial_upper_trimmed_mean_plus_10_percent' | 'manual_override' | 'split_parcel_sum';

export interface FreightEstimate { cents: number; method: FreightMethod; samples: number; parcels?: number }

/** 单包预估（不含拆包） */
export function estimateParcelFreight(rules: ExpressRule[], provinces: readonly string[], weightKg: number, day?: string): FreightEstimate | null {
  if (!(weightKg > 0) || weightKg > MAX_FREIGHT_WEIGHT_KG) return null;
  const quotes = provinceQuotes(rules, provinces, weightKg, day);
  if (quotes.length < 3) return null;
  const cluster = majorityCluster(quotes.map((q) => q.cents));
  if (cluster.length >= 3) {
    const mean = cluster.reduce((a, b) => a + b, 0) / cluster.length;
    return { cents: Math.round(mean * 1.1), method: 'provincial_majority_mean_plus_10_percent', samples: cluster.length };
  }
  // 仅 6kg 以上允许降级：去掉最高 20% 与孤立低价后取均值
  if (weightKg >= 6) {
    const sorted = quotes.map((q) => q.cents).sort((a, b) => a - b);
    const keep = sorted.slice(0, Math.max(3, Math.ceil(sorted.length * 0.8)));
    const median = keep[Math.floor(keep.length / 2)];
    const trimmed = keep.filter((v) => v >= median * 0.5);
    if (trimmed.length >= 3) {
      const mean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
      return { cents: Math.round(mean * 1.1), method: 'provincial_upper_trimmed_mean_plus_10_percent', samples: trimmed.length };
    }
  }
  return null;
}

export interface FreightOverride { weightFrom: number; weightTo: number; amountCents: number }

/** 运费：手工覆盖段优先；超过单包上限拆多包求和 */
export function estimateFreight(
  rules: ExpressRule[],
  provinces: readonly string[],
  weightKg: number,
  opts: { overrides?: FreightOverride[]; parcelLimitKg?: number; day?: string } = {},
): FreightEstimate | null {
  if (!(weightKg > 0) || weightKg > MAX_FREIGHT_WEIGHT_KG) return null;
  const ov = opts.overrides?.find((o) => weightKg > o.weightFrom && weightKg <= o.weightTo);
  if (ov) return { cents: ov.amountCents, method: 'manual_override', samples: 0 };
  const limit = opts.parcelLimitKg ?? DEFAULT_PARCEL_LIMIT_KG;
  if (weightKg <= limit) return estimateParcelFreight(rules, provinces, weightKg, opts.day);
  const full = Math.floor(weightKg / limit);
  const rest = Math.round((weightKg - full * limit) * 1e6) / 1e6;
  const big = estimateParcelFreight(rules, provinces, limit, opts.day);
  if (!big) return null;
  let cents = big.cents * full;
  let parcels = full;
  if (rest > 0) {
    const small = estimateParcelFreight(rules, provinces, rest, opts.day);
    if (!small) return null;
    cents += small.cents;
    parcels += 1;
  }
  return { cents, method: 'split_parcel_sum', samples: big.samples, parcels };
}

export interface ZoneSuggestion {
  carrier: string;
  branch: string;
  weightStart: number;
  weightEnd: number;
  /** 段上限重量下的报价，分 */
  cents: number;
  provinces: string[];
  /** 建议规则名称：快递/网点 + 重量段 + 省份（省份多时写“N个省”） */
  suggestedName: string;
}

/**
 * 聚水潭快递分区建议（沿用旧系统口径）：
 *  - 只看生效日期内、允许该重量发货的价格；按各规则的重量边界把 0~maxWeight 切成若干段
 *  - 每个省、每个重量段选报价最低的快递+网点（报价按该段上限重量计，首重续重按实际重量计费，只作参考）
 *  - 快递网点、重量段、报价都相同的省份合并成一条建议
 *  - 排序：快递/网点 → 重量从轻到重 → 省份。这只是录入聚水潭的参考清单，不会自动写入。
 */
export function zoneSuggestions(rules: ExpressRule[], provinces: readonly string[], maxWeightKg: number, day?: string): ZoneSuggestion[] {
  if (!(maxWeightKg > 0)) return [];
  const cuts = new Set<number>([0, maxWeightKg]);
  for (const r of rules) {
    for (const v of [r.shipWeightMin, r.shipWeightMax]) if (v != null && v > 0 && v < maxWeightKg) cuts.add(v);
  }
  const edges = [...cuts].sort((a, b) => a - b);
  const byBranch = new Map<string, ExpressRule[]>();
  for (const r of rules) byBranch.set(`${r.carrier}/${r.branch ?? ''}`, [...(byBranch.get(`${r.carrier}/${r.branch ?? ''}`) ?? []), r]);
  const merged = new Map<string, ZoneSuggestion>();
  for (let i = 0; i + 1 < edges.length; i++) {
    const start = edges[i], end = edges[i + 1];
    for (const province of provinces) {
      let best: { key: string; rule: ExpressRule; cents: number } | null = null;
      for (const [key, list] of byBranch) {
        const rule = pickRule(list.filter((r) => r.province === province || r.province === 'ALL'), end, day);
        // 该规则必须覆盖整段：段起点也要在规则的发货范围内
        if (!rule || (rule.shipWeightMin ?? 0) > start) continue;
        const cents = ruleFreightCents(rule, end);
        if (cents !== null && (best === null || cents < best.cents)) best = { key, rule, cents };
      }
      if (!best) continue;
      const mk = `${best.key}|${start}|${end}|${best.cents}`;
      const cur = merged.get(mk) ?? { carrier: best.rule.carrier, branch: best.rule.branch ?? '', weightStart: start, weightEnd: end, cents: best.cents, provinces: [], suggestedName: '' };
      cur.provinces.push(province);
      merged.set(mk, cur);
    }
  }
  const order = new Map(provinces.map((p, i) => [p, i]));
  return [...merged.values()]
    .map((s) => ({ ...s, provinces: s.provinces.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)) }))
    .map((s) => ({ ...s, suggestedName: `${s.carrier}${s.branch ? `-${s.branch}` : ''} ${s.weightStart}~${s.weightEnd}kg ${s.provinces.length > 3 ? `${s.provinces.length}个省` : s.provinces.join('、')}` }))
    .sort((a, b) => `${a.carrier}/${a.branch}`.localeCompare(`${b.carrier}/${b.branch}`, 'zh') || a.weightStart - b.weightStart || a.weightEnd - b.weightEnd || a.provinces[0].localeCompare(b.provinces[0], 'zh'));
}
