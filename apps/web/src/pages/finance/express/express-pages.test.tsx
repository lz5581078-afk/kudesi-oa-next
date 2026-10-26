import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreightEstimatePage } from './FreightEstimatePage';
import { PriceMatrixEditor } from './PriceMatrixEditor';
import { RecognizeDialog } from './RecognizeDialog';
import { ZoneRunsPage } from './ZoneRunsPage';
import { expressApi, type EstimateRow, type Estimates } from './expressApi';

vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('./expressApi', async (orig) => {
  const real = await orig<typeof import('./expressApi')>();
  return { ...real, expressApi: { estimates: vi.fn(), recalculate: vi.fn(), setParcelLimit: vi.fn(), setOverride: vi.fn(), saveRules: vi.fn(), recognize: vi.fn(), confirmPrice: vi.fn(), confirmSurcharge: vi.fn(), zoneRuns: vi.fn(), zoneRun: vi.fn(), generateZone: vi.fn(), deleteZoneRun: vi.fn() } };
});
const m = vi.mocked(expressApi);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const row = (start: number, end: number, over: Partial<EstimateRow> = {}): EstimateRow => ({
  key: `${start}-${end}`, start, end, method: 'provincial_majority_mean_plus_10_percent', autoAmount: 880, manualAmount: null, sampleCount: 34, includedCount: 30, baseAverage: 800,
  includedProvinces: [], excludedLowProvinces: [], excludedHighProvinces: ['新疆'], provinceQuotes: [{ province: '广东', amount: 800, carrierName: '极兔', branchName: '兰山', versionName: '春', rule: '≤1kg' }], ...over,
});
const est = (rows: EstimateRow[], over: Partial<Estimates> = {}): Estimates => ({ parcelLimit: 30, calculatedAt: '', cooperatingGroups: 3, rows, overrides: [], orphanOverrides: [], ...over });

describe('成本表预估快递费', () => {
  it('显示重量段的自动估价、明细；单包上限只能填 1~100 的整数', async () => {
    m.estimates.mockResolvedValue(est([row(0, 0.5), row(30, 31, { method: 'split_parcel_sum', parcels: [{ count: 1, weight: 30, amount: 880, source: 'automatic', key: '29-30' }, { count: 1, weight: 1, amount: 880, source: 'automatic', key: '0.5-1' }] })]));
    render(<FreightEstimatePage />);
    await screen.findByText('0 ~ 0.5 kg');
    expect(screen.getAllByText('¥8.80').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: '明细' })[0]);
    expect(screen.getByText(/剔除偏高：新疆/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '明细' })[0]);
    expect(screen.getByText(/1 个 30kg 包裹/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('单包重量上限'), { target: { value: '101' } });
    fireEvent.click(screen.getByRole('button', { name: '保存上限' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/1 到 100/);
    expect(m.setParcelLimit).not.toHaveBeenCalled();
    m.setParcelLimit.mockResolvedValue(est([row(0, 0.5)], { parcelLimit: 10 }));
    fireEvent.change(screen.getByLabelText('单包重量上限'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '保存上限' }));
    await waitFor(() => expect(m.setParcelLimit).toHaveBeenCalledWith(10));
  });

  it('给重量段手工定价（元转分），拆包段不能单独定价；可以填 0', async () => {
    m.estimates.mockResolvedValue(est([row(0, 0.5), row(30, 31, { method: 'split_parcel_sum', parcels: [] })]));
    m.setOverride.mockResolvedValue(est([row(0, 0.5, { manualAmount: 0 })]));
    render(<FreightEstimatePage />);
    await screen.findByText('0 ~ 0.5 kg');
    expect(screen.getByText('不能单独定价')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '手工定价' }));
    fireEvent.change(screen.getByLabelText('0 ~ 0.5 kg 手工运费'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(m.setOverride).toHaveBeenCalledWith(0, 0.5, 0));
  });
});

