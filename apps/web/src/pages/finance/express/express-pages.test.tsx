import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreightEstimatePage } from './FreightEstimatePage';
import { PriceMatrixEditor } from './PriceMatrixEditor';
import { RecognizeDialog } from './RecognizeDialog';
import { ZoneRunsPage } from './ZoneRunsPage';
import { zoneCsvLines } from './zoneCsv';
import { expressApi, type EstimateRow, type Estimates } from './expressApi';

vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('./expressApi', async (orig) => {
  const real = await orig<typeof import('./expressApi')>();
  return { ...real, expressApi: { estimates: vi.fn(), recalculate: vi.fn(), setParcelLimit: vi.fn(), setOverride: vi.fn(), saveOverrides: vi.fn(), saveRules: vi.fn(), recognitionModels: vi.fn().mockResolvedValue({ providers: [{ id: 1, name: '合成服务商', status: 'active', models: ['m1'] }], current: { providerId: 1, modelId: 'm1' } }), recognize: vi.fn(), confirmPrice: vi.fn(), confirmSurcharge: vi.fn(), zoneRuns: vi.fn(), zoneRun: vi.fn(), generateZone: vi.fn(), deleteZoneRun: vi.fn() } };
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
    await screen.findByText('0–0.5kg');
    expect(screen.getAllByText('¥8.80').length).toBeGreaterThan(0);
    expect(screen.getByText(/剔除偏高：新疆/)).toBeTruthy();
    expect(screen.getByText(/1 包 × 30kg/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('单包重量上限'), { target: { value: '101' } });
    fireEvent.click(screen.getByRole('button', { name: '重新计算' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/1 到 100/);
    expect(m.recalculate).not.toHaveBeenCalled();
    m.recalculate.mockResolvedValue(est([row(0, 0.5)], { parcelLimit: 10 }));
    fireEvent.change(screen.getByLabelText('单包重量上限'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '重新计算' }));
    await waitFor(() => expect(m.recalculate).toHaveBeenCalledWith(10, 0));
  });

  it('给重量段手工定价（元转分），拆包段不能单独定价；可以填 0', async () => {
    m.estimates.mockResolvedValue(est([row(0, 0.5), row(30, 31, { method: 'split_parcel_sum', parcels: [] })]));
    m.saveOverrides.mockResolvedValue(est([row(0, 0.5, { manualAmount: 0 })]));
    render(<FreightEstimatePage />);
    await screen.findByText('0–0.5kg');
    expect(screen.queryByLabelText('30至31公斤手工运费')).toBeNull();
    fireEvent.change(screen.getByLabelText('0至0.5公斤手工运费'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存手工调整' }));
    await waitFor(() => expect(m.saveOverrides).toHaveBeenCalledWith(0, [{ weightFrom: 0, weightTo: 0.5, amount: 0 }]));
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
    await waitFor(() => expect((screen.getByLabelText('AI 模型') as HTMLSelectElement).value).toBe('1:m1'));
    expect(m.recognize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '开始识别' }));
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

describe('分区建议 CSV 与手工价格 CSV 导入', () => {
  it('分区建议导出 14 列，缺聚水潭名称给占位', () => {
    const lines = zoneCsvLines([{ provinces: ['广东'], provinceScope: '广东', carrierName: '极兔', branchName: '兰山', jstLogisticsName: '', versionName: '春', suggestedRuleName: 'x', weightStart: 0, weightEnd: '', weightStartOperator: '>=', weightEndOperator: '<=', amount: null, priceLabel: '首重1kg 3.00元+续重0.50元/kg', rule: 'r' }]);
    expect(lines[0]).toHaveLength(14);
    expect(lines[1]).toHaveLength(14);
    expect(lines[1][1]).toBe('待在网点维护聚水潭快递名称');
    expect(lines[1][5]).toBe('');
  });
  it('手工价格表导入 CSV 读进矩阵，点保存才提交', async () => {
    m.saveRules.mockResolvedValue({ created: 1, removed: 0 });
    render(<PriceMatrixEditor versionId={4} source="manual" canEdit rules={[]} onSaved={vi.fn()} />);
    const file = new File(['省份,起始重量,结束重量,统一价\n广东,0,1,2.5'], 'p.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('导入价格表CSV'), { target: { files: [file] } });
    await screen.findByText(/已读入 1 条价格/);
    fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
    await waitFor(() => expect(m.saveRules).toHaveBeenCalledWith(4, 'manual', [expect.objectContaining({ province: '广东', fixedPrice: 250 })]));
  });
});

describe('识别结果确认前修正', () => {
  it('可修正省份和重量，并将统一价改成0公斤首重公式；错误金额不写入', async () => {
    m.recognize.mockResolvedValue({ kind: 'price_table', modelName: 'm', fileName: 'p.csv', warnings: [], effectiveStart: '', effectiveEnd: '', extraRemark: '', confidence: 1,
      rows: [{ province: '广东', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: 300, warnings: [] }] });
    m.confirmPrice.mockResolvedValue({ created: 1 });
    render(<RecognizeDialog versionId={4} kind="price" onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择要识别的文件'), { target: { files: [new File(['x'], 'p.csv', { type: 'text/csv' })] } });
    await waitFor(() => expect((screen.getByLabelText('AI 模型') as HTMLSelectElement).value).toBe('1:m1'));
    fireEvent.click(screen.getByRole('button', { name: '开始识别' }));
    await screen.findByLabelText('第1行区间统一价');
    fireEvent.change(screen.getByLabelText('第1行区间统一价'), { target: { value: '1.234' } });
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/金额最多两位小数/);
    expect(m.confirmPrice).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('第1行规则类型'), { target: { value: 'formula' } });
    fireEvent.change(screen.getByLabelText('第1行首重类型'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('第1行首重金额'), { target: { value: '3.25' } });
    fireEvent.change(screen.getByLabelText('第1行续重金额'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('第1行省份/区域'), { target: { value: '山东' } });
    fireEvent.change(screen.getByLabelText('第1行起始重量'), { target: { value: '7.01' } });
    fireEvent.change(screen.getByLabelText('第1行结束重量'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(m.confirmPrice).toHaveBeenCalledWith(4, expect.objectContaining({ rules: [{ province: '山东', shipWeightMin: 7.01, shipWeightMax: null, fixedPrice: null, firstWeight: 0, firstPrice: 325, extraPrice: 50 }] })));
  });

  it('加收区域日期重量均可更正，比例和金额独立；日期倒置不上传凭据或写入', async () => {
    m.recognize.mockResolvedValue({ kind: 'surcharge_notice', batchName: '通知', fileName: 's.csv', modelName: 'm', warnings: [],
      rows: [{ name: '加收', effectiveStart: '2026-01-01', effectiveEnd: '', areaScope: '广东', chargeType: 'fixed', amount: 200, percent: null, weightMode: 'all', weightStart: null, weightEnd: null, warnings: [] }] });
    m.confirmSurcharge.mockResolvedValue({ created: 1 });
    render(<RecognizeDialog versionId={4} kind="surcharge" onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择要识别的文件'), { target: { files: [new File(['x'], 's.csv', { type: 'text/csv' })] } });
    await waitFor(() => expect((screen.getByLabelText('AI 模型') as HTMLSelectElement).value).toBe('1:m1'));
    fireEvent.click(screen.getByRole('button', { name: '开始识别' }));
    await screen.findByLabelText('第1行加收名称');
    fireEvent.change(screen.getByLabelText('批次备注'), { target: { value: '本次通知' } });
    fireEvent.change(screen.getByLabelText('第1行备注'), { target: { value: '省份附注' } });
    fireEvent.change(screen.getByLabelText('第1行省份/区域'), { target: { value: '山东、河南' } });
    fireEvent.change(screen.getByLabelText('第1行结束日期'), { target: { value: '2025-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/结束日期不能早于/);
    expect(m.confirmSurcharge).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('第1行结束日期'), { target: { value: '2026-02-01' } });
    fireEvent.change(screen.getByLabelText('第1行加收方式'), { target: { value: 'percent' } });
    fireEvent.change(screen.getByLabelText('第1行加收比例（%）'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText('第1行重量模式'), { target: { value: 'between' } });
    fireEvent.change(screen.getByLabelText('第1行起始重量'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('第1行结束重量'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(m.confirmSurcharge).toHaveBeenCalledWith(4, expect.objectContaining({ batchName: '通知', batchNote: '本次通知', rows: [expect.objectContaining({ note: '省份附注', areaScope: '山东、河南', chargeType: 'percent', amount: null, percent: 12.5, weightMode: 'between', weightStart: 1, weightEnd: 5 })] })));
  });
});

describe('分区建议记录切换', () => {
  it('使用最新记录的重量上限，切换后较慢的旧结果不能覆盖新选择', async () => {
    const first = { id: 1, sequence: 1, createdAt: '2026-10-26T00:00:00Z', maxWeightKg: 60, cooperatingVersionCount: 1, combinationCount: 1, ruleCount: 0 };
    const second = { ...first, id: 2, sequence: 2 };
    m.zoneRuns.mockResolvedValue({ total: 2, page: 1, pageSize: 5, items: [second, first] });
    let finishFirst!: (r: typeof first & { rules: [] }) => void;
    m.zoneRun.mockImplementation(id => id === 2 ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve({ ...first, rules: [] }));
    render(<ZoneRunsPage />);
    const button = await screen.findByRole('button', { name: /第 1 次 ·/ });
    expect((screen.getByLabelText('最高重量') as HTMLInputElement).value).toBe('60');
    fireEvent.click(button);
    await screen.findByRole('heading', { name: '第 1 次结果' });
    finishFirst({ ...second, rules: [] });
    await waitFor(() => expect(screen.queryByRole('heading', { name: '第 2 次结果' })).toBeNull());
    expect(screen.getByRole('heading', { name: '第 1 次结果' })).toBeTruthy();
  });
});

describe('识别复杂规则增删', () => {
  it('新增公式并删除前面规则后，编辑内容和原警告勾选状态仍对应各自规则', async () => {
    m.recognize.mockResolvedValue({ kind: 'price_table', modelName: 'm', fileName: 'p.csv', warnings: [], effectiveStart: '', effectiveEnd: '', extraRemark: '', confidence: 1,
      rows: [{ province: '广东', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: 300, warnings: [] }, { province: '新疆', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: null, warnings: ['请核对'] }] });
    m.confirmPrice.mockResolvedValue({ created: 1 });
    render(<RecognizeDialog versionId={4} kind="price" onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择要识别的文件'), { target: { files: [new File(['x'], 'p.csv', { type: 'text/csv' })] } });
    await waitFor(() => expect((screen.getByLabelText('AI 模型') as HTMLSelectElement).value).toBe('1:m1'));
    fireEvent.click(screen.getByRole('button', { name: '开始识别' }));
    await screen.findByText('请核对');
    fireEvent.click(screen.getAllByRole('button', { name: '加公式' })[0]);
    fireEvent.change(screen.getByLabelText('第3行起始重量'), { target: { value: '7.01' } });
    fireEvent.change(screen.getByLabelText('第3行首重类型'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('第3行首重金额'), { target: { value: '3.5' } });
    fireEvent.change(screen.getByLabelText('第3行续重金额'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('第3行备注'), { target: { value: '新增公式' } });
    fireEvent.click(screen.getAllByRole('button', { name: '删除规则' })[0]);
    expect((screen.getByLabelText('导入第1行') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('第2行备注') as HTMLInputElement).value).toBe('新增公式');
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(m.confirmPrice).toHaveBeenCalledWith(4, expect.objectContaining({ rules: [expect.objectContaining({ province: '广东', shipWeightMin: 7.01, firstWeight: 0, firstPrice: 350, extraPrice: 50, note: '新增公式' })] })));
  });
});

describe('预估运费批量调整', () => {
  it('跨页输入一次提交，失败保留所有填写，不在输入时写入成本', async () => {
    m.estimates.mockResolvedValue(est(Array.from({ length: 51 }, (_, i) => row(i, i + 1)), { parcelLimit: 100, revision: 4 }));
    m.saveOverrides.mockRejectedValue(new Error('预估快递费已由其他人更新'));
    render(<FreightEstimatePage />);
    await screen.findByLabelText('0至1公斤手工运费');
    fireEvent.change(screen.getByLabelText('0至1公斤手工运费'), { target: { value: '1.25' } });
    expect(m.saveOverrides).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    fireEvent.change(screen.getByLabelText('50至51公斤手工运费'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存手工调整' }));
    expect((await screen.findByRole('alert')).textContent).toContain('其他人更新');
    expect(m.saveOverrides).toHaveBeenCalledWith(4, expect.arrayContaining([{ weightFrom: 0, weightTo: 1, amount: 125 }, { weightFrom: 50, weightTo: 51, amount: 0 }]));
    expect(m.saveOverrides.mock.calls[0][1]).toHaveLength(51);
    expect((screen.getByLabelText('50至51公斤手工运费') as HTMLInputElement).value).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: '首页' }));
    expect((screen.getByLabelText('0至1公斤手工运费') as HTMLInputElement).value).toBe('1.25');
  });
});

describe('识别模型默认失效', () => {
  it('失效的保存默认不静默换另一个模型，必须显式重选后才调用识别', async () => {
    m.recognitionModels.mockResolvedValueOnce({ providers: [{ id: 2, name: '合成可用服务商', status: 'active', models: ['gpt-synthetic'] }], current: { providerId: 1, modelId: 'gpt-removed' } });
    m.recognize.mockResolvedValue({ kind: 'price_table', fileName: 'p.csv', modelName: 'gpt-synthetic', rows: [{ province: '广东', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: 100, warnings: [] }], warnings: [], effectiveStart: '', effectiveEnd: '', extraRemark: '', confidence: 1 });
    render(<RecognizeDialog versionId={4} kind="price" onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByRole('option', { name: '合成可用服务商 / gpt-synthetic' });
    expect((screen.getByLabelText('AI 模型') as HTMLSelectElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('选择要识别的文件'), { target: { files: [new File(['x'], 'p.csv', { type: 'text/csv' })] } });
    fireEvent.click(screen.getByRole('button', { name: '开始识别' }));
    expect((await screen.findByRole('alert')).textContent).toContain('请先选择 AI 模型');
    expect(m.recognize).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('AI 模型'), { target: { value: '2:gpt-synthetic' } });
    fireEvent.click(screen.getByRole('button', { name: '开始识别' }));
    await waitFor(() => expect(m.recognize).toHaveBeenCalledWith(4, 'price', expect.any(File), { providerId: 2, modelId: 'gpt-synthetic' }));
  });
});
