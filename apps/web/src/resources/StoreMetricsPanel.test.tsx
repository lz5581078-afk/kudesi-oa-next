import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StoreMetricsPanel } from './StoreMetricsPanel';
import { resourceApi } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn() } };
});

const row = (id: number, type: string, data: Record<string, unknown>) => ({ id, type, title: String(id), status: 'recorded', statusReason: null, data, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' });

describe('店铺经营数据面板', () => {
  beforeEach(() => cleanup());
  it('只展示每类数据最新一次快照', async () => {
    vi.mocked(resourceApi.list).mockImplementation(async (type: string) => {
      const items = type === 'store-daily-metrics'
        ? [row(1, type, { day: '2026-10-26', orders: 5, sales: 10000 }), row(2, type, { day: '2026-10-20', orders: 99, sales: 1 })]
        : type === 'store-scores'
          ? [row(3, type, { snapshotDate: '2026-10-25', dimension: 'experience', metric: '体验分', value: '4.8' }), row(4, type, { snapshotDate: '2026-10-01', dimension: 'experience', metric: '旧指标', value: '1' })]
          : [];
      return { items, total: items.length, page: 1, pageSize: 200 };
    });
    const store = row(9, 'stores', { deposit: 50000 });
    render(<StoreMetricsPanel store={store as never} />);
    expect(await screen.findByText('体验分')).toBeTruthy();
    expect(screen.queryByText('旧指标')).toBeNull();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.queryByText('99')).toBeNull();
  });
});
