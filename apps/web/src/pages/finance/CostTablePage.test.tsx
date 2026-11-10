import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { CurrentCostTable as CostTablePage } from './CostTablePage';
import { CostRegistrationDialog } from './CostRegistrationDialog';
import { costBreakdown } from '@kudesi/shared';
import { financeApi, type CostRow, type CostTableData } from './financeApi';

const identity = vi.hoisted(() => ({user:{companyId:1,id:1,permissions:{isCompanyAdmin:false,allow:['product.cost.view','product.price.view'],deny:[] as string[]}}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>identity}));
vi.mock('./financeApi', async (orig) => {
  const real = await orig<typeof import('./financeApi')>();
  return { ...real, financeApi: { exportCostTable: vi.fn(), previewCostRegistration: vi.fn(), registerCost: vi.fn(), costTable: vi.fn(), saveCostPricing: vi.fn(), saveCategoryMargin: vi.fn(), skuCostHistory: vi.fn() } };
});
const m = vi.mocked(financeApi);
afterEach(() => { identity.user={companyId:1,id:1,permissions:{isCompanyAdmin:false,allow:['product.cost.view','product.price.view'],deny:[] as string[]}}; cleanup(); vi.clearAllMocks(); });

const row = (over: Partial<CostRow> = {}): CostRow => ({
  bundleId: 7, code: 'ZH-TB-001', name: '苹果礼盒', status: 'verified', categoryId: 3, categoryName: '苹果类', preShipCostCents: 10250, weightG: 2500,
  freightCents: 800, freightMethod: '手工填写', marginPercent: 12.345678, marginSource: '本分类', marginOverride: false, inheritedMargin: { percent: 12.345678, source: '本分类' },
  carrierName: '顺丰', costIncludingFreightCents: 11050, revision: 'rev1', minPriceCents: 12604, issues: [],
  lines: [{ role: 'main', code: 'APPLE', name: '红富士', qty: 1, unitName: '斤', unitCostCents: 10250, subtotalCents: 10250, unitWeightG: 2500, weightG: 2500 }], ...over,
});
const table = (canEdit: boolean, rows = [row()]): CostTableData => ({
  total: rows.length, page: 1, pageSize: 20, rows, allTotal: 5, canEdit, defaultMargin: { percent: 15, revision: 'none' },
  categories: [
    { id: 2, name: '水果礼盒', parentId: null, ownPercent: null, percent: 15, source: '全部默认', revision: 'none', count: 5 },
    { id: 3, name: '苹果类', parentId: 2, ownPercent: 12.345678, percent: 12.345678, source: '本分类', revision: 'r3', count: 3 },
  ],
});
const renderPage = () => render(<MemoryRouter><CostTablePage /></MemoryRouter>);

