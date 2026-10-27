import { sortRecommendationRules } from '@kudesi/shared';
import type { ZoneRule } from './expressApi';

/** 导出给聚水潭录入用的检查提示（同旧系统） */
export const ZONE_CSV_NOTE = '按下界/上界条件录入，避免交界重量重复或遗漏；核对平台/店铺、优先级、禁发地区。不含临时加收；首续重报价随实际重量变化。';
export const ZONE_CSV_HEADERS = ['建议规则名称', '聚水潭快递公司', '限定到达省份', '重量下界条件', '重量下界kg', '重量上界条件', '重量上界kg', '固定标准运费', '首续重计费', 'OA快递公司', '合作网点', '价格版本', '命中价格规则', '聚水潭录入检查项'];

/** 分区建议 CSV（14 列）：上下界用条件 + 数值分开写，聚水潭里照着录入；缺聚水潭名称的给占位提示 */
export function zoneCsvLines(rules: ZoneRule[]): Array<Array<string | number>> {
  return [
    ZONE_CSV_HEADERS,
    ...sortRecommendationRules(rules).map((r) => [
      r.suggestedRuleName, r.jstLogisticsName || '待在网点维护聚水潭快递名称', r.provinceScope, r.weightStartOperator === '>' ? '>' : '>=', r.weightStart,
      r.weightEnd === '' ? '' : r.weightEndOperator === '<' ? '<' : '<=', r.weightEnd, r.amount !== null ? (r.amount / 100).toFixed(2) : '', r.priceLabel,
      r.carrierName, r.branchName, r.versionName, r.rule, ZONE_CSV_NOTE,
    ]),
  ];
}
