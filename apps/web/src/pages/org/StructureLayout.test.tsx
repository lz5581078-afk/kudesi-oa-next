import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => auth }));
import { orgApi } from './orgApi';
import { StructurePage } from './StructurePage';

const tree = [{ id: 1, name: '总部', sortOrder: 10, status: 'active', children: [
  { id: 2, name: '运营部', sortOrder: 10, status: 'active', children: [] },
  { id: 3, name: '财务部', sortOrder: 20, status: 'active', children: [] },
] }] as never;

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(orgApi, 'departments').mockResolvedValue(tree);
  vi.spyOn(orgApi, 'positions').mockResolvedValue([]);
  vi.spyOn(orgApi, 'catalog').mockResolvedValue([]);
  vi.spyOn(orgApi, 'staff').mockResolvedValue([]);
  vi.spyOn(orgApi, 'departmentProfile').mockImplementation(async (id: number) => ({
    department: { id, name: id === 2 ? '运营部' : '总部', parentId: id === 2 ? 1 : null, parentName: id === 2 ? '总部' : null, status: 'active', managerId: null, managerName: id === 2 ? '老周' : null },
    headcount: 1,
    positions: id === 2 ? [{ id: 5, name: '运营专员', level: 'staff', status: 'active', userCount: 1, workspaceType: 'operations', dutyCount: 6 }] : [],
    staff: id === 2 ? [{ id: 11, name: '小王', account: 'a', status: 'active', positionName: '运营专员', managerName: '老周', groups: ['店铺资质维护组'] }] : [],
    children: [],
    dutyGroups: id === 2 ? [{ id: 90, title: '店铺资质维护组', status: 'normal', memberCount: 2 }] : [],
  }) as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const page = () => render(<MemoryRouter><StructurePage /></MemoryRouter>);

describe('组织架构：旧版“左树右卷宗”结构', () => {
  it('没有页面大标题；左侧树带搜索、管理架构、新增部门；点部门后右侧是统计卡、岗位条、成员表', async () => {
    page();
    await screen.findByText('总部');
    expect(document.querySelector('.org-page h1, .org-page .page-title')).toBeNull();
    expect(screen.getByRole('button', { name: '管理架构' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /新增部门/ }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText('展开总部'));
    fireEvent.click(await within(screen.getByRole('tree')).findByText('运营部'));
    const stats = await screen.findByLabelText('部门概况');
    for (const t of ['部门人数', '在职人员', '岗位数量', '部门主管']) expect(stats.textContent).toContain(t);
    await waitFor(() => expect(stats.textContent).toContain('老周'));
    expect(screen.getAllByText('运营专员').length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('6 条职责');
    expect(screen.getByRole('link', { name: '＋ 新增成员' }).getAttribute('href')).toContain('dept=2');
  });
  it('右侧“职责组”区列出本部门的职责组，并显示成员数', async () => {
    page();
    await screen.findByText('总部');
    fireEvent.click(screen.getByLabelText('展开总部'));
    fireEvent.click(await within(screen.getByRole('tree')).findByText('运营部'));
    const aside = (await screen.findAllByText('店铺资质维护组')).find((e) => e.closest('aside, .org-aside'));
    expect(aside).toBeTruthy();
  });
  it('“管理架构”弹窗按层级分列，可新增/编辑/下架', async () => {
    page();
    await screen.findByText('总部');
    fireEvent.click(screen.getByRole('button', { name: '管理架构' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getAllByText('运营部').length).toBeGreaterThan(0);
    expect(within(dlg).getAllByRole('button', { name: /下架|停用/ }).length).toBeGreaterThan(0);
  });
});
