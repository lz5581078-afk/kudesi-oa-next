import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DailyWorkPanel, DailyOfficeCard } from './DailyWorkPanel';
import { dailyWorkApi, type DailyWorkRow } from './dailyWorkApi';
import { ApiError } from '../../api/client';
import { liveRoomTarget } from '../../auth/liveRoomIntent';
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { companyId: 8 }, can: () => true }),
}));
const row: DailyWorkRow = {
  id: 5,
  userId: 7,
  name: '主播甲',
  role: 'anchor',
  date: '2026-11-03',
  content: '整理样品',
  status: 'scheduled',
  statusLabel: '待开始',
  plannedStart: '2026-11-03 09:00:00',
  plannedEnd: '2026-11-03 10:00:00',
  startAt: null,
  endAt: null,
  report: null,
  returnReason: null,
  flowRunId: null,
  minutes: null,
  actualMinutes: null,
  reviewNote: null,
  hourlyRateCents: 5000,
  amountCents: null,
  canStart: false,
  overdue: false,
};
beforeEach(() => {
  vi.spyOn(dailyWorkApi, 'mine').mockResolvedValue({
    now: '2026-11-03 08:00:00',
    canManage: false,
    rows: [],
  });
  vi.spyOn(dailyWorkApi, 'list').mockResolvedValue({
    now: '2026-11-03 08:00:00',
    canManage: true,
    rows: [],
  });
  vi.spyOn(dailyWorkApi, 'start').mockResolvedValue({ ok: true });
  vi.spyOn(dailyWorkApi, 'finish').mockResolvedValue({ ok: true });
  vi.spyOn(dailyWorkApi, 'submit').mockResolvedValue({ runId: 1 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('办公室管理集中展示统计、日期和排班入口，空状态可直接创建排班',async()=>{
  vi.spyOn(dailyWorkApi,'options').mockResolvedValue([]);
  render(<DailyOfficeCard date="2026-11-03"/>);
  fireEvent.click(screen.getByRole('button',{name:'查看 / 排班日常工作'}));
  const dialog=screen.getByRole('dialog',{name:'直播办公室'});
  await within(dialog).findByText('当天暂无日常工作排班');
  expect(within(dialog).getAllByRole('heading',{level:2})).toHaveLength(1);
  expect((within(dialog).getByLabelText('日常工作日期') as HTMLInputElement).value).toBe('2026-11-03');
  fireEvent.change(within(dialog).getByLabelText('日常工作日期'),{target:{value:'2026-11-04'}});
  await waitFor(()=>expect(dailyWorkApi.list).toHaveBeenCalledWith('2026-11-04'));
  await within(dialog).findByText('当天暂无日常工作排班');
  fireEvent.click(within(dialog).getByRole('button',{name:'创建第一条排班'}));
  expect(screen.getByRole('dialog',{name:'新增日常工作排班'})).toBeTruthy();
});
it('无排班或不在排班时间内，开始按钮禁用', async () => {
  const v = render(<DailyWorkPanel personal date="2026-11-03" />);
  await screen.findByText('当天暂无日常工作排班');
  expect(
    (screen.getByRole('button', { name: '开始日常工作' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  vi.mocked(dailyWorkApi.mine).mockResolvedValue({
    now: '2026-11-03 08:00:00',
    canManage: false,
    rows: [row],
  });
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByText('整理样品');
  expect(
    (screen.getByRole('button', { name: '开始日常工作' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  v.unmount();
});
it('排班时间内开始要确认工作与时薪，提交只传记录编号不接受自填时间', async () => {
  vi.mocked(dailyWorkApi.mine).mockResolvedValue({
    now: '2026-11-03 09:00:00',
    canManage: false,
    rows: [{ ...row, canStart: true }],
  });
  render(<DailyWorkPanel personal date="2026-11-03" />);
  await screen.findByText('整理样品');
  fireEvent.click(screen.getByRole('button', { name: '开始日常工作' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/当前档案时薪/)).toBeTruthy();
  expect(dailyWorkApi.start).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '确认' }));
  await waitFor(() => expect(dailyWorkApi.start).toHaveBeenCalledWith(5));
});
it('工作中按钮变为结束；失败保留完成内容，成功按实际打卡结束', async () => {
  vi.mocked(dailyWorkApi.mine).mockResolvedValue({
    now: '2026-11-03 09:30:00',
    canManage: false,
    rows: [
      {
        ...row,
        status: 'working',
        statusLabel: '工作中',
        startAt: '2026-11-03 09:00:00',
      },
    ],
  });
  vi.mocked(dailyWorkApi.finish).mockRejectedValueOnce(
    new ApiError(409, '状态已变化'),
  );
  render(<DailyWorkPanel personal date="2026-11-03" />);
  await screen.findByText('整理样品');
  fireEvent.click(screen.getByRole('button', { name: '结束日常工作' }));
  fireEvent.change(screen.getByRole('textbox', { name: '完成的工作内容' }), {
    target: { value: '样品已归类' },
  });
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: '确认' }),
  );
  expect((await screen.findByRole('alert')).textContent).toContain(
    '状态已变化',
  );
  expect(
    (
      screen.getByRole('textbox', {
        name: '完成的工作内容',
      }) as HTMLTextAreaElement
    ).value,
  ).toBe('样品已归类');
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: '确认' }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(dailyWorkApi.finish).toHaveBeenLastCalledWith(5, '样品已归类');
});
it('办公室卡片显示多人工作和超时，卡片不显示销售提成', async () => {
  vi.mocked(dailyWorkApi.list).mockResolvedValue({
    now: '2026-11-03 11:01:00',
    canManage: true,
    rows: [
      {
        ...row,
        status: 'working',
        startAt: '2026-11-03 09:00:00',
        overdue: true,
      },
      {
        ...row,
        id: 6,
        name: '中控乙',
        role: 'control',
        status: 'working',
        startAt: '2026-11-03 09:30:00',
      },
    ],
  });
  render(<DailyOfficeCard date="2026-11-03" />);
  await screen.findByText('工作中 2人');
  expect(screen.getByText('主播甲')).toBeTruthy();
  expect(screen.getByText('中控乙')).toBeTruthy();
  expect(screen.getByText(/已超时1小时/)).toBeTruthy();
  expect(screen.queryByText(/营业额|提成/)).toBeNull();
});
it('扫码日常工作保留入口标识并向服务端验证企业和二维码', async () => {
  const token = 'a'.repeat(43);
  expect(
    liveRoomTarget(`/features/live-desk?daily=1&company=8&token=${token}`),
  ).toBe(`/features/live-desk?company=8&token=${token}&daily=1`);
  render(
    <DailyWorkPanel personal date="2026-11-03" token={token} company="8" />,
  );
  await screen.findByText('当天暂无日常工作排班');
  expect(dailyWorkApi.mine).toHaveBeenCalledWith('2026-11-03', token, '8');
});
