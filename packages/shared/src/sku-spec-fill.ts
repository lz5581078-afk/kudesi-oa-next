/** SKU 申请“AI 一键填写”的确定性部分：从商品规格里读重量，把目标重量用已选商品的重量精确凑出来。AI 只负责读规格名称，加法都在这里算。 */

const UNIT_GRAMS: Record<string, number> = { 千克: 1000, 公斤: 1000, kg: 1000, 斤: 500, 克: 1, g: 1 };
const WEIGHT_RE = /(\d+(?:\.\d+)?)\s*(千克|公斤|kg|斤|克|g)(?![a-z])/gi;

/** 从一段文字里读出重量（克）。读到多个不同重量时返回 null（不猜）。 */
export function parseWeightGrams(text: string | null | undefined): number | null {
  if (!text) return null;
  const found = new Set<number>();
  for (const m of String(text).matchAll(WEIGHT_RE)) {
    const grams = Math.round(Number(m[1]) * (UNIT_GRAMS[m[2].toLowerCase()] ?? 0));
    if (Number.isFinite(grams) && grams > 0) found.add(grams);
  }
  return found.size === 1 ? [...found][0] : null;
}

export interface WeightOption { id: number; grams: number }
export interface WeightCombo { lines: Array<{ id: number; qty: number }>; pieces: number; /** 还有别的同样件数的凑法 */ ambiguous: boolean }

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
export const MAX_COMBINE_UNITS = 200_000;

/** 用 options 里的重量凑出 targetGrams：件数最少；凑不出来返回 null。 */
export function combineWeights(targetGrams: number, options: WeightOption[]): WeightCombo | null {
  if (!Number.isInteger(targetGrams) || targetGrams <= 0) return null;
  const opts = [...new Map(options.filter((o) => Number.isInteger(o.grams) && o.grams > 0).map((o) => [o.id, o])).values()].sort((a, b) => b.grams - a.grams || a.id - b.id);
  if (!opts.length) return null;
  const g = opts.reduce((acc, o) => gcd(acc, o.grams), 0);
  if (targetGrams % g) return null;
  const T = targetGrams / g;
  if (T > MAX_COMBINE_UNITS) return null;
  const w = opts.map((o) => o.grams / g);
  const INF = Number.MAX_SAFE_INTEGER;
  // 最少件数 + 取到最少件数时选的商品
  const best = new Array<number>(T + 1).fill(INF), pick = new Array<number>(T + 1).fill(-1);
  best[0] = 0;
  for (let t = 1; t <= T; t++) for (let i = 0; i < w.length; i++) if (w[i] <= t && best[t - w[i]] + 1 < best[t]) { best[t] = best[t - w[i]] + 1; pick[t] = i; }
  if (best[T] === INF) return null;
  // 最少件数的不同凑法数（同一组商品只算一种），超过 1 就提示人工确认
  const b2 = new Array<number>(T + 1).fill(INF), ways = new Array<number>(T + 1).fill(0);
  b2[0] = 0; ways[0] = 1;
  for (let i = 0; i < w.length; i++) for (let t = w[i]; t <= T; t++) {
    const c = b2[t - w[i]] + 1;
    if (b2[t - w[i]] === INF) continue;
    if (c < b2[t]) { b2[t] = c; ways[t] = ways[t - w[i]]; } else if (c === b2[t]) ways[t] = Math.min(2, ways[t] + ways[t - w[i]]);
  }
  const qty = new Map<number, number>();
  for (let t = T; t > 0; t -= w[pick[t]]) qty.set(opts[pick[t]].id, (qty.get(opts[pick[t]].id) ?? 0) + 1);
  return { lines: opts.filter((o) => qty.has(o.id)).map((o) => ({ id: o.id, qty: qty.get(o.id)! })), pieces: best[T], ambiguous: ways[T] > 1 };
}

export interface SkuFillCandidate { id: number; spec?: string | null; name?: string | null }
export interface SkuFillInput { name: string; mainGrams: number | null; giftGrams: number | null }
export interface SkuFillResult {
  name: string;
  main: Array<{ baseCodeId: number; qty: number }>; gift: Array<{ baseCodeId: number; qty: number }>;
  /** 需要人工特别留意的地方；空表示按名称里的重量全部凑出 */
  warnings: string[];
}

const weightOf = (c: SkuFillCandidate) => parseWeightGrams(c.spec) ?? parseWeightGrams(c.name);
const fmt = (g: number) => (g % 1000 === 0 ? `${g / 1000}kg` : `${g}g`);

/** 按规格名称里的重量，从选好的主商品/赠品里组合出数量；凑不出来的留空并提示。 */
export function fillSpecs(inputs: SkuFillInput[], mains: SkuFillCandidate[], gifts: SkuFillCandidate[]): SkuFillResult[] {
  const opts = (list: SkuFillCandidate[]) => list.flatMap((c) => { const grams = weightOf(c); return grams ? [{ id: c.id, grams }] : []; });
  const mainOpts = opts(mains), giftOpts = opts(gifts);
  const one = (label: string, grams: number | null, options: WeightOption[], picked: SkuFillCandidate[], warnings: string[]) => {
    if (grams == null) return [];
    if (!picked.length) { warnings.push(`${label}重量 ${fmt(grams)}，但没有选${label}`); return []; }
    if (!options.length) { warnings.push(`所选${label}的规格里读不出重量，请手工配置`); return []; }
    const combo = combineWeights(grams, options);
    if (!combo) { warnings.push(`${label} ${fmt(grams)} 用所选的 ${options.map((o) => fmt(o.grams)).join('、')} 凑不出来，请手工配置`); return []; }
    if (combo.ambiguous) warnings.push(`${label} ${fmt(grams)} 还有别的同样件数的凑法，请确认`);
    return combo.lines.map((l) => ({ baseCodeId: l.id, qty: l.qty }));
  };
  return inputs.map((input) => {
    const warnings: string[] = [];
    if (input.mainGrams == null && input.giftGrams == null) warnings.push('规格名称里没读到重量，请手工配置');
    const main = one('主商品', input.mainGrams, mainOpts, mains, warnings);
    const gift = one('赠品', input.giftGrams, giftOpts, gifts, warnings);
    return { name: input.name, main, gift, warnings };
  });
}
