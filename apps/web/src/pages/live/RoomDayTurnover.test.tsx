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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

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

it('真实零元显示为零，页面定时读取服务器快照，没有网页触发的刷新按钮', async () => {
  vi.useFakeTimers();
  vi.mocked(liveApi.turnover).mockResolvedValueOnce(amount(0)).mockResolvedValueOnce(amount(500));
  await act(async () => { render(<RoomDayDialog {...props} />); });
  expect(screen.getAllByText('¥0.00')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: '刷新营业额' })).toBeNull();
  expect(screen.queryByText(/更新于/)).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getAllByText('¥5.00')).toHaveLength(2);
  expect(liveApi.turnover).toHaveBeenCalledTimes(2);
});

it('不可用与网络失败不冒充零元，自动重读服务器结果', async () => {
  vi.useFakeTimers();
  vi.mocked(liveApi.turnover).mockResolvedValueOnce(amount(null, false)).mockRejectedValueOnce(new Error('网络超时'));
  await act(async () => { render(<RoomDayDialog {...props} />); });
  expect(screen.getAllByText('暂无')).toHaveLength(2);
  expect(screen.getAllByTitle('店铺尚未关联聚水潭')).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getAllByText('读取失败')).toHaveLength(2);
  expect(screen.getAllByTitle('网络超时')).toHaveLength(2);
  expect(screen.queryByText('¥0.00')).toBeNull();
});

it('已锁定场次停止轮询；金额位于状态标签前且不显示更新时间',async()=>{
  vi.useFakeTimers();
  vi.mocked(liveApi.turnover).mockResolvedValue({...amount(12345),locked:true});
  await act(async()=>{render(<RoomDayDialog {...props}/>);});
  const amounts=screen.getAllByText('¥123.45');
  const group=amounts[0].closest('.live-day-row-actions')!;
  expect(group.textContent).toBe('营业额 ¥123.45已播');
  expect(screen.queryByText(/更新于/)).toBeNull();
  await act(async()=>{await vi.advanceTimersByTimeAsync(120_000);});
  expect(liveApi.turnover).toHaveBeenCalledTimes(1);
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
  expect(screen.queryByRole('button', { name: '刷新营业额' })).toBeNull();
});

it('历史场次只在打开详情时读已存快照一次，仅在播场次继续自动查询', async () => {
  vi.useFakeTimers();
  const ended = { ...day().sessions[0], id: 8, status: 'approved', endAt: `${props.date} 11:00:00` };
  vi.mocked(liveApi.roomDay).mockResolvedValue({ ...day(), sessions: [...day().sessions, ended] });
  await act(async () => { render(<RoomDayDialog {...props} />); });
  expect(liveApi.turnover).toHaveBeenCalledWith(7);
  expect(liveApi.turnover).toHaveBeenCalledWith(8);
  vi.mocked(liveApi.turnover).mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(vi.mocked(liveApi.turnover).mock.calls.every(([id]) => id === 7)).toBe(true);
  expect(liveApi.turnover).toHaveBeenCalledTimes(4);
});

it('当天没有在播场次时，手动详情读完已存数据后不再自动查询', async () => {
  vi.useFakeTimers();
  vi.mocked(liveApi.roomDay).mockResolvedValue({ ...day(), sessions: [{ ...day().sessions[0], status: 'approved', endAt: `${props.date} 11:00:00` }] });
  await act(async () => { render(<RoomDayDialog {...props} />); });
  expect(liveApi.turnover).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(liveApi.turnover).toHaveBeenCalledTimes(1);
});
