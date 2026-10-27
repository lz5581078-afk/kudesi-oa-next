import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceDto } from './api';

const transition = vi.fn().mockResolvedValue({});
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  assetApi: { transition: (...a: unknown[]) => transition(...a), details: vi.fn(), inventory: vi.fn(), locationContents: vi.fn() },
}));
vi.mock('./RecordForm', () => ({
  loadRefOptions: async (t: string) => (t === 'user' ? [{ value: 7, label: '小李' }, { value: 8, label: '小王', disabled: true }] : [{ value: 3, label: '302 房' }]),
}));
import { AssetActionBar } from './AssetPanels';

const asset = (status: string, data: Record<string, unknown> = {}): ResourceDto => ({
  id: 5, type: 'fixed-assets', title: '笔记本', status, statusReason: null, data, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '',
});

afterEach(() => { cleanup(); transition.mockClear(); });

describe('固定资产流转按钮', () => {
  it('按状态只给能办的动作', () => {
    const { unmount } = render(<AssetActionBar record={asset('idle')} onDone={() => undefined} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['领用', '送修', '标记丢失', '报废']);
    unmount();
    render(<AssetActionBar record={asset('repairing')} onDone={() => undefined} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['维修完成', '报废']);
  });

  it('报废是终态，没有按钮', () => {
    render(<AssetActionBar record={asset('retired')} onDone={() => undefined} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('领用必须选使用人；停用员工不能选；提交后回调', async () => {
    const done = vi.fn();
    render(<AssetActionBar record={asset('idle')} onDone={done} />);
    fireEvent.click(screen.getByText('领用'));
    await screen.findByText('小李');
    expect(screen.queryByText('小王')).toBeNull();
    fireEvent.click(screen.getByText('确认领用'));
    expect(await screen.findByText('请选择使用人')).toBeTruthy();
    expect(transition).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/使用人/), { target: { value: '7' } });
    fireEvent.click(screen.getByText('确认领用'));
    await waitFor(() => expect(transition).toHaveBeenCalledWith(5, expect.objectContaining({ action: 'checkout', userId: 7 })));
    await waitFor(() => expect(done).toHaveBeenCalled());
  });

  it('送修必须填原因；报废还要勾选确认', async () => {
    render(<AssetActionBar record={asset('in_use', { userId: 7 })} onDone={() => undefined} />);
    fireEvent.click(screen.getByText('送修'));
    fireEvent.click(screen.getByText('确认送修'));
    expect(await screen.findByText('请填写维修原因')).toBeTruthy();
    cleanup();
    render(<AssetActionBar record={asset('in_use', { userId: 7 })} onDone={() => undefined} />);
    fireEvent.click(screen.getByText('报废'));
    fireEvent.change(screen.getByLabelText(/报废原因/), { target: { value: '主板损坏' } });
    fireEvent.click(screen.getByText('确认报废'));
    expect(await screen.findByText('请勾选确认')).toBeTruthy();
    expect(transition).not.toHaveBeenCalled();
  });
});