describe('价格矩阵编辑', () => {
  it('填价格后保存，按元转成分提交；金额写错不提交', async () => {
    m.saveRules.mockResolvedValue({ created: 1, removed: 0 });
    render(<PriceMatrixEditor versionId={4} source="manual" canEdit rules={[]} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '加入常用档位（0.5/1/2/3/4/5/6kg）' }));
    const input = screen.getByLabelText('广东 ≥0kg ~ ≤0.5kg 价格');
    fireEvent.change(input, { target: { value: '1.234' } });
    fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/广东/);
    expect(m.saveRules).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '1.25' } });
    fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
    await waitFor(() => expect(m.saveRules).toHaveBeenCalledWith(4, 'manual', [{ province: '广东', shipWeightMin: 0, shipWeightMax: 0.5, minExclusive: undefined, maxExclusive: undefined, fixedPrice: 125 }]));
  });

  it('只读时不出现输入框，只显示有价格的省份', () => {
    render(<PriceMatrixEditor versionId={4} source="ai" canEdit={false} onSaved={vi.fn()} rules={[{ province: '新疆', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: 800 }]} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('新疆')).toBeTruthy();
    expect(screen.queryByText('广东')).toBeNull();
  });
});

describe('AI 识别', () => {
  it('有提醒的行默认不导入，确认时只提交勾选的行', async () => {
    m.recognize.mockResolvedValue({
      kind: 'price_table', modelName: 'm1', fileName: '价格.png', warnings: [], effectiveStart: '2026-01-01', effectiveEnd: '', extraRemark: '退改费：10元', confidence: 0.8,
      rows: [{ province: '广东', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: 300, warnings: [] }, { province: '新疆', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: null, warnings: ['价格不全'] }],
    });
    m.confirmPrice.mockResolvedValue({ created: 1 });
    const done = vi.fn();
    render(<RecognizeDialog versionId={4} kind="price" onClose={vi.fn()} onDone={done} />);
    fireEvent.change(screen.getByLabelText('选择要识别的文件'), { target: { files: [new File(['x'], '价格.png', { type: 'image/png' })] } });
    await screen.findByText('价格不全');
    expect((screen.getByLabelText('导入第2行') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(m.confirmPrice).toHaveBeenCalledWith(4, expect.objectContaining({ rules: [{ province: '广东', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: 300 }], effectiveStart: '2026-01-01', extraRemark: '退改费：10元' }));
  });
});

describe('分区建议生成记录', () => {
  it('生成后出现在记录里并显示结果；上限超范围不提交', async () => {
    m.zoneRuns.mockResolvedValueOnce({ total: 0, page: 1, pageSize: 5, items: [] });
    render(<ZoneRunsPage />);
    await screen.findByText(/还没有生成过/);
    fireEvent.change(screen.getByLabelText('最高重量'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: '生成分区建议' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/0 到 1000/);
    expect(m.generateZone).not.toHaveBeenCalled();
    const run = { id: 1, sequence: 1, createdAt: '2026-10-26T00:00:00Z', maxWeightKg: 30, cooperatingVersionCount: 2, combinationCount: 2, ruleCount: 1 };
    m.generateZone.mockResolvedValue(run);
    m.zoneRuns.mockResolvedValue({ total: 1, page: 1, pageSize: 5, items: [run] });
    m.zoneRun.mockResolvedValue({ ...run, rules: [{ provinces: ['广东'], provinceScope: '广东', carrierName: '极兔', branchName: '兰山', jstLogisticsName: '淘宝-极兔', versionName: '春', suggestedRuleName: '淘宝-极兔-0至1kg', weightStart: 0, weightEnd: 1, weightStartOperator: '>=', weightEndOperator: '<=', amount: 300, priceLabel: '', rule: '' }] });
    fireEvent.change(screen.getByLabelText('最高重量'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '生成分区建议' }));
    await screen.findByText('淘宝-极兔-0至1kg');
    expect(screen.getByText('¥3.00')).toBeTruthy();
    expect(m.generateZone).toHaveBeenCalledWith(30);
  });
});
