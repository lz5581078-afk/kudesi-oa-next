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
          : type === 'store-funds'
            ? [row(5, type, { snapshotDate: '2026-10-25', deposit: 50000, frozen: 300, withdrawable: 777700, promotion: 1200 }), row(6, type, { snapshotDate: '2026-09-01', deposit: 1, frozen: 1, withdrawable: 1, promotion: 1 })]
            : [];
      return { items, total: items.length, page: 1, pageSize: 200 };
    });
    const store = row(9, 'stores', { deposit: 99999 });
    render(<StoreMetricsPanel store={store as never} />);
    expect(await screen.findByText('体验分')).toBeTruthy();
    expect(screen.queryByText('旧指标')).toBeNull();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.queryByText('99')).toBeNull();
  });

  it('店铺资金只显示最新快照一列，没有“档案登记 / 需确认”之分', async () => {
    vi.mocked(resourceApi.list).mockImplementation(async (type: string) => {
      const items = type === 'store-funds'
        ? [row(5, type, { snapshotDate: '2026-10-25', deposit: 50000, frozen: 300, withdrawable: 777700, promotion: 1200 }), row(6, type, { snapshotDate: '2026-09-01', deposit: 1, frozen: 1, withdrawable: 1, promotion: 1 })]
        : [];
      return { items, total: items.length, page: 1, pageSize: 200 };
    });
    const { container } = render(<StoreMetricsPanel store={row(9, 'stores', { deposit: 99999 }) as never} />);
    expect(await screen.findByText('货款（可提现）')).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).toContain('快照 2026-10-25');
    expect(text).toMatch(/保证金500\.00|保证金¥?500/);
    expect(text).not.toContain('档案登记');
    expect(text).not.toContain('需确认');
    expect(text).not.toContain('999.99'); // 档案上残留的手填值不参与显示
  });
});
