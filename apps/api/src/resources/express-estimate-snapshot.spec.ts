import 'reflect-metadata';
import { freightFromEstimateRows } from '@kudesi/shared';
import { ResourceRecord } from '../entities';
import { readFreightSnapshot } from './express-estimate-snapshot';
const rec = (id: number, type: string, data: Record<string, unknown>, companyId = 1) => Object.assign(new ResourceRecord(), { id, type, data, companyId, title: `合成${id}`, status: 'active' });
const sources = () => [rec(1, 'finance-express-carriers', {}), rec(2, 'finance-express-branches', { carrierId: 1, currentVersionId: 3 }), rec(3, 'finance-express-versions', { shippingWeightMin: 0, shippingWeightMax: 30 })];
const base = () => ({ key: '0-1', start: 0, end: 1, method: 'provincial_majority_mean_plus_10_percent', autoAmount: 330, manualAmount: null, sampleCount: 3, includedCount: 3, baseAverage: 300, includedProvinces: ['广东', '山东', '河南'], provinceQuotes: ['广东', '山东', '河南'].map(province => ({ province, carrierId: 1, branchId: 2, versionId: 3, carrierName: '合成1', branchName: '合成2', versionName: '合成3', amount: 300, rule: '合成报价' })) });
const snap = (rows: unknown[]) => rec(9, 'finance-freight-estimates', { parcelLimit: 30, calculatedAt: '2026-11-01T00:00:00Z', revision: 2, rowsJson: JSON.stringify(rows) });
describe('保存的快递预估快照统一读取', () => {
  it('无快照保持空表；价格数字变化不重算或改写已存自动样本', () => {
    expect(readFreightSnapshot(undefined, sources()).rows).toEqual([]);
    const snapshot = snap([base()]);
    const before = snapshot.data.rowsJson;
    const records = [...sources(), rec(4, 'finance-express-prices', { versionId: 3, fixedPrice: 9999 })];
    const read = readFreightSnapshot(snapshot, records);
    expect(read.baseRows[0].autoAmount).toBe(330);
    expect(read.baseRows[0].provinceQuotes[0].amount).toBe(300);
    expect(read.calculatedAt).toBe('2026-11-01T00:00:00Z');
    expect(snapshot.data.rowsJson).toBe(before);
  });
  it('可发货范围变更只让自动报价失效，手工0与原快照保留，恢复范围可再次使用原值', () => {
    const snapshot = snap([{ ...base(), manualAmount: 0 }]);
    const records = sources(); records[2].data.shippingWeightMax = 0.5;
    const unavailable = readFreightSnapshot(snapshot, records);
    expect(unavailable.baseRows[0]).toMatchObject({ autoAmount: null, manualAmount: 0, shippingUnavailable: true });
    expect(freightFromEstimateRows(unavailable.rows, 0.5, 30)?.amount).toBe(0);
    records[2].data.shippingWeightMax = 30;
    expect(readFreightSnapshot(snapshot, records).baseRows[0].autoAmount).toBe(330);
    records[2].data.currentVersionId = 999;
    records[1].data.currentVersionId = 999;
    expect(readFreightSnapshot(snapshot, records).baseRows[0].autoAmount).toBeNull();
  });
  it('旧slim无重量限制时保留可信已存金额；有范围但无样本时不伪造当前自动来源', () => {
    const snapshot = snap([{ key: '0-1', start: 0, end: 1, method: 'provincial_majority_mean_plus_10_percent', autoAmount: 550, manualAmount: null }]);
    expect(readFreightSnapshot(snapshot, []).baseRows[0].autoAmount).toBe(550);
    const read = readFreightSnapshot(snapshot, sources());
    expect(read.requiresRecalculation).toBe(true);
    expect(read.baseRows[0].autoAmount).toBeNull();
    expect(freightFromEstimateRows(read.rows, 0.5, 30)).toBeNull();
  });
  it('无效旧算法和跨公司样本不会提供自动报价，坏JSON仅返回空表', () => {
    expect(readFreightSnapshot(snap([{ ...base(), method: 'unknown_old' }]), []).baseRows[0].autoAmount).toBeNull();
    expect(readFreightSnapshot(snap([base()]), sources().map(row => ({ ...row, companyId: 2 }))).baseRows[0].autoAmount).toBe(330);
    const mixed = sources(); mixed[0].companyId = 2;
    expect(readFreightSnapshot(snap([base()]), mixed).baseRows[0].autoAmount).toBeNull();
    const invalid = snap([]); invalid.data.rowsJson = 'bad-json';
    expect(readFreightSnapshot(invalid, [])).toMatchObject({ rows: [], requiresRecalculation: true });
  });
});
