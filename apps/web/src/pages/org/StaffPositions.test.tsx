import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => auth }));
import { orgApi } from './orgApi';
import { StaffPage } from './StaffPage';
import { PositionProfilesPage } from './PositionProfilesPage';

const tree = [{ id: 1, name: '总部', sortOrder: 1, status: 'active', children: [{ id: 2, name: '运营部', sortOrder: 1, status: 'active', children: [] }] }, { id: 3, name: '财务部', sortOrder: 2, status: 'active', children: [] }] as never;
const person = (id: number, name: string, departmentId: number, positionId: number) => ({ id, account: `acc${id}`, name, departmentId, positionId, positionName: '岗', status: 'active', isCompanyAdmin: false, lastLoginAt: null, managerId: null, title: null, extraPositionIds: [] });
const positions = [
  { id: 5, name: '运营', departmentId: 2, workspaceType: 'operations', permissions: [], userCount: 1, level: 'staff', supervisorPositionId: 6, description: null, status: 'active' },
  { id: 6, name: '运营主管', departmentId: 2, workspaceType: 'operations', permissions: [], userCount: 0, level: 'manager', supervisorPositionId: null, description: null, status: 'active' },
] as never;

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
  vi.spyOn(orgApi, 'departments').mockResolvedValue(tree);
  vi.spyOn(orgApi, 'positions').mockResolvedValue(positions);
  vi.spyOn(orgApi, 'catalog').mockResolvedValue([]);
  vi.spyOn(orgApi, 'staff').mockResolvedValue([person(11, '小王', 2, 5), person(12, '小李', 3, 7)] as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('员工与权限', () => {
  it('按部门筛选包含下级部门；登录账号可以复制', async () => {
    render(<StaffPage />);
    await screen.findByText('小王');
    fireEvent.change(screen.getByLabelText('部门'), { target: { value: '1' } });
    expect(screen.queryByText('小李')).toBeNull();
    expect(screen.getByText('小王')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('复制小王的登录账号'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('acc11'));
    expect(screen.getByText(/共 1 人/)).toBeTruthy();
  });
});

describe('岗位档案', () => {
  it('列表有上级岗位列，“无人在岗”一键筛出没有人的岗位', async () => {
    render(<PositionProfilesPage />);
    await screen.findAllByText('运营主管');
    const table = screen.getByRole('table');
    expect(within(table).getByText('上级岗位')).toBeTruthy();
    expect(within(table).getAllByText('运营主管').length).toBe(2); // 自己一行 + 运营岗位行的上级岗位格
    fireEvent.click(screen.getByRole('button', { name: /无人在岗 1/ }));
    await waitFor(() => expect(within(screen.getByRole('table')).queryByText('运营')).toBeNull());
  });
});
