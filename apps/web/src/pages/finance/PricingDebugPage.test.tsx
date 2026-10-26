import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { financeApi, type DebugRow } from './financeApi';
import { PricingDebugPage } from './PricingDebugPage';
import { selectPricingPage, sortPricingRows } from './pricing-selection';

vi.mock('./financeApi', async (orig) => {
  const real = await orig<typeof import('./financeApi')>();
  return { ...real, financeApi: { debugList: vi.fn(), debugSlider: vi.fn(), debugQuote: vi.fn(), debugExport: vi.fn(), debugComponents: vi.fn() } };
});
const m = vi.mocked(financeApi);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const r = (id: number, name: string, weightG: number | null, min: number | null = 2000): DebugRow => ({ id, skuCode: `C${id}`, skuName: name, categoryId: 1, categoryName: '水果', ready: min !== null, weightG, minPriceCents: min });

describe('定价调试表：选择规则', () => {
  it('按重量由轻到重，没有重量的排最后；全选当前页不影响其它页已选', () => {
    const rows = [r(1, '丙', null), r(2, '乙', 3000), r(3, '甲', 1000), r(4, '丁', 0)];
    expect(sortPricingRows(rows).map((x) => x.id)).toEqual([3, 2, 1, 4]);
    const other = r(9, '别页', 500);
    const next = selectPricingPage({ 9: other }, rows, true);
    expect(Object.keys(next).sort()).toEqual(['1', '2', '3', '4', '9']);
    expect(Object.keys(selectPricingPage(next, rows, false))).toEqual(['9']);
  });
});

describe('定价调试表页面', () => {
  const setup = () => {
    m.debugList.mockResolvedValue({ rows: [r(1, '苹果礼盒', 2000), r(2, '梨礼盒', 1000), r(3, '没运费的', 500, null)], total: 3, page: 1, pageSize: 30, canViewInternals: true });
    m.debugSlider.mockImplementation(async ({ step }) => ({ available: true, reservedProfitCents: step * 20, reservedProfitPercent: step, priceCents: 2000 + step * 20, step }));
    return render(<PricingDebugPage />);
  };

  it('列表按重量排序、显示公司低价，没价格的标“暂不可试算”', async () => {
    setup();
    await screen.findByText('苹果礼盒');
    const names = screen.getAllByRole('checkbox').slice(1).map((c) => c.closest('label')!.textContent);
    expect(names[0]).toContain('没运费的'); // 500g 最轻
    expect(names[0]).toContain('暂不可试算');
    expect(names[1]).toContain('梨礼盒');
    expect(names[2]).toContain('苹果礼盒');
  });

  it('选到右侧后拉滑块，向服务端要预留利润后的售价；填投产联动出售价', async () => {
    setup();
    m.debugQuote.mockResolvedValue({ rows: [{ id: 1, available: true, priceCents: 3000, roi: 3 }] });
    await screen.findByText('苹果礼盒');
    fireEvent.click(screen.getAllByRole('checkbox').find((c) => c.closest('label')?.textContent?.includes('苹果礼盒'))!);
    await screen.findByLabelText('苹果礼盒 预留利润');
    fireEvent.change(screen.getByLabelText('苹果礼盒 预留利润'), { target: { value: '10' } });
    await waitFor(() => expect(m.debugSlider).toHaveBeenLastCalledWith({ id: 1, step: 10, profit: undefined }), { timeout: 2000 });
    await screen.findByText(/预留利润后售价 ¥22\.00/);
    fireEvent.change(screen.getByLabelText('苹果礼盒 目标投产'), { target: { value: '3' } });
    await waitFor(() => expect(m.debugQuote).toHaveBeenCalledWith({ mode: 'roiToPrice', inputs: [{ id: 1, value: 3, step: 10, profit: undefined }] }), { timeout: 2000 });
    await waitFor(() => expect((screen.getByLabelText('苹果礼盒 试算售价') as HTMLInputElement).value).toBe('30.00'));
  });

  it('同步利润率：按这个商品填的利润金额，同步右侧所有已选商品（金额用分传给服务端）', async () => {
    setup();
    m.debugQuote.mockResolvedValue({ rows: [] });
    await screen.findByText('苹果礼盒');
    for (const name of ['苹果礼盒', '梨礼盒']) fireEvent.click(screen.getAllByRole('checkbox').find((c) => c.closest('label')?.textContent?.includes(name))!);
    await screen.findByLabelText('梨礼盒 预留利润');
    await waitFor(() => expect((screen.getByLabelText('梨礼盒 手填预留利润金额') as HTMLInputElement).value).toBe('0.00'), { timeout: 2000 });
    fireEvent.change(screen.getByLabelText('梨礼盒 手填预留利润金额'), { target: { value: '5.5' } });
    m.debugSlider.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: '同步利润率' })[0]);
    await waitFor(() => expect(m.debugSlider).toHaveBeenCalledTimes(2), { timeout: 2000 });
    const profits = m.debugSlider.mock.calls.map((c) => c[0].profit);
    expect(profits).toEqual([{ id: 2, amountCents: 550 }, { id: 2, amountCents: 550 }]);
    await screen.findByText(/已按当前商品的利润比例同步 2 项/);
  });

  it('导出：把页面上的试算结果交给服务端核对；服务端说数据变了（409）就提示并重新试算', async () => {
    setup();
    URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn();
    m.debugExport.mockRejectedValueOnce(new ApiError(409, '预留利润后售价已变化，请重新调试后导出'));
    await screen.findByText('苹果礼盒');
    fireEvent.click(screen.getAllByRole('checkbox').find((c) => c.closest('label')?.textContent?.includes('苹果礼盒'))!);
    await screen.findByLabelText('苹果礼盒 预留利润');
    const exportBtn = screen.getByRole('button', { name: '导出 Excel' }) as HTMLButtonElement;
    await waitFor(() => expect(exportBtn.disabled).toBe(false), { timeout: 2000 });
    fireEvent.click(exportBtn);
    await screen.findByText('预留利润后售价已变化，请重新调试后导出');
    expect(m.debugExport).toHaveBeenCalledWith([expect.objectContaining({ id: 1, mode: 'sliderPrice', step: 0, sliderPriceCents: 2000 })]);
    await waitFor(() => expect(m.debugSlider.mock.calls.length).toBeGreaterThan(1), { timeout: 2000 });
  });

  it('每 30 秒自动刷新列表', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup();
      await screen.findByText('苹果礼盒');
      const n = m.debugList.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30100);
      expect(m.debugList.mock.calls.length).toBeGreaterThan(n);
    } finally { vi.useRealTimers(); }
  });
});
