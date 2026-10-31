/** 迁移适配器：旧直播管理表原样交出（假旧库），换算与引用映射在导入器里做 */
import { readFakeLegacy } from './fake-legacy';

describe('迁移适配器：直播管理', () => {
  it('把十一张旧直播表按去掉 live_ 前缀的键交出，带金额原文；没有直播表的旧库得到空数组', async () => {
    const out = (await readFakeLegacy({
      companies: [{ id: 7, name: '测试公司' }],
      live_commission_rule_versions: [{ id: 1, company_id: 7, effective_from: '2026-01-01', rules_json: '{}' }],
      live_sessions: [{ id: 5, company_id: 7, final_sales: '1234.56', status: 'approved' }],
    })) as unknown as { live: Record<string, Array<Record<string, unknown>>> };
    expect(Object.keys(out.live).sort()).toEqual(['commission_records', 'commission_rule_versions', 'schedules', 'session_orders', 'session_products', 'session_reports', 'sessions', 'settlement_lines', 'settlement_refunds', 'settlements', 'wage_records']);
    expect(out.live.commission_rule_versions).toHaveLength(1);
    expect(out.live.sessions.map((r) => [r.id, r.final_sales])).toEqual([[5, '1234.56']]);
    expect(out.live.schedules).toEqual([]);
  });
});
