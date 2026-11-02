import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FeishuEnrollmentSetup } from './FeishuEnrollmentSetup';
import { FeishuBindCallback } from './FeishuLogin';
import { feishuApi } from './feishuApi';
const { refresh, logout } = vi.hoisted(() => ({ refresh: vi.fn(), logout: vi.fn() }));
vi.mock('./AuthContext', () => ({ useAuth: () => ({ user: { id: 1, companyId: 2, companyName: '测试公司', feishuBindingPending: true }, refresh, logout }) }));
const inRouter = (ui: React.ReactElement) => <MemoryRouter initialEntries={['/feishu-setup']}><Routes><Route path="/feishu-setup" element={ui} /><Route path="/" element={<h1>本人岗位首页</h1>} /></Routes></MemoryRouter>;
const unbound = { configured: true, bound: false, allNotificationsEnabled: false, notificationsEnabled: true };
beforeEach(() => {
  refresh.mockReset().mockResolvedValue(undefined); logout.mockReset();
  vi.spyOn(feishuApi, 'status').mockResolvedValue(unbound);
  vi.spyOn(feishuApi, 'start').mockResolvedValue({ authorizationUrl: 'https://accounts.feishu.cn/authorize-test' });
  vi.spyOn(feishuApi, 'redirect').mockImplementation(() => {});
  vi.spyOn(feishuApi, 'complete').mockResolvedValue({ bound: true, allNotificationsEnabled: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('岗位新员工自动进入本人飞书授权，StrictMode下只发起一次绑定', async () => {
  render(<StrictMode>{inRouter(<FeishuEnrollmentSetup />)}</StrictMode>);
  await waitFor(() => expect(feishuApi.redirect).toHaveBeenCalledWith('https://accounts.feishu.cn/authorize-test'));
  expect(feishuApi.start).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/现在不绑定也可以继续使用/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '稍后再绑' })).toBeTruthy();
});
it('配置缺失时不影响使用，可以重试或稍后再绑', async () => {
  vi.mocked(feishuApi.status).mockRejectedValueOnce(new Error('公司尚未启用飞书授权'));
  render(inRouter(<FeishuEnrollmentSetup />));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('不影响使用 OA'));
  expect(feishuApi.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '继续绑定飞书' }));
  await waitFor(() => expect(feishuApi.redirect).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: '稍后再绑' })); expect(await screen.findByRole('heading', { name: '本人岗位首页' })).toBeTruthy(); expect(logout).not.toHaveBeenCalled();
});
it('离开引导后，迟到的请求不会把用户跳回飞书', async () => {
  let finish!: (v: { authorizationUrl: string }) => void;
  vi.mocked(feishuApi.start).mockImplementation(() => new Promise(r => { finish = r; }));
  const view = render(inRouter(<FeishuEnrollmentSetup />));
  await waitFor(() => expect(feishuApi.start).toHaveBeenCalled()); view.unmount();
  finish({ authorizationUrl: 'https://accounts.feishu.cn/authorize-test' });
  await Promise.resolve(); expect(feishuApi.redirect).not.toHaveBeenCalled();
});
const callback = (query = '?code=test&state=test') => {
  window.history.replaceState(null, '', '/feishu-bind' + query);
  return render(<MemoryRouter initialEntries={['/feishu-bind']}><Routes><Route path="/feishu-bind" element={<FeishuBindCallback />} /><Route path="/" element={<h1>本人岗位首页</h1>} /></Routes></MemoryRouter>);
};
it('授权成功刷新OA身份后进入首页，公司开关关闭时明确提示尚未推送', async () => {
  vi.mocked(feishuApi.status).mockResolvedValue({ ...unbound, bound: true });
  callback(); expect(await screen.findByRole('heading', { name: '本人岗位首页' })).toBeTruthy();
  expect(feishuApi.complete).toHaveBeenCalledWith('test', 'test'); expect(refresh).toHaveBeenCalledOnce(); cleanup();
  vi.mocked(feishuApi.status).mockResolvedValue({ ...unbound, bound: true, allNotificationsEnabled: true, notificationsEnabled: false });
  callback(); await waitFor(() => expect(screen.getByRole('status').textContent).toContain('公司通知开关尚未开启'));
});
it('取消或绑定冲突时不能进入OA，只能重试或退出', async () => {
  callback('?error=access_denied'); expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('已取消'));
  expect(feishuApi.complete).not.toHaveBeenCalled(); cleanup();
  vi.mocked(feishuApi.complete).mockRejectedValue(new Error('此飞书账号已绑定其他员工'));
  callback(); await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已绑定其他员工'));
  expect(refresh).not.toHaveBeenCalled(); expect(screen.queryByRole('link', { name: '进入 OA' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重新绑定飞书' }));
  await waitFor(() => expect(feishuApi.start).toHaveBeenCalled());
});
it('绑定完成后的网络故障不会误报绑定失败', async () => {
  refresh.mockRejectedValue(new Error('网络失败')); callback();
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('飞书已绑定'));
});

it('已有有效绑定不要求重新授权，即使旧绑定未打开全通知标记', async () => {
  vi.mocked(feishuApi.status).mockResolvedValue({ ...unbound, bound: true, allNotificationsEnabled: false });
  render(inRouter(<FeishuEnrollmentSetup />));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(feishuApi.start).not.toHaveBeenCalled();
});