describe('当前SKU成本清单', () => {
  it('异常行展示沿用结果和缺项，维护弹窗仍使用当前配置', async () => {
    m.costTable.mockResolvedValue(table(true, [row({ costState: 'fallback', lastSuccessfulAt: '2026-11-10T08:00:00Z', issues: ['缺少运费预估'], pricingSettings: { carrierName: '当前快递', ownPercent: 25 } })]));
    renderPage();
    await screen.findByText('沿用上次有效成本');
    expect(screen.getByText('缺少运费预估')).toBeTruthy();
    expect(screen.getByText(/有效成本更新于/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '维护苹果礼盒售价' }));
    expect(screen.getByDisplayValue('当前快递')).toBeTruthy();
    expect(screen.getByDisplayValue('25')).toBeTruthy();
  });

  it('分类目录显示数量和继承的利润率；列表有成本、使用快递、含快递成本；利润率保留 6 位小数', async () => {
    m.costTable.mockResolvedValue(table(true));
    renderPage();
    await screen.findByText('ZH-TB-001');
    expect(screen.getByText('全部')).toBeTruthy();
    expect(screen.getByText(/默认利润率 15%/)).toBeTruthy();
    expect(screen.getByText(/12\.345678% · 分类设置/)).toBeTruthy();
    expect(screen.getByText(/15% · 继承/)).toBeTruthy();
    expect(screen.getByText('顺丰')).toBeTruthy();
    expect(screen.getByText('¥110.500')).toBeTruthy(); // 含快递成本
    expect(screen.getByText('¥126.04')).toBeTruthy(); // 最低售价
    fireEvent.click(screen.getByRole('button', { name: '苹果类 3 12.345678% · 分类设置' }));
    await waitFor(() => expect(m.costTable).toHaveBeenLastCalledWith(expect.objectContaining({ categoryId: 3 })));
  });

  it('六位元成本和细小重量在组成窗保留，Escape关闭组成窗', async () => {
    const precise = row({preShipCostCents:0.0123, weightG:0.123, lines:[{role:'main',code:'FINE',name:'细小用量',qty:1,unitName:'克',unitCostCents:0.0123,subtotalCents:0.0123,unitWeightG:0.123,weightG:0.123}]});
    m.costTable.mockResolvedValue(table(false,[precise]));
    renderPage(); await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button',{name:'查看苹果礼盒成本组成'}));
    expect(screen.getAllByText('¥0.000123').length).toBeGreaterThan(1);
    fireEvent.keyDown(document,{key:'Escape'});
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'查看苹果礼盒重量组成'}));
    expect(screen.getAllByText('0.000123 kg').length).toBeGreaterThan(1);
  });

  it('没有编辑权限的人看不到“维护售价”和分类“设置”；仍能看成本历史', async () => {
    m.costTable.mockResolvedValue(table(false));
    renderPage();
    await screen.findByText('ZH-TB-001');
    expect(screen.queryByRole('button', { name: /维护.*售价/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /设置.*利润率/ })).toBeNull();
    expect(screen.getByRole('button', { name: /查看.*成本历史/ })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '预发货成本' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '重量（kg）' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: '状态' })).toBeNull();
  });

  it('点成本弹出成本组成；点重量弹出重量组成', async () => {
    m.costTable.mockResolvedValue(table(false));
    renderPage();
    await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button', { name: '查看苹果礼盒成本组成' }));
    expect(screen.getByRole('dialog', { name: '成本组成明细' })).toBeTruthy();
    expect(screen.getByText('1 斤')).toBeTruthy();
    expect(screen.getByText('红富士')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭组成明细' }));
    fireEvent.click(screen.getByRole('button', { name: '查看苹果礼盒重量组成' }));
    expect(screen.getByRole('dialog', { name: '重量组成明细' })).toBeTruthy();
  });

  it('成本与重量分别展示匹配的来源，保留快照名称单位；手工重量差额明确提示', async () => {
    const current = row();
    const verified = { preShipCostCents: current.preShipCostCents, weightG: 1000, lines: [{ ...current.lines[0], name: '验证时的苹果', unitName: '袋', unitWeightG: 1000, weightG: 1000 }] };
    current.breakdown = costBreakdown(current, verified);
    m.costTable.mockResolvedValue(table(false, [current]));
    renderPage(); await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button', { name: '查看苹果礼盒成本组成' }));
    expect(screen.getByText('明细来源：验证快照')).toBeTruthy();
    expect(screen.getByText('验证时的苹果')).toBeTruthy();
    expect(screen.getByText('1 袋')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭组成明细' }));
    fireEvent.click(screen.getByRole('button', { name: '查看苹果礼盒重量组成' }));
    expect(screen.getByText('明细来源：当前组成')).toBeTruthy();
  });

  it('手工计费重量不等于组成重量时显示差额', async () => {
    m.costTable.mockResolvedValue(table(false, [row({ weightG: 2600 })]));
    renderPage(); await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button', { name: '查看苹果礼盒重量组成' }));
    expect(screen.getByText(/差额 0.100000 kg/)).toBeTruthy();
  });

  it('补齐先只读预览，确认才提交签名；问题清单保留，已有记录不覆盖', async () => {
    m.costTable.mockResolvedValue({ ...table(true), canFill: true });
    m.previewCostRegistration.mockResolvedValue({ signature: 'preview-token', rows: [{ id: 8, code: 'MISSING-8', name: '待补组合', costCents: 100, weightG: 500 }], issues: [{ id: 9, code: 'BAD-9', issues: ['缺少有效重量'] }] });
    m.registerCost.mockResolvedValue({ recorded: 1, unchanged: 0 });
    renderPage(); await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button', { name: '补齐已验证SKU' }));
    await screen.findByRole('dialog', { name: '补齐已验证SKU' });
    expect(screen.getByText('待补齐 1 条 · 需核对 1 条')).toBeTruthy();
    expect(screen.getByText('BAD-9：缺少有效重量')).toBeTruthy();
    expect(m.registerCost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认补齐 1 条' }));
    await screen.findByText('已补齐 1 条SKU成本');
    expect(m.registerCost).toHaveBeenCalledWith(expect.objectContaining({ missingOnly: true, confirmed: true, signature: 'preview-token' }));
  });

  it('预览没有待补SKU时确认按钮禁用，仍能重新预览或关闭', async () => {
    m.costTable.mockResolvedValue({ ...table(true), canFill: true });
    m.previewCostRegistration.mockResolvedValue({ signature: 'empty', rows: [], issues: [] });
    renderPage(); await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button', { name: '补齐已验证SKU' }));
    await screen.findByRole('dialog', { name: '补齐已验证SKU' });
    expect((screen.getByRole('button', { name: '确认补齐 0 条' }) as HTMLButtonElement).disabled).toBe(true);
    expect(m.registerCost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '关闭补齐预览' }));
    expect(screen.queryByRole('dialog', { name: '补齐已验证SKU' })).toBeNull();
  });

  it('补齐冲突留在预览内，重新预览后才带新签名重试', async () => {
    m.costTable.mockResolvedValue({ ...table(true), canFill: true });
    m.previewCostRegistration.mockResolvedValue({ signature: 'old', rows: [{ id: 7, code: 'SKU-7', name: '合成组合', costCents: 102, weightG: 500 }], issues: [] });
    m.registerCost.mockRejectedValueOnce(new ApiError(409, '预览之后资料已变化，请重新预览再补齐')).mockResolvedValueOnce({ recorded: 1, unchanged: 0 });
    renderPage(); await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button', { name: '补齐已验证SKU' }));
    await screen.findByRole('dialog', { name: '补齐已验证SKU' });
    fireEvent.click(screen.getByRole('button', { name: '确认补齐 1 条' }));
    const error = await screen.findByRole('alert');
    expect(screen.getByRole('dialog').contains(error)).toBe(true);
    m.previewCostRegistration.mockResolvedValue({ signature: 'new', rows: [{ id: 7, code: 'SKU-7', name: '合成组合', costCents: 103, weightG: 500 }], issues: [] });
    fireEvent.click(screen.getByRole('button', { name: '重新预览' }));
    await screen.findByText('¥1.030 · 0.5 kg');
    fireEvent.click(screen.getByRole('button', { name: '确认补齐 1 条' }));
    await screen.findByText('已补齐 1 条SKU成本');
    expect(m.registerCost).toHaveBeenLastCalledWith(expect.objectContaining({ signature: 'new' }));
  });

  it('维护售价：必须写原因；利润率最多 6 位小数；带上乐观锁令牌；保存后刷新', async () => {
    m.costTable.mockResolvedValue(table(true));
    m.saveCostPricing.mockResolvedValue({ ok: true, changed: true });
    renderPage();
    await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button', { name: '维护苹果礼盒售价' }));
    const dialog = screen.getByRole('dialog', { name: '维护售价' });
    expect(dialog).toBeTruthy();
    const save = screen.getByRole('button', { name: '确认保存并生效' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // 没写原因不能保存
    fireEvent.click(screen.getByLabelText('单独设置利润率'));
    fireEvent.change(screen.getByLabelText('利润率（%）'), { target: { value: '12.3456789' } });
    fireEvent.change(screen.getByLabelText('修改原因'), { target: { value: '大客户' } });
    fireEvent.click(save);
    await screen.findByText(/最多保留 6 位小数/);
    expect(m.saveCostPricing).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('利润率（%）'), { target: { value: '33.333333' } });
    fireEvent.change(screen.getByLabelText('使用快递'), { target: { value: '中通' } });
    fireEvent.click(save);
    await waitFor(() => expect(m.saveCostPricing).toHaveBeenCalledWith(7, { revision: 'rev1', carrierName: '中通', profitPercent: 33.333333, reason: '大客户' }));
    await screen.findByText(/已保存，售价已按最新规则更新/);
    expect(m.costTable.mock.calls.length).toBeGreaterThan(1);
  });

  it('别人先改过：显示服务端的冲突提示，并刷新数据', async () => {
    m.costTable.mockResolvedValue(table(true));
    m.saveCostPricing.mockRejectedValue(new ApiError(409, '成本资料已变化，请刷新后重新核对'));
    renderPage();
    await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button', { name: '维护苹果礼盒售价' }));
    fireEvent.change(screen.getByLabelText('修改原因'), { target: { value: '改一下' } });
    const before = m.costTable.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '确认保存并生效' }));
    await screen.findByText('成本资料已变化，请刷新后重新核对');
    await waitFor(() => expect(m.costTable.mock.calls.length).toBeGreaterThan(before));
  });

  it('设置分类利润率走分类接口；“全部默认”的编号是 0', async () => {
    m.costTable.mockResolvedValue(table(true));
    m.saveCategoryMargin.mockResolvedValue({ ok: true, changed: true });
    renderPage();
    await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button', { name: '设置全部默认利润率' }));
    fireEvent.change(screen.getByLabelText('利润率（%）'), { target: { value: '18.5' } });
    fireEvent.change(screen.getByLabelText('修改原因'), { target: { value: '整体上调' } });
    fireEvent.click(screen.getByRole('button', { name: '确认保存并生效' }));
    await waitFor(() => expect(m.saveCategoryMargin).toHaveBeenCalledWith(0, { revision: 'none', profitPercent: 18.5, reason: '整体上调' }));
  });

  it.each(['company','user','permissions'])('切换%s后清空成本与弹窗，旧身份的迟到读取不回填', async field => {
    let finish!: (value: CostTableData) => void;
    m.costTable.mockResolvedValueOnce(table(true)).mockImplementationOnce(() => new Promise(resolve => {finish=resolve;})).mockResolvedValue(table(false,[]));
    const view=renderPage();await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button',{name:'刷新成本表'}));
    await waitFor(() => expect(finish).toBeTruthy());
    fireEvent.click(screen.getByRole('button',{name:'查看苹果礼盒成本组成'}));
    if(field==='company') identity.user={...identity.user,companyId:2};
    else if(field==='user') identity.user={...identity.user,id:2};
    else identity.user={...identity.user,permissions:{...identity.user.permissions,allow:[],deny:['product.cost.view']}};
    view.rerender(<MemoryRouter><CostTablePage/></MemoryRouter>);
    expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByText('ZH-TB-001')).toBeNull();
    finish(table(true,[row({code:'OLD-SCOPE'})]));
    await waitFor(() => expect(m.costTable).toHaveBeenCalledTimes(3));
    expect(screen.queryByText('OLD-SCOPE')).toBeNull();
  });

  it('后台刷新失败保留原记录同时显示读取失败，不静默冒充刷新成功',async()=>{
    m.costTable.mockResolvedValue(table(false));renderPage();await screen.findByText('ZH-TB-001');
    m.costTable.mockRejectedValueOnce(new ApiError(503,'合成成本后台刷新失败'));
    window.dispatchEvent(new Event('focus'));
    expect((await screen.findByRole('alert')).textContent).toContain('合成成本后台刷新失败');
    expect(screen.getByText('ZH-TB-001')).toBeTruthy();
  });

  it('每 15 秒自动刷新一次', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.costTable.mockResolvedValue(table(false));
      renderPage();
      await screen.findByText('ZH-TB-001');
      const n = m.costTable.mock.calls.length;
      await vi.advanceTimersByTimeAsync(15100);
      expect(m.costTable.mock.calls.length).toBeGreaterThan(n);
    } finally { vi.useRealTimers(); }
  });
});

