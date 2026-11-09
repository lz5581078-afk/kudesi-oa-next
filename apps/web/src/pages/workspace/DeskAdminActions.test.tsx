import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createChecker } from '@kudesi/shared';
import { DeskPage } from './DeskPage';
import { LiveDeskPage } from '../live/LiveDeskPage';
import { workspaceApi } from './workspaceApi';
import { liveApi } from '../live/liveApi';
import { dailyWorkApi } from '../live/dailyWorkApi';

let admin = true;
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({
  user: { id: 7, companyId: 1, name: '当前管理员', permissions: { isCompanyAdmin: admin } },
  can: createChecker({ isCompanyAdmin: admin, allow: ['*'], deny: [] }),
}) }));
vi.mock('./workspaceApi', () => ({ workspaceApi: { catalog: vi.fn(), desk: vi.fn() } }));
vi.mock('./RoleDesk', () => ({ RoleDesk: ({ view }: { view: { title: string; top: (tick: number) => React.ReactNode; side?: (tick: number) => React.ReactNode; links: { path: string; label: string }[] } }) => <><h1>{view.title}</h1>{view.top(0)}{view.side?.(0)}{view.links.map(l => <a href={l.path} key={l.path}>{l.label}</a>)}</> }));
vi.mock('../live/liveApi', () => ({ liveApi: { checkinContext: vi.fn(), workbench: vi.fn(), personalIncome: vi.fn(), integrationStatus: vi.fn(), start: vi.fn() } }));
vi.mock('../live/dailyWorkApi', () => ({ dailyWorkApi: { mine: vi.fn(), start: vi.fn(), list: vi.fn() } }));
const api = vi.mocked(workspaceApi), live = vi.mocked(liveApi), daily = vi.mocked(dailyWorkApi);
const position = (over: Record<string, unknown> = {}) => ({ id: 4, name: '中控', workspaceType: 'live_control', level: 'staff', departmentId: 2, departmentPath: '直播部', assigned: false, isPrimary: false, ...over });
const context = { identity: { isAnchor: false, isControl: false, isOperations: false }, active: [], schedules: [], joinable: [], rooms: [] };
const open = (url = '/workbench/desk?position=4') => render(<MemoryRouter initialEntries={[url]}><DeskPage /></MemoryRouter>);
beforeEach(() => {
  vi.resetAllMocks(); admin = true;
  api.catalog.mockResolvedValue({ canBrowse: true, defaultPositionId: null, positions: [position()] } as never);
  api.desk.mockResolvedValue({ position: position(), title: '中控工作台', cards: [], pending: [] } as never);
  daily.mine.mockResolvedValue({ rows: [], canManage: true, now: '2026-11-03 09:00:00' });
  live.checkinContext.mockResolvedValue(context as never);
  live.personalIncome.mockResolvedValue({ month: '2026-11', anchor: { visible: false }, control: { visible: false }, operator: { visible: false } } as never);
  live.integrationStatus.mockResolvedValue({ ready: true } as never);
});
afterEach(cleanup);

it('管理员未兼任中控也能看到日常工作和上播入口，不会替其他人打卡', async () => {
  open();
  const start = await screen.findByRole('button', { name: '开始日常工作' });
  await waitFor(() => expect(screen.getByRole('button', { name: '上播' }).hasAttribute('disabled')).toBe(true));
  expect(start.hasAttribute('disabled')).toBe(true);
  expect(screen.getByText(/管理员可查看本岗位操作入口/)).toBeTruthy();
  fireEvent.click(start); fireEvent.click(screen.getByRole('button', { name: '上播' }));
  expect(daily.start).not.toHaveBeenCalled(); expect(live.start).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('管理员具备主播身份但查看中控工作台时，不能以中控身份误打卡', async () => {
  live.checkinContext.mockResolvedValue({ ...context, identity: { ...context.identity, isAnchor: true } } as never);
  open(); await screen.findByRole('button', { name: '开始日常工作' });
  const button=await screen.findByRole('button', { name: '上播' });
  expect(button.hasAttribute('disabled')).toBe(true);fireEvent.click(button);expect(live.start).not.toHaveBeenCalled();
});
it('管理员未分配岗位时仍可打开可见岗位目录，切换工作台', async () => {
  open('/workbench/desk');
  await screen.findByRole('heading', { name: '中控工作台' });
  expect(api.desk).toHaveBeenCalledWith(4);
  expect(screen.getByLabelText('选择岗位工作台')).toBeTruthy();
});
it('拥有全权限的普通浏览者仍不能看到别人在岗的本人操作按钮', async () => {
  admin = false; open(); await screen.findByRole('heading', { name: '中控工作台' });
  expect(screen.queryByRole('button', { name: '开始日常工作' })).toBeNull();
  expect(screen.queryByRole('button', { name: '上播' })).toBeNull(); expect(daily.mine).not.toHaveBeenCalled();
});
it('普通员工自己的中控岗位操作保持可用', async () => {
  admin = false;
  api.catalog.mockResolvedValue({ canBrowse: false, defaultPositionId: 4, positions: [position({ assigned: true, isPrimary: true })] } as never);
  live.checkinContext.mockResolvedValue({ ...context, identity: { ...context.identity, isControl: true } } as never);
  open(); await screen.findByRole('button', { name: '开始日常工作' });
  await waitFor(() => expect(screen.getByRole('button', { name: '上播' }).hasAttribute('disabled')).toBe(false));
});
it('管理员查看职员工作台也显示主管业务入口，普通职员保持原入口', async () => {
  api.catalog.mockResolvedValue({ canBrowse: true, defaultPositionId: 4, positions: [position({ workspaceType: 'finance', name: '会计' })] } as never);
  api.desk.mockResolvedValue({ position: position({ workspaceType: 'finance', name: '会计' }), title: '会计工作台', cards: [], pending: [] } as never);
  open(); expect(await screen.findByRole('link', { name: '财务经营' })).toBeTruthy();
  cleanup(); admin = false; open(); await screen.findByRole('heading', { name: '会计工作台' });
  expect(screen.queryByRole('link', { name: '财务经营' })).toBeNull();
});
it('管理员在我的直播页也能看到开始入口，无本人身份时明确不可用', async () => {
  live.workbench.mockResolvedValue({ ...context, today: '2026-11-03', recent: [], month: '2026-11', monthCommissionCents: 0, monthWageCents: 0, monthWageMinutes: 0, commissionRows: [], wageRows: [] } as never);
  render(<MemoryRouter><LiveDeskPage /></MemoryRouter>);
  const button = await screen.findByRole('button', { name: '开始直播' });
  expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button); expect(live.start).not.toHaveBeenCalled();
});

it('本人在人事岗位可从新版工作台签发临时主播开播码', async () => {
  const hr = position({ workspaceType: 'general', name: '人事专员', departmentPath: '总部 / 人事部', assigned: true, referenceProfile: 'hr_admin' });
  api.catalog.mockResolvedValue({ canBrowse: true, defaultPositionId: 4, positions: [hr] } as never);
  api.desk.mockResolvedValue({ position: hr, title: '人事专员工作台', cards: [], pending: [] } as never);
  open();
  expect(await screen.findByRole('button', { name: '临时主播开播' })).toBeTruthy();
});
