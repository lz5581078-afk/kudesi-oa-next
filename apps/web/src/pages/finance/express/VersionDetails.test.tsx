import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../api/client';
import { VersionPanel } from './VersionPanel';
import { versionWeightLabel, expressDateTime } from './versionWeightLabel';
import { PriceRuleDialog } from './PriceRuleDialog';
import { SurchargeDialog } from './SurchargeDialog';
import { expressApi, type TreeBranch, type TreeCarrier, type TreeVersion } from './expressApi';
import { resourceApi } from '../../../resources/api';
vi.mock('../../../resources/RecordDetail', () => ({ useResourceCan: () => () => true }));
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('./expressApi', () => ({ expressApi: { version: vi.fn(), createSurcharge: vi.fn() } }));
vi.mock('../../../resources/api', () => ({ resourceApi: { gridSave: vi.fn(), update: vi.fn(), changeStatus: vi.fn(), remove: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });
const version: TreeVersion = { id: 3, name: '合成版本', status: 'active', cooperationStatus: 'active', priceSource: 'manual', effectiveStart: '', effectiveEnd: '', shippingWeightMin: 0, shippingWeightMax: 30, isCurrent: true, aiRuleCount: 0, manualRuleCount: 1, surchargeCount: 1, inUse: true };
const branch: TreeBranch = { id: 2, name: '合成网点', status: 'normal', jstLogisticsName: '', contactName: '', contactPhone: '', currentVersionId: 3, isDefault: true, versions: [version] };
const carrier: TreeCarrier = { id: 1, name: '合成快递', status: 'normal', defaultBranchId: 2, note: '', branches: [branch] };
const detail = { version: { id: 3, name: '合成版本', status: 'active', data: { remark: '初始备注', priceSource: 'manual', attachmentName: '合成报价.csv' } }, branch, carrier, effectiveSource: 'manual' as const, rules: [{ id: 4, version: '1234567890abcdef', source: 'manual', province: '广东', shipWeightMin: 0, shipWeightMax: 1, fixedPrice: 300 }], batches: [{ id: 5, status: 'active', batchName: '合成加收批次' }], surcharges: [{ id: 6, status: 'active', versionId: 3, batchId: 5, name: '偏远加收', areaScope: '广东', chargeType: 'fixed' as const, amount: 100 }], recognitions: [] };
describe('快递版本原布局与内层', () => {
  it('列表与详情的可发货重量文案区分未限制、仅下限和闭区间', () => {
    expect(expressDateTime('2026-11-01T00:00:49Z')).toBe('2026-11-01 08:00');
    expect(versionWeightLabel({})).toBe('未限制');
    expect(versionWeightLabel({ shippingWeightMin: 2 })).toBe('≥2kg');
    expect(versionWeightLabel({ shippingWeightMin: 0, shippingWeightMax: 30 })).toBe('0–30kg');
  });
  it('同页显示基础报价、配置、批次和备注，停用确认不额外索取原因', async () => {
    vi.mocked(expressApi.version).mockResolvedValue(detail);
    vi.mocked(resourceApi.changeStatus).mockResolvedValue({} as never);
    render(<VersionPanel carrier={carrier} branch={branch} version={version} onChanged={vi.fn()} onBack={vi.fn()} />);
    await screen.findByRole('region', { name: '基础价格规则' });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText('0-1kg')).toBeTruthy();
    expect(screen.getByRole('region', { name: '配置选项' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '临时加收与上传记录' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '合作备注' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '最终价格依据' }).querySelectorAll('option').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: '停用整批' }));
    const confirm = await screen.findByRole('dialog', { name: '确认停用' });
    expect(within(confirm).queryByLabelText('原因')).toBeNull();
    fireEvent.click(within(confirm).getByRole('button', { name: '确认停用' }));
    await waitFor(() => expect(resourceApi.changeStatus).toHaveBeenCalledWith('finance-express-fee-batches', 5, 'stopped', '人工确认停用加收批次'));
  });
  it('基础价格规则沿原表默认20条分页，搜索及页内核对仍可使用', async () => {
    vi.mocked(expressApi.version).mockResolvedValue({ ...detail, rules: Array.from({ length: 21 }, (_, index) => ({ ...detail.rules[0], id: index + 20, shipWeightMin: index, shipWeightMax: index + 1 })) });
    render(<VersionPanel carrier={carrier} branch={branch} version={version} onChanged={vi.fn()} />);
    const table = await screen.findByRole('table', { name: '基础价格规则' });
    expect(within(table).getAllByRole('row')).toHaveLength(21);
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByLabelText('基础价格规则搜索')).toBeTruthy();
  });

  it('识别记录按旧版每页8条，可翻到较早记录并显示旧状态', async () => {
    const recognitions = Array.from({ length: 23 }, (_, index) => ({
      id: index + 100, recognitionType: 'price_table', fileName: `历史通知-${index}.csv`,
      resultStatus: index === 22 ? '已生效' : '已确认导入',
    }));
    vi.mocked(expressApi.version).mockResolvedValue({ ...detail, recognitions });
    render(<VersionPanel carrier={carrier} branch={branch} version={version} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '查看识别记录' }));
    const dialog = within(screen.getByRole('dialog', { name: '快递价格历史记录' }));
    const table = within(dialog.getByRole('table', { name: '快递价格历史记录' }));
    expect(table.getAllByRole('row')).toHaveLength(9);
    fireEvent.click(dialog.getByRole('button', { name: '下一页' }));
    fireEvent.click(dialog.getByRole('button', { name: '下一页' }));
    expect(table.getByText('历史通知-22.csv')).toBeTruthy();
    expect(table.getByText('已生效')).toBeTruthy();
  });

  it('备注在上一保存尚未完成时继续输入，后续值不会被旧响应覆盖', async () => {
    vi.mocked(expressApi.version).mockResolvedValue(detail);
    let finish!: () => void;
    vi.mocked(resourceApi.update).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as never); })).mockResolvedValue({} as never);
    render(<VersionPanel carrier={carrier} branch={branch} version={version} onChanged={vi.fn()} />);
    const input = await screen.findByLabelText('快递合作具体内容、退改费、其他费用和特殊口径');
    fireEvent.change(input, { target: { value: '第一次' } }); fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '第二次' } }); fireEvent.blur(input);
    finish();
    await waitFor(() => expect(resourceApi.update).toHaveBeenLastCalledWith('finance-express-versions', 3, { remark: '第二次' }));
    expect((input as HTMLTextAreaElement).value).toBe('第二次');
  });
  it('不失焦直接离开时串行保存最后输入，切换token后不续发旧公司的队列', async () => {
    vi.mocked(expressApi.version).mockResolvedValue(detail);
    let finish!: () => void;
    vi.mocked(resourceApi.update).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as never); })).mockResolvedValue({} as never);
    const view = render(<VersionPanel carrier={carrier} branch={branch} version={version} onChanged={vi.fn()} />);
    const input = await screen.findByLabelText('快递合作具体内容、退改费、其他费用和特殊口径');
    fireEvent.change(input, { target: { value: '先输入' } });
    fireEvent.change(input, { target: { value: '离开前最后输入' } });
    view.unmount(); finish();
    await waitFor(() => expect(resourceApi.update).toHaveBeenLastCalledWith('finance-express-versions', 3, { remark: '离开前最后输入' }));
    vi.mocked(resourceApi.update).mockClear();
    vi.mocked(resourceApi.update).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as never); }));
    render(<VersionPanel carrier={carrier} branch={branch} version={version} onChanged={vi.fn()} />);
    const next = await screen.findByLabelText('快递合作具体内容、退改费、其他费用和特殊口径');
    fireEvent.change(next, { target: { value: '旧公司第一笔' } });
    fireEvent.change(next, { target: { value: '旧公司后续' } });
    localStorage.setItem('kudesi.token', 'synthetic-next-company'); finish();
    await waitFor(() => expect(resourceApi.update).toHaveBeenCalledTimes(1));
  });
  it('规则编辑带原版本提交；冲突保留输入，缺版本不调用写接口', async () => {
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ results:[{ok:false,code:'conflict',message:'资料刚被修改'}], saved:0, failed:1 } as never);
    const done=vi.fn();
    const view=render(<PriceRuleDialog rule={{id:4,version:'1234567890abcdef',province:'广东',fixedPrice:300}} onClose={vi.fn()} onSaved={done} />);
    expect(screen.getByRole('spinbutton', { name:'基础运费（元）' }).getAttribute('step')).toBe('any');
    fireEvent.change(screen.getByLabelText('基础运费（元）'), {target:{value:'4'}});
    fireEvent.click(screen.getByRole('button',{name:'保存修改'}));
    expect((await screen.findByRole('alert')).textContent).toContain('刚被修改');
    expect(done).not.toHaveBeenCalled();
    expect((screen.getByLabelText('基础运费（元）') as HTMLInputElement).value).toBe('4');
    view.unmount(); vi.mocked(resourceApi.gridSave).mockClear();
    render(<PriceRuleDialog rule={{id:4,province:'广东',fixedPrice:300}} onClose={vi.fn()} onSaved={done} />);
    fireEvent.click(screen.getByRole('button',{name:'保存修改'}));
    expect((await screen.findByRole('alert')).textContent).toContain('版本缺失');
    expect(resourceApi.gridSave).not.toHaveBeenCalled();
  });
  it('规则删除发送打开详情时版本，陈旧冲突留在确认窗', async () => {
    vi.mocked(expressApi.version).mockResolvedValue(detail);
    vi.mocked(resourceApi.remove).mockRejectedValue(new ApiError(409, '资料刚被别人修改'));
    render(<VersionPanel carrier={carrier} branch={branch} version={version} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button',{name:'删除 广东 0-1kg'}));
    fireEvent.click(within(screen.getByRole('dialog',{name:'确认删除'})).getByRole('button',{name:'确认删除'}));
    await waitFor(()=>expect(resourceApi.remove).toHaveBeenCalledWith('finance-express-prices',4,'人工确认删除价格规则','1234567890abcdef'));
    expect((await screen.findByRole('alert')).textContent).toContain('刚被别人修改');
  });
  it('价格规则用原生上下限条件，公式改统一价清除旧公式字段且保留备注', async () => {
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ results: [{ ok:true }], saved:1, failed:0 } as never);
    render(<PriceRuleDialog rule={{ id: 4, version: '1234567890abcdef', province: '广东', shipWeightMin: 0, shipWeightMax: 30, firstWeight: 0, firstPrice: 350, extraPrice: 50, note: '原备注' }} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('计费方式'), { target: { value: 'fixed' } });
    fireEvent.change(screen.getByLabelText('重量下限条件'), { target: { value: 'exclusive' } });
    fireEvent.change(screen.getByLabelText('基础运费（元）'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(resourceApi.gridSave).toHaveBeenCalledWith('finance-express-prices', expect.objectContaining({ updates:[expect.objectContaining({id:4, version:'1234567890abcdef', data:expect.objectContaining({ fixedPrice: 0, firstWeight: null, firstPrice: null, extraPrice: null, minExclusive: true, note: '原备注' })})] })));
  });
  it('手工加收按省份多选拆成一个批次，比例不转成分，0重量保留', async () => {
    vi.mocked(expressApi.createSurcharge).mockResolvedValue({ created: 2 });
    render(<SurchargeDialog versionId={3} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('加收名称'), { target: { value: '合成加收' } });
    fireEvent.change(screen.getByLabelText('加收方式'), { target: { value: 'percent' } });
    fireEvent.change(screen.getByLabelText('加收值'), { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: '选择省份' }));
    fireEvent.click(screen.getByLabelText('广东')); fireEvent.click(screen.getByLabelText('山东'));
    fireEvent.change(screen.getByLabelText('重量范围'), { target: { value: 'between' } });
    fireEvent.change(screen.getByLabelText('起始重量 kg'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('结束重量 kg'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存临时加收' }));
    await waitFor(() => expect(expressApi.createSurcharge).toHaveBeenCalledWith(3, expect.objectContaining({ batchName: '合成加收', rows: [expect.objectContaining({ areaScope: '广东', chargeType: 'percent', percent: 12.5, amount: null, weightStart: 0, weightEnd: 5 }), expect.objectContaining({ areaScope: '山东', percent: 12.5 })] })));
  });
});
