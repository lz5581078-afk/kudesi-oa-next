import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoomDayDialog } from './OverviewTab';
import { liveApi, type RoomDay, type SessionTurnover } from './liveApi';
vi.mock('./liveApi', () => ({ liveApi: { roomDay: vi.fn(), turnover: vi.fn() } }));
const props = { roomId: 10, date: '2026-11-03', onClose: vi.fn(), onOpenSession: vi.fn() };
const person = { id: 3, name: '主播甲' };
const day = (id = 7) => ({ room: { id: 10, name: '直播间-南7' }, date: props.date,
  schedules: [
    { id: 1, startTime: '10:00', endTime: '12:00', anchor: person, douyinAccount: { id: 1, name: '直播号' }, sessionId: id, status: 'finished', statusLabel: '已播' },
    { id: 2, startTime: '16:00', endTime: '19:00', anchor: person, douyinAccount: { id: 1, name: '直播号' }, sessionId: null, status: 'scheduled', statusLabel: '未开始' },
  ],
  sessions: [{ id, scheduleId: 1, status: 'live', startAt: `${props.date} 10:00:00`, endAt: null, anchor: person, control: null, douyinAccount: { id: 1, name: '直播号' }, anchorSalesCents: 1000, controlSalesCents: null, finalSalesCents: null }],
}) as RoomDay;
const amount = (cents: number | null, available = true) => ({ available, reason: available ? '' : '店铺尚未关联聚水潭', turnoverCents: cents, queriedAt: `${props.date} 13:00:00` }) as SessionTurnover;
beforeEach(() => { vi.mocked(liveApi.roomDay).mockResolvedValue(day()); vi.mocked(liveApi.turnover).mockResolvedValue(amount(12345)); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('排场与实际直播共用本场营业额，保留填报金额，未开播不请求', async () => {
  const onOpenSession = vi.fn();
  render(<RoomDayDialog {...props} onOpenSession={onOpenSession} />);
  await waitFor(() => expect(screen.getAllByText('¥123.45')).toHaveLength(2));
  expect(liveApi.turnover).toHaveBeenCalledTimes(1);
  expect(liveApi.turnover).toHaveBeenCalledWith(7);
  expect(screen.getByText('主播所报 ¥10.00')).toBeTruthy();
  expect(screen.getByText('未开播')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '详情' }));
  expect(onOpenSession).toHaveBeenCalledWith(7);
});

it('真实零元显示为零，点击刷新重新查询', async () => {
  vi.mocked(liveApi.turnover).mockResolvedValueOnce(amount(0)).mockResolvedValueOnce(amount(500));
  render(<RoomDayDialog {...props} />);
  await waitFor(() => expect(screen.getAllByText('¥0.00')).toHaveLength(2));
  fireEvent.click(screen.getByRole('button', { name: '刷新营业额' }));
  await waitFor(() => expect(screen.getAllByText('¥5.00')).toHaveLength(2));
  expect(liveApi.turnover).toHaveBeenCalledTimes(2);
});

it('不可用与网络失败保留原因，不冒充零元，并可刷新重试', async () => {
  vi.mocked(liveApi.turnover).mockResolvedValueOnce(amount(null, false)).mockRejectedValueOnce(new Error('网络超时'));
  render(<RoomDayDialog {...props} />);
  await waitFor(() => expect(screen.getAllByText('暂无')).toHaveLength(2));
  expect(screen.getAllByText(/店铺尚未关联聚水潭/)).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '刷新营业额' }));
  await waitFor(() => expect(screen.getAllByText('读取失败')).toHaveLength(2));
  expect(screen.getAllByText(/网络超时/)).toHaveLength(2);
  expect(screen.queryByText('¥0.00')).toBeNull();
});

it('切换房间后丢弃旧场次慢请求，不覆盖新场次金额', async () => {
  let resolve!: (value: SessionTurnover) => void;
  vi.mocked(liveApi.turnover).mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValue(amount(800));
  const view = render(<RoomDayDialog {...props} />);
  await waitFor(() => expect(liveApi.turnover).toHaveBeenCalledWith(7));
  vi.mocked(liveApi.roomDay).mockResolvedValue(day(8));
  view.rerender(<RoomDayDialog {...props} roomId={11} />);
  await waitFor(() => expect(screen.getAllByText('¥8.00')).toHaveLength(2));
  await act(async () => { resolve(amount(99900)); });
  expect(screen.queryByText('¥999.00')).toBeNull();
});

it('跨日场次未出现在实际直播列表时，仍查询排场关联的场次营业额', async () => {
  vi.mocked(liveApi.roomDay).mockResolvedValue({ ...day(), sessions: [] });
  render(<RoomDayDialog {...props} />);
  expect(await screen.findByText('¥123.45')).toBeTruthy();
  expect(liveApi.turnover).toHaveBeenCalledWith(7);
  expect((screen.getByRole('button', { name: '刷新营业额' }) as HTMLButtonElement).disabled).toBe(false);
});
