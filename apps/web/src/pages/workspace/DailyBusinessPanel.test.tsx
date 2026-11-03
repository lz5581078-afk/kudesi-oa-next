import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi } from './workspaceApi';
import { DailyBusinessPanel } from './DailyBusinessPanel';
vi.mock('./workspaceApi', () => ({ workspaceApi: { daily: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe('运营工作台浏览器日期兼容回归', () => {
  it('地区日期返回斜线时仍正常加载昨日、跨月前后切换，不抛 Invalid time value', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T01:00:00Z'));
    vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('11/1/2026');
    vi.mocked(workspaceApi.daily).mockImplementation(async date => ({ date: date!, stores: [], missing: [], totals: { salesCents: 0, adCostCents: 0, profitCents: 0, marginPpm: null } }));
    render(<MemoryRouter><DailyBusinessPanel /></MemoryRouter>);
    await waitFor(() => expect(workspaceApi.daily).toHaveBeenLastCalledWith('2026-10-31'));
    const date = screen.getByLabelText('经营日期') as HTMLInputElement;
    expect(date.value).toBe('2026-10-31');
    expect(date.max).toBe('2026-11-01');
    fireEvent.click(screen.getByRole('button', { name: '前一天' }));
    await waitFor(() => expect(workspaceApi.daily).toHaveBeenLastCalledWith('2026-10-30'));
    fireEvent.click(screen.getByRole('button', { name: '后一天' }));
    fireEvent.click(screen.getByRole('button', { name: '后一天' }));
    await waitFor(() => expect(workspaceApi.daily).toHaveBeenLastCalledWith('2026-11-01'));
    expect((screen.getByRole('button', { name: '后一天' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('每日经营')).toBeTruthy();
  });
});
