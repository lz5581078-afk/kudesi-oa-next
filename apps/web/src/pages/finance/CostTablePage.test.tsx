import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { CurrentCostTable as CostTablePage } from './CostTablePage';
import { financeApi, type CostRow, type CostTableData } from './financeApi';

vi.mock('./financeApi', async (orig) => {
  const real = await orig<typeof import('./financeApi')>();
  return { ...real, financeApi: { exportCostTable: vi.fn(), costTable: vi.fn(), saveCostPricing: vi.fn(), saveCategoryMargin: vi.fn(), skuCostHistory: vi.fn() } };
});
const m = vi.mocked(financeApi);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const row = (over: Partial<CostRow> = {}): CostRow => ({
  bundleId: 7, code: 'ZH-TB-001', name: '苹果礼盒', status: 'verified', categoryId: 3, categoryName: '苹果类', preShipCostCents: 10250, weightG: 2500,
  freightCents: 800, freightMethod: '手工填写', marginPercent: 12.345678, marginSource: '本分类', marginOverride: false, inheritedMargin: { percent: 12.345678, source: '本分类' },
  carrierName: '顺丰', costIncludingFreightCents: 11050, revision: 'rev1', minPriceCents: 12604, issues: [],
  lines: [{ role: 'main', code: 'APPLE', name: '红富士', qty: 1, unitCostCents: 10250, subtotalCents: 10250, unitWeightG: 2500, weightG: 2500 }], ...over,
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
  it('分类目录显示数量和继承的利润率；列表有成本、使用快递、含快递成本；利润率保留 6 位小数', async () => {
    m.costTable.mockResolvedValue(table(true));
    renderPage();
    await screen.findByText('ZH-TB-001');
    expect(screen.getByText('全部')).toBeTruthy();
    expect(screen.getByText(/默认利润率 15%/)).toBeTruthy();
    expect(screen.getByText(/12\.345678% · 分类设置/)).toBeTruthy();
    expect(screen.getByText(/15% · 继承/)).toBeTruthy();
    expect(screen.getByText('顺丰')).toBeTruthy();
    expect(screen.getByText('¥110.50')).toBeTruthy(); // 含快递成本
    expect(screen.getByText('¥126.04')).toBeTruthy(); // 最低售价
    fireEvent.click(screen.getByRole('button', { name: '苹果类 3 12.345678% · 分类设置' }));
    await waitFor(() => expect(m.costTable).toHaveBeenLastCalledWith(expect.objectContaining({ categoryId: 3 })));
  });

  it('没有编辑权限的人看不到“维护售价”和分类“设置”；仍能看成本历史', async () => {
    m.costTable.mockResolvedValue(table(false));
    renderPage();
    await screen.findByText('ZH-TB-001');
    expect(screen.queryByRole('button', { name: /维护.*售价/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /设置.*利润率/ })).toBeNull();
    expect(screen.getByRole('button', { name: /查看.*成本历史/ })).toBeTruthy();
  });

  it('点成本弹出成本组成；点重量弹出重量组成', async () => {
    m.costTable.mockResolvedValue(table(false));
    renderPage();
    await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button', { name: '查看苹果礼盒成本组成' }));
    expect(screen.getByRole('dialog', { name: '成本组成明细' })).toBeTruthy();
    expect(screen.getByText('红富士')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭组成明细' }));
    fireEvent.click(screen.getByRole('button', { name: '查看苹果礼盒重量组成' }));
    expect(screen.getByRole('dialog', { name: '重量组成明细' })).toBeTruthy();
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

  it('导出 Excel：带着当前分类和搜索条件，导出结果交给浏览器下载', async () => {
    m.costTable.mockResolvedValue(table(true));
    m.exportCostTable.mockResolvedValue({ fileName: 'SKU成本表.xlsx', fileBase64: 'AAEC', rowCount: 1 });
    const url = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: url, revokeObjectURL: vi.fn() });
    renderPage();
    await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByText('苹果类'));
    fireEvent.click(screen.getByRole('button', { name: '导出 Excel' }));
    await waitFor(() => expect(m.exportCostTable).toHaveBeenCalledWith({ categoryId: 3, keyword: undefined }));
    await screen.findByText(/已导出 1 条/);
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

describe('SKU成本表：使用细节', () => {
  it('SKU组合编码可一键复制；有搜索条件时出现“清除筛选”', async () => {
    m.costTable.mockResolvedValue(table(true));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage();
    await screen.findByText('ZH-TB-001');
    fireEvent.click(screen.getByRole('button', { name: '复制SKU组合编码' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ZH-TB-001'));
    expect(screen.queryByRole('button', { name: '清除筛选' })).toBeNull();
    fireEvent.change(screen.getByLabelText('搜索SKU成本'), { target: { value: '苹果' } });
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect((screen.getByLabelText('搜索SKU成本') as HTMLInputElement).value).toBe('');
  });
});
