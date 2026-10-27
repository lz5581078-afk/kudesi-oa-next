import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { JstSyncCenterPage } from './JstSyncCenterPage';

vi.mock('../../api/client', async (orig) => ({ ...(await orig<typeof import('../../api/client')>()), api: vi.fn() }));
const apiMock = vi.mocked(api);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const overview = {
  switch: { enabled: false, note: null, updatedAt: null }, priceSwitch: { enabled: false, note: null, updatedAt: null }, senderConfigured: false,
  counts: { pending: 2, failed: 1 }, byKind: { bundle_upsert: { pending: 2, failed: 1 } }, oldestPendingAt: '2026-10-01T02:00:00.000Z',
  failures: [{ id: 9, kind: 'bundle_upsert', resourceType: 'finance-bundles', resourceId: 5, attempts: 3, lastError: '还没有接入聚水潭接口', createdAt: '2026-10-01T02:00:00.000Z' }],
};

describe('聚水潭同步能力中心', () => {
  it('显示真实对外同步状态：总开关关闭、发送器未接入、队列和失败原因；只读，没有任何写入按钮', async () => {
    apiMock.mockResolvedValue(overview as never);
    render(<MemoryRouter><JstSyncCenterPage /></MemoryRouter>);
    expect(await screen.findByText('已关闭（不会发送）')).toBeTruthy();
    expect(screen.getByText(/未接入（队列只积压，不发送）/)).toBeTruthy();
    expect(screen.getByText(/排队中 2 · 失败 1/)).toBeTruthy();
    expect(screen.getByText(/还没有接入聚水潭接口/)).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/system/jst-center');
    expect(screen.queryByRole('button', { name: /同步|开关/ })).toBeNull();
  });
  it('能力地图、实测记录按模块筛选、同步任务建议、保护规则都在', async () => {
    apiMock.mockResolvedValue(overview as never);
    render(<MemoryRouter><JstSyncCenterPage /></MemoryRouter>);
    await screen.findByText('已关闭（不会发送）');
    expect(screen.getByRole('region', { name: '商品资料' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '订单履约' })).getByText(/还没有订单模块/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('按模块筛选'), { target: { value: '售后' } });
    expect(screen.getAllByText('/open/refund/single/query').length).toBeGreaterThan(0);
    expect(screen.queryByText('/open/supplier/query', { selector: 'td code' })).toBeNull();
    expect(screen.getByText('财务费用同步')).toBeTruthy();
    expect(screen.getByText(/出站队列与总开关/)).toBeTruthy();
  });
  it('加载失败给重试', async () => {
    apiMock.mockRejectedValueOnce(new Error('x')).mockResolvedValue(overview as never);
    render(<MemoryRouter><JstSyncCenterPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(screen.getByText('重试'));
    expect(await screen.findByText('已关闭（不会发送）')).toBeTruthy();
  });
});
