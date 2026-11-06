import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StaffDialog } from './StaffDialog';
import { StaffEditorDialog } from './StaffEditorDialog';
import { orgApi, type StaffDetail } from './orgApi';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
const person: StaffDetail = { id: 7, account: 'staff7', name: '原员工', departmentId: null, positionId: null, positionName: null, extraPositionIds: [], isCompanyAdmin: false, status: 'active', lastLoginAt: null, managerId: null, title: null, employmentType: 'regular', allow: [], deny: [] };
const page = (staff = person) => render(<StaffDialog staff={staff} all={[]} canSalary={false} departments={[]} positions={[]} onClose={() => undefined} onSaved={() => undefined} />);
beforeEach(() => { vi.spyOn(orgApi, 'updateStaff').mockResolvedValue(person); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('已有员工改兼职填写合作期，空结束日期明确提交为null，不发送薪资字段', async () => {
  page();
  fireEvent.change(screen.getByLabelText('用工类型'), { target: { value: 'part_time' } });
  fireEvent.change(screen.getByLabelText('合作开始日期'), { target: { value: '2026-01-01' } });
  expect(screen.getByText(/无需另行建档/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(orgApi.updateStaff).toHaveBeenCalledWith(7, expect.objectContaining({ employmentType: 'part_time', contractStartDate: '2026-01-01', contractEndDate: null })));
  expect(vi.mocked(orgApi.updateStaff).mock.calls[0][1]).not.toHaveProperty('hourlyRate');
});

it('临时工结束早于开始，显示错误且不保存', async () => {
  page();
  fireEvent.change(screen.getByLabelText('用工类型'), { target: { value: 'temp' } });
  fireEvent.change(screen.getByLabelText('合作开始日期'), { target: { value: '2026-02-02' } });
  fireEvent.change(screen.getByLabelText('合作结束日期'), { target: { value: '2026-02-01' } });
  fireEvent.submit(screen.getByRole('dialog'));
  expect(await screen.findByText('合作结束日期不能早于开始日期')).toBeTruthy();
  expect(orgApi.updateStaff).not.toHaveBeenCalled();
});

it('编辑加载原合作期，转正式不发送旧兼职日期并说明历史保留', async () => {
  page({ ...person, employmentType: 'temp', contractStartDate: '2026-01-01', contractEndDate: '2026-12-31' });
  expect((screen.getByLabelText('合作开始日期') as HTMLInputElement).value).toBe('2026-01-01');
  expect((screen.getByLabelText('合作结束日期') as HTMLInputElement).value).toBe('2026-12-31');
  fireEvent.change(screen.getByLabelText('用工类型'), { target: { value: 'regular' } });
  expect(screen.getByText(/原用工档案保留在历史归档中/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(orgApi.updateStaff).toHaveBeenCalled());
  expect(vi.mocked(orgApi.updateStaff).mock.calls[0][1]).not.toHaveProperty('contractStartDate');
  expect(vi.mocked(orgApi.updateStaff).mock.calls[0][1]).not.toHaveProperty('contractEndDate');
});

it('各入口共用完整员工详情，回填已有合作期后再允许保存', async () => {
  vi.spyOn(orgApi, 'staffOne').mockResolvedValue({ ...person, employmentType: 'temp', contractStartDate: '2025-01-01', contractEndDate: '2099-01-01' });
  vi.spyOn(orgApi, 'staff').mockResolvedValue([person]);
  vi.spyOn(orgApi, 'departments').mockResolvedValue([]);
  vi.spyOn(orgApi, 'positions').mockResolvedValue([]);
  render(<StaffEditorDialog id={7} onClose={() => undefined} onSaved={() => undefined} />);
  expect(await screen.findByLabelText('合作结束日期')).toBeTruthy();
  expect((screen.getByLabelText('合作开始日期') as HTMLInputElement).value).toBe('2025-01-01');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(orgApi.updateStaff).toHaveBeenCalledWith(7, expect.objectContaining({ contractStartDate: '2025-01-01', contractEndDate: '2099-01-01' })));
});

it('建立试播账号时在同一份人员编辑提交合作期、岗位、登录设置和档案内容', async () => {
  const trial: StaffDetail = { ...person, account: '', name: '试播小白', employmentType: 'part_time', trial: true };
  render(<StaffDialog staff={trial} all={[]} departments={[]} canSalary
    positions={[{ id: 12, name: '主播', departmentId: null, workspaceType: 'live_anchor', permissions: [], userCount: 0,
      level: 'staff', supervisorPositionId: null, description: null, status: 'active' }]}
    workforce={{ record: null, canAccount: true, canPassword: true }} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('登录账号'), { target: { value: 'trial-profile' } });
  fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'New-password-800' } });
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'New-password-800' } });
  fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13900000001' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(orgApi.updateStaff).toHaveBeenCalledWith(trial.id, expect.objectContaining({
    account: 'trial-profile', password: 'New-password-800', positionId: 12, employmentType: 'part_time',
    workforceData: { phone: '13900000001' },
  })));
});
