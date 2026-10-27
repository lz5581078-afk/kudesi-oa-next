import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { LoginPage } from './LoginPage';
import { ChangePasswordPage } from './ChangePasswordPage';
import { NoAccessPage, NotFoundPage } from './StatusPages';
import { NotificationBell } from '../layout/NotificationBell';
import { flowApi } from './flow/flowApi';
import { ApplicationsPage } from './platform/ApplicationsPage';
import { CompaniesPage } from './platform/CompaniesPage';

const login = vi.fn();
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ login, refresh: vi.fn() }) }));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: vi.fn() }));
vi.mock('./flow/flowApi', async (orig) => ({ ...(await orig<typeof import('./flow/flowApi')>()), flowApi: { notifications: vi.fn(), markRead: vi.fn() } }));
const apiMock = vi.mocked(api);
const wrap = (ui: JSX.Element) => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('登录页', () => {
  it('登录成功后记住账号（不记密码），下次打开直接带出，焦点落到密码框', async () => {
    login.mockResolvedValue(undefined);
    const first = wrap(<LoginPage />);
    fireEvent.change(screen.getByLabelText('登录账号'), { target: { value: ' boss ' } });
    fireEvent.change(screen.getByPlaceholderText('请输入密码'), { target: { value: 'secret-pass' } });
    fireEvent.click(screen.getByLabelText(/记住账号/));
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith({ account: 'boss', password: 'secret-pass' }));
    expect(window.localStorage.getItem('kudesi.login.account')).toBe('boss');
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('secret-pass');
    first.unmount();
    wrap(<LoginPage />);
    expect((screen.getByLabelText('登录账号') as HTMLInputElement).value).toBe('boss');
    expect(document.activeElement).toBe(screen.getByPlaceholderText('请输入密码'));
  });
  it('不勾选记住账号则清掉；密码错误显示服务端提示', async () => {
    window.localStorage.setItem('kudesi.login.account', 'old');
    login.mockRejectedValueOnce(new Error('账号或密码不对'));
    wrap(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('请输入密码'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('账号或密码不对')).toBeTruthy();
    login.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByLabelText(/记住账号/));
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(window.localStorage.getItem('kudesi.login.account')).toBeNull());
  });
});

describe('修改密码', () => {
  it('两次不一致即时提示；新旧相同不能提交', async () => {
    wrap(<ChangePasswordPage />);
    const [oldP, newP, again] = screen.getAllByDisplayValue('') as HTMLInputElement[];
    fireEvent.change(newP, { target: { value: 'abcdefghij1' } });
    fireEvent.change(again, { target: { value: 'abcdefghij2' } });
    expect(screen.getByText('两次输入的新密码不一致')).toBeTruthy();
    fireEvent.change(oldP, { target: { value: 'abcdefghij1' } });
    fireEvent.change(again, { target: { value: 'abcdefghij1' } });
    fireEvent.click(screen.getByText('保存新密码'));
    expect(await screen.findByText('新密码不能和当前密码相同')).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe('状态页', () => {
  it('找不到页面时显示地址并给出返回上一页', () => {
    render(<MemoryRouter initialEntries={['/finance/nope']}><NotFoundPage /></MemoryRouter>);
    expect(screen.getByText('/finance/nope')).toBeTruthy();
    expect(screen.getByText('返回上一页')).toBeTruthy();
  });
  it('没有权限页提示怎么办', () => {
    wrap(<NoAccessPage />);
    expect(screen.getByText(/联系公司管理员/)).toBeTruthy();
  });
});

describe('通知面板', () => {
  const data = { unread: 1, items: [{ id: 1, kind: 'todo', title: '新待办：差旅费', body: null, link: '/workbench/todos?run=5', createdAt: '2026-01-01T00:00:00Z', read: false }, { id: 2, kind: 'done', title: '已办结', body: null, link: null, createdAt: '2026-01-01T00:00:00Z', read: true }] };
  beforeEach(() => { vi.mocked(flowApi.notifications).mockResolvedValue(data); vi.mocked(flowApi.markRead).mockResolvedValue({ ok: true }); });
  it('能只看未读；Esc 关闭；没有未读时“全部已读”不可点', async () => {
    wrap(<NotificationBell />);
    fireEvent.click(await screen.findByRole('button', { name: '通知' }));
    const panel = await screen.findByRole('dialog', { name: '通知列表' });
    expect(within(panel).getByText('已办结')).toBeTruthy();
    fireEvent.click(within(panel).getByText('未读'));
    expect(within(panel).queryByText('已办结')).toBeNull();
    expect(within(panel).getByText('新待办：差旅费')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '通知列表' })).toBeNull();
  });
  it('点空白处关闭', async () => {
    wrap(<div><span data-testid="out">外面</span><NotificationBell /></div>);
    fireEvent.click(await screen.findByRole('button', { name: '通知' }));
    await screen.findByRole('dialog', { name: '通知列表' });
    fireEvent.mouseDown(screen.getByTestId('out'));
    expect(screen.queryByRole('dialog', { name: '通知列表' })).toBeNull();
  });
});

describe('平台后台', () => {
  const app = (id: number, status: string, name: string) => ({ id, companyName: name, contactName: '张', contactTitle: null, contactPhone: '13900000001', remark: null, createdAt: '2026-01-01T00:00:00Z', status, approvedCompanyName: null, reviewedAt: null, rejectReason: null, reviewedByName: null });
  it('申请页有统计，点“待审核”只看待审核；开通前要确认', async () => {
    apiMock.mockResolvedValue([app(1, 'pending', '新公司'), app(2, 'approved', '老公司'), app(3, 'rejected', '被拒公司')] as never);
    render(<ApplicationsPage />);
    await screen.findByText('新公司');
    fireEvent.click(screen.getByRole('button', { name: /待审核申请/ }));
    expect(screen.queryByText('老公司')).toBeNull();
    expect(screen.getByText('新公司')).toBeTruthy();
    apiMock.mockClear();
    fireEvent.click(screen.getByText('通过并开通'));
    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: '确认开通' })).toBeTruthy();
  });
  it('企业页有统计和搜索', async () => {
    apiMock.mockResolvedValue([{ id: 1, name: '甲公司', status: 'active', userCount: 3, adminAccounts: ['139'], createdAt: '2026-01-01T00:00:00Z' }, { id: 2, name: '乙公司', status: 'suspended', userCount: 1, adminAccounts: [], createdAt: '2026-01-01T00:00:00Z' }] as never);
    render(<CompaniesPage />);
    await screen.findByText('甲公司');
    expect(within(screen.getByLabelText('企业统计')).getByText('已停用').parentElement!.textContent).toContain('1');
    fireEvent.change(screen.getByLabelText('搜索公司'), { target: { value: '乙' } });
    expect(screen.queryByText('甲公司')).toBeNull();
  });
});
