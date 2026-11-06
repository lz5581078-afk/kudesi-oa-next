import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChecker, type DeskCatalog } from '@kudesi/shared';
import { Shell } from './Shell';
import { workspaceApi } from '../pages/workspace/workspaceApi';
import { HomePage } from '../pages/workspace/HomePage';

vi.mock('../pages/workspace/workspaceApi', () => ({ workspaceApi: { catalog: vi.fn() } }));
vi.mock('./NotificationBell', () => ({ NotificationBell: () => null }));
let user = { id: 1, companyId: 1, name: '员工', account: 'employee', companyName: '测试公司', positionName: '会计' };
const can = createChecker({ isCompanyAdmin: false, allow: ['workbench.*', 'after-sales.workspace.view'], deny: [] });
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user, can, logout: vi.fn() }) }));
const catalog: DeskCatalog = { canBrowse: true, defaultPositionId: 11, positions: [
  { id: 11, name: '会计', departmentId: 1, departmentPath: '总部 / 财务部', workspaceType: 'finance', level: 'staff', assigned: true, isPrimary: true },
  { id: 12, name: '运营', departmentId: 2, departmentPath: '运营部', workspaceType: 'operations', level: 'staff', assigned: false, isPrimary: false },
] };
const mount = (path = '/workbench/desk?position=11') => render(<MemoryRouter initialEntries={[path]}><Routes><Route element={<Shell />}><Route path="*" element={<Outlet />} /><Route path="/workbench/home" element={<HomePage />} /></Route></Routes></MemoryRouter>);
beforeEach(() => { vi.mocked(workspaceApi.catalog).mockResolvedValue(catalog); window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('外壳岗位直达菜单', () => {
  it('部门分组可直接进入岗位；查询参数切换会更新标题、高亮并关闭菜单', async () => {
    mount();
    await waitFor(() => expect(screen.getByLabelText('当前位置').textContent).toContain('会计工作台'));
    fireEvent.click(within(screen.getByLabelText('一级导航')).getByRole('button', { name: '工作台' }));
    const panel = screen.getByRole('dialog', { name: '工作台菜单' });
    expect(within(panel).queryByText('岗位工作台')).toBeNull();
    expect(within(panel).getByRole('region', { name: '总部 / 财务部' })).toBeTruthy();
    expect(within(panel).getByRole('link', { name: /会计工作台/ }).getAttribute('aria-current')).toBe('page');
    const operations = within(panel).getByRole('link', { name: '运营工作台' });
    expect(operations.getAttribute('aria-current')).toBeNull();
    fireEvent.click(operations);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('当前位置').textContent).toContain('运营工作台');
    fireEvent.click(within(screen.getByLabelText('一级导航')).getByRole('button', { name: '工作台' }));
    const reopened = screen.getByRole('dialog');
    expect(within(reopened).getByRole('link', { name: '运营工作台' }).getAttribute('aria-current')).toBe('page');
    expect(within(reopened).getByRole('link', { name: /会计工作台/ }).getAttribute('aria-current')).toBeNull();
  });
  it('功能首页使用同一岗位目录，可以按部门搜索', async () => {
    mount('/workbench/home');
    await screen.findByText('会计工作台');
    fireEvent.change(screen.getByLabelText('搜索功能'), { target: { value: '财务部 会计' } });
    expect(screen.getByRole('link', { name: /会计工作台/ }).getAttribute('href')).toBe('/workbench/desk?position=11');
    expect(screen.queryByText('运营工作台')).toBeNull();
  });
  it.each(['offline', 'malformed'])('目录异常（%s）时保留原入口，不影响其他页面', async (kind) => {
    if (kind === 'offline') vi.mocked(workspaceApi.catalog).mockRejectedValue(new Error('offline'));
    else vi.mocked(workspaceApi.catalog).mockResolvedValue({} as DeskCatalog);
    mount('/workbench/personal');
    fireEvent.click(within(screen.getByLabelText('一级导航')).getByRole('button', { name: '工作台' }));
    expect(await screen.findByRole('link', { name: '岗位工作台' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '我的待办' })).toBeTruthy();
  });
});

it('实时售后从功能菜单打开独立窗口并保留 OA 当前页面', async () => {
  const openAfterSales = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('oaDesktop', { surface: 'main', openAfterSales });
  try {
    mount();
    await waitFor(() => expect(screen.getByLabelText('当前位置').textContent).toContain('会计工作台'));
    fireEvent.click(within(screen.getByLabelText('一级导航')).getByRole('button', { name: '功能' }));
    const link = within(screen.getByRole('region', { name: '售后处理' })).getByRole('link', { name: '实时售后处理' });
    expect(link.getAttribute('href')).toBe('kudesi-oa://after-sales');
    const download = screen.getByRole('link', { name: '下载 Windows 售后工具' });
    expect(download.getAttribute('href')).toContain('/releases/download/oa-desktop-v0.2.2/KudesiOA-Setup-0.2.2-x64.exe');
    fireEvent.click(link);
    expect(openAfterSales).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('当前位置').textContent).toContain('会计工作台');
  } finally {
    vi.unstubAllGlobals();
  }
});
