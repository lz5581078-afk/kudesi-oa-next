import { PROVINCES } from '@kudesi/shared';
import { parseCsv, toCsv } from '../../../resources/csv';
import { centsToYuan, yuanToCents } from '../common';
import type { RuleRow } from './expressApi';

/** 手工价格表 CSV（列同旧系统）：省份、规则类型（区间统一价/首重续重）、起止重量、统一价、首重类型、首重金额、续重每公斤、备注 */
export const PRICE_CSV_HEADERS = ['省份/自治区', '规则类型（区间统一价/首重续重）', '起始重量kg', '结束重量kg（空=以上）', '区间统一价', '首重类型（0或1）', '首重金额', '续重每公斤', '备注', '下限不含(是/否)', '上限不含(是/否)'];
const ALIASES: Record<string, string[]> = {
  province: ['省份/自治区', '省份', '地区', '区域', 'province'],
  ruleType: ['规则类型（区间统一价/首重续重）', '规则类型', '类型'],
  start: ['起始重量kg', '起始重量', '开始重量'],
  end: ['结束重量kg（空=以上）', '结束重量kg', '结束重量'],
  fixed: ['区间统一价', '统一价', '固定价格'],
  firstType: ['首重类型（0或1）', '首重类型', '首重重量'],
  firstAmount: ['首重金额', '首重多少钱'],
  extra: ['续重每公斤', '续重金额', '续重'],
  remark: ['备注'],
  minEx: ['下限不含(是/否)'],
  maxEx: ['上限不含(是/否)'],
};
const wt = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

export function priceTemplateCsv(): string {
  return toCsv([
    PRICE_CSV_HEADERS,
    ['山东省', '区间统一价', '0', '0.5', '1.25', '', '', '', '示例：0-0.5kg统一价', '否', '否'],
    ['山东省', '首重续重', '7.01', '30', '', '0', '3.5', '0.5', '示例：7.01-30kg按公式', '是', '否'],
  ]);
}

export function rulesToCsv(rules: RuleRow[]): string {
  return toCsv([
    PRICE_CSV_HEADERS,
    ...rules.map((r) => {
      const formula = r.fixedPrice === null || r.fixedPrice === undefined;
      return [r.province === 'ALL' ? '全国' : r.province, formula ? '首重续重' : '区间统一价', wt(r.shipWeightMin ?? 0), wt(r.shipWeightMax), formula ? '' : centsToYuan(r.fixedPrice),
        formula ? String(r.firstWeight === 0 ? 0 : 1) : '', formula ? centsToYuan(r.firstPrice) : '', formula ? centsToYuan(r.extraPrice) : '', '', r.minExclusive ? '是' : '否', r.maxExclusive ? '是' : '否'];
    }),
  ]);
}

/** CSV → 价格规则；有问题的行给出“第几行：原因”，有错误时不应保存。 */
export function parseRulesCsv(text: string): { rules: RuleRow[]; errors: string[] } {
  const [head = [], ...body] = parseCsv(text);
  const names = head.map((h) => h.trim());
  const idx = Object.fromEntries(Object.entries(ALIASES).map(([k, labels]) => [k, names.findIndex((h) => labels.includes(h))]));
  const rules: RuleRow[] = [];
  const errors: string[] = [];
  if (idx.province < 0 || idx.start < 0) return { rules, errors: ['表头不对：至少要有“省份/自治区”和“起始重量kg”列，请用模板'] };
  const cell = (r: string[], k: string) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
  body.forEach((r, i) => {
    const line = i + 2;
    const provinceText = cell(r, 'province');
    if (!provinceText) return;
    const province = ['全国', '全国统一', 'ALL'].includes(provinceText) ? 'ALL' : (PROVINCES as readonly string[]).find((p) => p === provinceText || p.replace(/(省|市|自治区|特别行政区|壮族|回族|维吾尔)/g, '') === provinceText.replace(/(省|市|自治区|特别行政区|壮族|回族|维吾尔)/g, ''));
    if (!province) return void errors.push(`第 ${line} 行：不认识的省份“${provinceText}”`);
    const start = Number(cell(r, 'start') || 0);
    const endText = cell(r, 'end');
    const end = endText === '' ? null : Number(endText);
    if (!Number.isFinite(start) || start < 0) return void errors.push(`第 ${line} 行：起始重量要填大于等于 0 的数字`);
    if (end !== null && (!Number.isFinite(end) || end <= start)) return void errors.push(`第 ${line} 行：结束重量必须大于起始重量，或留空表示以上`);
    const typeText = cell(r, 'ruleType');
    const formula = typeText.includes('首重') || (!typeText && cell(r, 'extra') !== '');
    const yes = (k: string, fallback: boolean) => (cell(r, k) === '' ? fallback : cell(r, k) === '是');
    const base: RuleRow = { province, shipWeightMin: start, shipWeightMax: end, minExclusive: yes('minEx', start > 0) || undefined, maxExclusive: yes('maxEx', false) || undefined };
    if (formula) {
      const first = yuanToCents(cell(r, 'firstAmount'));
      const extra = yuanToCents(cell(r, 'extra'));
      if (first === null || Number.isNaN(first) || first < 0) return void errors.push(`第 ${line} 行：首重金额要填大于等于 0 的金额（最多两位小数）`);
      if (extra === null || Number.isNaN(extra) || extra < 0) return void errors.push(`第 ${line} 行：续重每公斤要填大于等于 0 的金额`);
      rules.push({ ...base, firstWeight: cell(r, 'firstType').includes('0') ? 0 : 1, firstPrice: first, extraPrice: extra });
    } else {
      const fixed = yuanToCents(cell(r, 'fixed'));
      if (fixed === null || Number.isNaN(fixed) || fixed < 0) return void errors.push(`第 ${line} 行：区间统一价要填大于等于 0 的金额（最多两位小数）`);
      rules.push({ ...base, fixedPrice: fixed });
    }
  });
  if (!rules.length && !errors.length) errors.push('文件里没有可导入的价格行');
  return { rules, errors };
}
