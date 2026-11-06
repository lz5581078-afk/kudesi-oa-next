import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DailyWorkLedgerPanel } from './DailyWorkLedgerPanel';
import { dailyWorkApi, type DailyWorkRow } from './dailyWorkApi';
vi.mock('../flow/RunDetail', () => ({ RunDetail: ({ id, onChanged }: { id: number; onChanged: () => void }) => <button onClick={onChanged}>审核流程 {id}</button> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('待审日常工时打开原流程，审核后刷新列表', async () => {
  const load = vi.spyOn(dailyWorkApi, 'ledger').mockResolvedValue({ page: 1, total: 1, month: '2026-11', summary: null, rows: [{ id: 1, flowRunId: 12, name: '中控甲', role: 'control', date: '2026-11-06', minutes: 30, amountCents: 1000 } as DailyWorkRow] });
  render(<DailyWorkLedgerPanel mode="review"/>);
  fireEvent.click(await screen.findByRole('button', { name: '查看审核' }));
  fireEvent.click(screen.getByRole('button', { name: '审核流程 12' }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});
it('工资展示核定金额，切换月份重新查询', async () => {
  const load = vi.spyOn(dailyWorkApi, 'ledger').mockResolvedValue({ page: 1, total: 1, month: '2026-11', summary: { amountCents: 10867, minutes: 326 }, rows: [] });
  render(<DailyWorkLedgerPanel mode="wages"/>);
  expect((await screen.findByText(/108.67/)).textContent).toContain('326 分钟');
  fireEvent.change(screen.getByLabelText('工资月份'), { target: { value: '2026-10' } });
  await waitFor(() => expect(load).toHaveBeenLastCalledWith('wages', '2026-10', 1));
});
