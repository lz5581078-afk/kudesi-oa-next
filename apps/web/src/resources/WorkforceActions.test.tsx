import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkforceActions } from './WorkforceActions';
import { resourceApi, type ResourceDto } from './api';
import { orgApi } from '../pages/org/orgApi';
import { ApiError } from '../api/client';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const record: ResourceDto = { statusReason: null, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '', id: 12, type: 'workforce', title: '兼职甲', status: 'active', archived: null, data: { userId: 7, employmentType: 'part_time', contractStartDate: '2026-01-01' } };
beforeEach(() => {
  auth.user.permissions = { isCompanyAdmin: true, allow: [], deny: [] };
  vi.spyOn(resourceApi, 'changeStatus').mockResolvedValue(record);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('列表编辑直接使用原档案，按钮点击不触发整行查看', () => {
  const onEdit = vi.fn(), onOpen = vi.fn();
  render(<div onClick={onOpen}><WorkforceActions record={record} onEdit={onEdit} onLogs={() => undefined} onChanged={() => undefined} /></div>);
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));
  expect(onEdit).toHaveBeenCalledWith(record); expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '记录' })).toBeTruthy(); expect(screen.getByRole('button', { name: '停用' })).toBeTruthy();
});

it('停用先填写原因，确认后仅调用统一资料状态接口并刷新', async () => {
  const changed = vi.fn();
  render(<WorkforceActions record={record} onLogs={() => undefined} onChanged={changed} />);
  fireEvent.click(screen.getByRole('button', { name: '停用' }));
  const dialog = screen.getByRole('dialog', { name: '停用：兼职甲' });
  expect(dialog.closest('.workforce-modal')?.parentElement).toBe(document.body);
  expect(within(dialog).getByText(/员工账号也会停用/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: '确认停用' }));
  expect(resourceApi.changeStatus).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '合作结束' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '确认停用' }));
  await waitFor(() => expect(resourceApi.changeStatus).toHaveBeenCalledWith('workforce', 12, 'inactive', '合作结束'));
  expect(changed).toHaveBeenCalledOnce();
});

it('停用失败保留原因和错误，不能报告成功', async () => {
  vi.mocked(resourceApi.changeStatus).mockRejectedValue(new ApiError(409, '找不到交接人，请先指定'));
  const changed = vi.fn();
  render(<WorkforceActions record={record} onLogs={() => undefined} onChanged={changed} />);
  fireEvent.click(screen.getByRole('button', { name: '停用' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '合作结束' } });
  fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
  expect((await screen.findByRole('alert')).textContent).toContain('找不到交接人，请先指定');
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('合作结束');
  expect(changed).not.toHaveBeenCalled();
});

it('已停用档案提供启用，历史归档只提供记录与员工资料', async () => {
  const changed = vi.fn();
  const view = render(<WorkforceActions record={{ ...record, status: 'inactive' }} onLogs={() => undefined} onChanged={changed} />);
  fireEvent.click(screen.getByRole('button', { name: '启用' }));
  await waitFor(() => expect(resourceApi.changeStatus).toHaveBeenCalledWith('workforce', 12, 'active', undefined));
  view.rerender(<WorkforceActions record={{ ...record, archived: { at: '', by: 1, reason: '转正式', fromStatus: 'active' } }} onEdit={() => undefined} employeeAction onLogs={() => undefined} onChanged={changed} />);
  expect(screen.queryByRole('button', { name: /^(编辑|停用|启用)$/ })).toBeNull();
  expect(screen.getByRole('button', { name: '员工资料' })).toBeTruthy();
});

it('人员记录读取员工ID，展示人事记录；无薪资权限不展示薪资页签', async () => {
  auth.user.permissions = { isCompanyAdmin: false, allow: ['resource.workforce.view', 'org.staff.view'], deny: [] };
  vi.spyOn(orgApi, 'staffOne').mockResolvedValue({ id: 7, name: '兼职甲', status: 'active' } as never);
  vi.spyOn(orgApi, 'staffRecords').mockResolvedValue({ hrLogs: [{ id: 1, action: 'user.create', createdAt: '', actorName: '人事' }] } as never);
  render(<WorkforceActions record={record} onEdit={() => undefined} employeeAction onLogs={() => undefined} onChanged={() => undefined} />);
  expect(screen.queryByRole('button', { name: /^(编辑|停用|员工资料)$/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '记录' }));
  expect(await screen.findByText('创建账号')).toBeTruthy();
  expect(orgApi.staffOne).toHaveBeenCalledWith(7); expect(orgApi.staffRecords).toHaveBeenCalledWith(7);
  expect(screen.queryByRole('tab', { name: '薪资变更' })).toBeNull();
});

it('仅用工查看权限可查档案操作记录，不能读取员工记录或修改状态', () => {
  auth.user.permissions = { isCompanyAdmin: false, allow: ['resource.workforce.view'], deny: [] };
  const logs = vi.fn();
  render(<WorkforceActions record={record} onEdit={() => undefined} employeeAction onLogs={logs} onChanged={() => undefined} />);
  expect(screen.queryByRole('button', { name: /^(编辑|记录|停用|员工资料)$/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '操作记录' }));
  expect(logs).toHaveBeenCalledOnce();
});

it('待补资料的临时行按真实员工ID停用，不向档案接口发送负数编号', async () => {
  const status = vi.spyOn(orgApi, 'setStatus').mockResolvedValue({} as never);
  render(<WorkforceActions record={{ ...record, id: -7, data: { ...record.data, profileIncomplete: true } }} onEdit={() => undefined} onLogs={() => undefined} onChanged={() => undefined} />);
  expect(screen.getByRole('button', { name: '补资料' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '停用' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '试播结束' } });
  fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
  await waitFor(() => expect(status).toHaveBeenCalledWith(7, 'disabled', '试播结束'));
  expect(resourceApi.changeStatus).not.toHaveBeenCalled();
});