describe('SKU成本表原入口', () => {
  it('仅保留原刷新和补齐动作，没有额外导出、清筛或编码复制按钮', async () => {
    m.costTable.mockResolvedValue(table(true));renderPage();await screen.findByText('ZH-TB-001');
    expect(screen.getByRole('button',{name:'刷新成本表'})).toBeTruthy();
    for(const name of ['导出 Excel','清除筛选','复制SKU组合编码']) expect(screen.queryByRole('button',{name})).toBeNull();
    fireEvent.change(screen.getByLabelText('搜索SKU成本'),{target:{value:'苹果'}});
    expect(screen.queryByRole('button',{name:'清除筛选'})).toBeNull();
  });
});

describe('补齐已验证SKU窗口', () => {
  it('Escape关闭预览，正在补齐时保留窗口且不能关闭', () => {
    const close=vi.fn();
    const props={preview:{rows:[],issues:[],signature:'synthetic'},error:'',onClose:close,onRefresh:vi.fn(),onConfirm:vi.fn()};
    const view=render(<CostRegistrationDialog {...props} busy={false}/>);
    fireEvent.keyDown(document,{key:'Escape'});expect(close).toHaveBeenCalledOnce();
    close.mockClear();view.rerender(<CostRegistrationDialog {...props} busy/>);
    fireEvent.keyDown(document,{key:'Escape'});expect(close).not.toHaveBeenCalled();
    expect((screen.getByRole('button',{name:'关闭补齐预览'}) as HTMLButtonElement).disabled).toBe(true);
  });
});
