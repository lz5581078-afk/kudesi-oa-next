import { ruleFromRecordData, type PriceGroup, type PriceRule } from '@kudesi/shared';
import { ResourceRecord } from '../entities';
import { resolveSource, versionEnabled } from './express-rules';

// 注意：这里不能 import resources.service / express.service，否则会和 cost.service 形成循环依赖，生产启动会失败。
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
export const DEFAULT_PARCEL_LIMIT = 30;

/**
 * 把“当前版本 + 合作中 + 日期有效 + 价格依据一致”的版本整理成估价引擎要的价格组；
 * 没挂版本的老规则（直接填了快递公司）按自己的状态和有效期参与。
 */
export function buildPriceGroups(rows: ResourceRecord[], day: string): PriceGroup[] {
  const by = (t: string) => rows.filter((r) => r.type === t);
  const carriers = new Map(by('finance-express-carriers').map((r) => [r.id, r]));
  const branches = new Map(by('finance-express-branches').map((r) => [r.id, r]));
  const prices = by('finance-express-prices');
  const groups: PriceGroup[] = [];
  for (const version of by('finance-express-versions')) {
    const branch = branches.get(num(version.data.branchId) ?? -1);
    const carrier = branch ? carriers.get(num(branch.data.carrierId) ?? -1) : undefined;
    if (!branch || !carrier || !versionEnabled(version, branch, carrier)) continue;
    const start = str(version.data.effectiveStart), end = str(version.data.effectiveEnd);
    if ((start && start > day) || (end && end < day)) continue;
    const own = prices.filter((p) => p.data.versionId === version.id);
    const source = resolveSource(version, own);
    const rules: PriceRule[] = [];
    own.filter((p) => ((p.data.source as string) || 'manual') === source).forEach((p, i) => {
      const rule = ruleFromRecordData(p.data, i);
      if (rule) rules.push(rule);
    });
    groups.push({
      carrierId: carrier.id, branchId: branch.id, versionId: version.id, carrierName: carrier.title, branchName: branch.title, versionName: version.title,
      jstLogisticsName: str(branch.data.jstLogisticsName), limitMin: num(version.data.shippingWeightMin) ?? 0, limitMax: num(version.data.shippingWeightMax) ?? 1000, rules,
    });
  }
  const legacy = new Map<string, PriceGroup>();
  for (const p of prices) {
    if (typeof p.data.versionId === 'number' || p.status !== 'active') continue;
    const from = str(p.data.validFrom), to = str(p.data.validTo);
    if ((from && from > day) || (to && to < day)) continue;
    const key = `${str(p.data.carrier)}|${str(p.data.branch)}`;
    if (!legacy.has(key)) {
      legacy.set(key, { carrierId: `legacy:${str(p.data.carrier)}`, branchId: `legacy:${key}`, versionId: `legacy:${key}`, carrierName: str(p.data.carrier), branchName: str(p.data.branch), versionName: '未分版本', limitMin: 0, limitMax: 1000, rules: [] });
    }
    const g = legacy.get(key)!;
    const rule = ruleFromRecordData(p.data, g.rules.length);
    if (rule) g.rules.push(rule);
  }
  return [...groups, ...legacy.values()].filter((g) => g.rules.length > 0);
}
