import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FeeSettingsPage } from './FeeSettingsPage';
import { resourceApi } from '../../resources/api';

vi.mock('../../resources/api', async (orig) => {
  const mod = await orig<typeof import('../../resources/api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), update: vi.fn() } };
});

const phone = (id: number, number: string) => ({
  id, type: 'phones', title: number, status: 'normal', statusReason: null,
  data: { carrier: '中国移动', plan: '基础套餐', monthlyFee: 3000, rechargeCycleDays: 30 }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '',
});

describe('费用模块', () => {
  beforeEach(() => {
    cleanup();
    vi.mocked(resourceApi.list).mockResolvedValue({ items: [phone(1, '13700000001'), phone(2, '13700000002')], total: 2, page: 1, pageSize: 20 });
    vi.mocked(resourceApi.update).mockResolvedValue(phone(1, '13700000001'));
  });

  it('勾选多条、预览差异、确认后逐条写回手机号档案', async () => {
    render(<FeeSettingsPage />);
    await screen.findByText('13700000001');
    fireEvent.click(screen.getByLabelText('勾选 13700000001'));
    fireEvent.click(screen.getByLabelText('勾选 13700000002'));
    fireEvent.click(screen.getByLabelText('改套餐名'));
    fireEvent.change(screen.getByLabelText('套餐名'), { target: { value: '大流量套餐' } });
    fireEvent.click(screen.getByText('预览修改'));
    const region = await screen.findByRole('region', { name: '修改预览' });
    expect(region.textContent).toContain('基础套餐 → 大流量套餐');
    expect(resourceApi.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('确认保存'));
    await waitFor(() => expect(resourceApi.update).toHaveBeenCalledTimes(2));
    expect(resourceApi.update).toHaveBeenCalledWith('phones', 1, { plan: '大流量套餐' });
  });

  it('搜索走服务端，按关键字重新加载', async () => {
    render(<FeeSettingsPage />);
    await screen.findByText('13700000001');
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '0002' } });
    await waitFor(() => expect(resourceApi.list).toHaveBeenLastCalledWith('phones', expect.objectContaining({ keyword: '0002', page: 1 })));
  });
});
