import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { FeeSnapshotsDialog } from './FeeSnapshotsDialog';

vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: vi.fn() }));
const m = vi.mocked(api);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('费用档案存档表', () => {
  it('列出存档，填名称存档；恢复要确认，恢复后通知刷新', async () => {
    const snap = { id: 3, name: '改前', remark: '', auto: false, categoryCount: 140, itemCount: 378, createdAt: '2026-10-27T08:00:00Z', restoredAt: null };
    m.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.endsWith('/restore')) return { restored: 518, stopped: 2 } as never;
      if (opts?.method === 'POST') return { id: 4 } as never;
      return [snap] as never;
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onRestored = vi.fn();
    render(<FeeSnapshotsDialog canWrite canDelete onClose={vi.fn()} onRestored={onRestored} />);
    await screen.findByText('改前');
    fireEvent.change(screen.getByLabelText('存档名称'), { target: { value: '整理前' } });
    fireEvent.click(screen.getByRole('button', { name: '存为历史包' }));
    await waitFor(() => expect(m).toHaveBeenCalledWith('/finance/fee-archive/snapshots', expect.objectContaining({ method: 'POST', body: { name: '整理前', remark: undefined } })));
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    await screen.findByText(/已恢复 518 条，停用 2 条/);
  });
  it('没有写权限时不出现存档和恢复按钮', async () => {
    m.mockResolvedValue([] as never);
    render(<FeeSnapshotsDialog canWrite={false} canDelete={false} onClose={vi.fn()} onRestored={vi.fn()} />);
    await screen.findByText(/暂无存档/);
    expect(screen.queryByRole('button', { name: '存为历史包' })).toBeNull();
  });
});
