import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => auth }));
import { orgApi } from './orgApi';
import { StructurePage } from './StructurePage';

const tree = [
  { id: 1, name: '总部', sortOrder: 10, status: 'active', children: [
    { id: 2, name: '运营部', sortOrder: 10, status: 'active', children: [] },
    { id: 3, name: '财务部', sortOrder: 20, status: 'active', children: [] },
  ] },
] as never;
const staff = [
  { id: 11, account: 'a', name: '小王', departmentId: 2, positionId: 5, positionName: '运营', status: 'active', isCompanyAdmin: false, lastLoginAt: null, managerId: null, title: null, extraPositionIds: [] },
  { id: 12, account: 'b', name: '小李', departmentId: 3, positionId: 6, positionName: '会计', status: 'active', isCompanyAdmin: false, lastLoginAt: null, managerId: null, title: null, extraPositionIds: [] },
] as never;

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(orgApi, 'departments').mockResolvedValue(tree);
  vi.spyOn(orgApi, 'positions').mockResolvedValue([]);
  vi.spyOn(orgApi, 'catalog').mockResolvedValue([]);
  vi.spyOn(orgApi, 'staff').mockResolvedValue(staff);
  vi.spyOn(orgApi, 'departmentProfile').mockImplementation(async (id: number) => ({
    department: { id, name: id === 2 ? '运营部' : '总部', parentId: id === 2 ? 1 : null, parentName: id === 2 ? '总部' : null, status: 'active', managerId: null, managerName: id === 2 ? '老周' : null },
    headcount: id === 2 ? 1 : 0,
    positions: id === 2 ? [{ id: 5, name: '运营', level: 'staff', status: 'active', userCount: 1 }] : [],
    staff: id === 2 ? [{ id: 11, name: '小王', account: 'a', status: 'active', positionName: '运营', managerName: '老周', groups: ['售后审核组'] }] : [],
    children: id === 1 ? [{ id: 2, name: '运营部', status: 'active', headcount: 1 }] : [],
  }) as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('部门与岗位：左树右卷宗', () => {
  it('树上显示在职人数；点部门，右侧卷宗显示岗位、人员（含直属上级、职责组）和主管', async () => {
    render(<StructurePage />);
    await screen.findByText('总部');
    fireEvent.click(screen.getByLabelText('展开总部'));
    fireEvent.click(await within(screen.getByRole('tree')).findByText('运营部'));
    expect(await screen.findByLabelText('部门概况')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('部门概况').textContent).toContain('老周'));
    expect(screen.getAllByText('小王').length).toBeGreaterThan(0);
    expect(screen.getByText('售后审核组')).toBeTruthy();
    expect(screen.getByLabelText('部门卷宗').textContent).toContain('上级：总部');
  });

  it('搜人名：命中的部门保留并自动展开，并提示“含 小李”；清空后恢复', async () => {
    render(<StructurePage />);
    await screen.findByText('总部');
    fireEvent.change(screen.getByLabelText('搜索部门或人员'), { target: { value: '小李' } });
    expect(await screen.findByText(/含 小李/)).toBeTruthy();
    expect(within(screen.getByRole('tree')).queryByText('运营部')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('找到');
    fireEvent.change(screen.getByLabelText('搜索部门或人员'), { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText(/含 小李/)).toBeNull());
  });

  it('展开状态会记住；上移同级部门会按新顺序写排序', async () => {
    const upd = vi.spyOn(orgApi, 'updateDepartment').mockResolvedValue({} as never);
    render(<StructurePage />);
    await screen.findByText('总部');
    fireEvent.click(screen.getByLabelText('展开总部'));
    expect(JSON.parse(localStorage.getItem('kudesi.org.expanded') ?? '[]')).toEqual([1]);
    fireEvent.click(await within(screen.getByRole('tree')).findByText('财务部'));
    fireEvent.click(await screen.findByLabelText('上移财务部'));
    await waitFor(() => expect(upd).toHaveBeenCalled());
    expect(upd).toHaveBeenCalledWith(3, { sortOrder: 10 });
    expect(upd).toHaveBeenCalledWith(2, { sortOrder: 20 });
  });

  it('拖动部门到另一个部门“里面”，写回新的父部门和排序', async () => {
    const upd = vi.spyOn(orgApi, 'updateDepartment').mockResolvedValue({} as never);
    render(<StructurePage />);
    await screen.findByText('总部');
    fireEvent.click(screen.getByLabelText('展开总部'));
    const tree = within(screen.getByRole('tree'));
    const src = (await tree.findByText('财务部')).closest('.org-node') as HTMLElement;
    const dst = tree.getByText('运营部').closest('.org-node') as HTMLElement;
    expect(src.getAttribute('draggable')).toBe('true');
    dst.getBoundingClientRect = () => ({ top: 0, height: 40, left: 0, right: 100, bottom: 40, width: 100, x: 0, y: 0, toJSON: () => ({}) });
    const dt = { setData: () => undefined, effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(src, { dataTransfer: dt });
    fireEvent.dragOver(dst, { dataTransfer: dt, clientY: 20 });
    fireEvent.drop(dst, { dataTransfer: dt, clientY: 20 });
    await waitFor(() => expect(upd).toHaveBeenCalledWith(3, { parentId: 2, sortOrder: 10 }));
  });
});
