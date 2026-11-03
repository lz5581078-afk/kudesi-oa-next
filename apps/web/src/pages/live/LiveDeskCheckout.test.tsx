import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveDeskPage } from './LiveDeskPage';
import { liveApi, type Workbench } from './liveApi';

vi.mock('./LiveCheckinPanel', () => ({ LiveCheckinPanel: ({ onChanged }: { onChanged?: () => void }) => <button onClick={onChanged}>模拟下播成功</button> }));
vi.mock('./liveApi', () => ({ liveApi: { workbench: vi.fn() } }));
vi.mock('./liveUi', async original => ({ ...await original<typeof import('./liveUi')>(), SourceStatusNotice: () => null }));
const api = vi.mocked(liveApi);
const person = { id: 3, name: '主播' }, control = { id: 4, name: '中控' }, account = { id: 20, name: '直播号' };
const session = {
  id: 7, scheduleId: 1, roomId: 10, roomName: '南7', date: '2026-11-03', startAt: '2026-11-03 09:56:00', endAt: null,
  plannedEnd: null, status: 'live', statusLabel: '直播中', anchor: person, control, operator: null, douyinAccount: account, store: null,
  finalSalesCents: null, finalSalesSource: null, finalSalesReason: null, returnReason: null, flowRunId: null, submittedAt: null,
  approvedAt: null, approverName: null, revision: 1, checkinMode: true,
  myCheckin: { role: 'control', startAt: '2026-11-03 09:56:00', endAt: null },
};
const schedule = { id: 1, roomId: 10, roomName: '南7', date: '2026-11-03', start: '2026-11-03 10:00:00', end: '2026-11-03 12:00:00',
  startTime: '10:00', endTime: '12:00', status: 'live', statusLabel: '直播中', anchor: person, control, operator: null,
  douyinAccount: account, store: null, sessionId: 7, note: null, cancelReason: null, canStart: false, mineRole: 'control' };
const bench = (ended = false, globalLive = false) => ({
  today: '2026-11-03', month: '2026-11', identity: { isAnchor: false, isControl: true, isOperations: true, canManage: false },
  active: [{ ...session, status: ended && !globalLive ? 'pending_report' : 'live', statusLabel: ended && !globalLive ? '待提交审核' : '直播中',
    myCheckin: { ...session.myCheckin, endAt: ended ? '2026-11-03 12:18:20' : null } }],
  schedules: [schedule, { ...schedule, id: 2, sessionId: null, startTime: '12:30', endTime: '14:30', status: 'scheduled', statusLabel: '未开始' }],
  recent: [], monthCommissionCents: 0, monthWageCents: 0, monthWageMinutes: 0, commissionRows: [], wageRows: [],
}) as Workbench;
const mount = () => render(<MemoryRouter><LiveDeskPage /></MemoryRouter>);
beforeEach(() => { vi.resetAllMocks(); api.workbench.mockResolvedValue(bench()); });
afterEach(cleanup);

describe('下播后工作台即时同步', () => {
  it('下播成功即刷新父工作台，用本人下播时间并保留将来排班的未开始状态', async () => {
    mount(); await screen.findByText('本人直播中');
    api.workbench.mockResolvedValue(bench(true)); fireEvent.click(screen.getByRole('button', { name: '模拟下播成功' }));
    const active = within(await screen.findByRole('region', { name: '进行中的场次' }));
    await active.findByText('本人已下播');
    expect(active.getByText(/09:56–12:18/)).toBeTruthy();
    expect(active.getByText('整场：待提交审核')).toBeTruthy();
    expect(active.getByRole('button', { name: '下播记录 / 详情' })).toBeTruthy();
    expect(active.queryByRole('button', { name: /报下播/ })).toBeNull();
    const week = within(screen.getByRole('region', { name: '本周排场' }));
    expect(week.getAllByText('本人已下播')).toHaveLength(1); expect(week.getByText('未开始')).toBeTruthy();
  });
  it('确有其他人员仍在直播时，自己的已下播与整场状态分别显示', async () => {
    api.workbench.mockResolvedValue(bench(true, true)); mount();
    const active = within(await screen.findByRole('region', { name: '进行中的场次' }));
    await active.findByText('本人已下播'); expect(active.getByText('整场：直播中')).toBeTruthy();
    expect(active.queryByText('本人直播中')).toBeNull();
  });
  it('本人未上播时不显示下播操作，也不把整场直播中标作本人直播中', async () => {
    const value = bench(); value.active[0].myCheckin = null; api.workbench.mockResolvedValue(value); mount();
    await screen.findByText('本人未上播');
    const active = within(await screen.findByRole('region', { name: '进行中的场次' }));
    expect(active.getByRole('button', { name: '查看详情' })).toBeTruthy();
    expect(active.queryByRole('button', { name: /报下播/ })).toBeNull();
  });
  it('扫码下播后回到页面会刷新，旧请求不能覆盖新的下播结果', async () => {
    let resolveOld!: (value: Workbench) => void;
    api.workbench.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    mount(); api.workbench.mockResolvedValue(bench(true)); fireEvent.focus(window);
    const active = within(await screen.findByRole('region', { name: '进行中的场次' }));
    await active.findByText('本人已下播');
    await act(async () => { resolveOld(bench()); });
    expect(active.getByText('本人已下播')).toBeTruthy(); expect(active.queryByText('本人直播中')).toBeNull();
  });
});
