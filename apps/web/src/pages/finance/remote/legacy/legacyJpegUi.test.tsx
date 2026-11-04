import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubEnv('VITE_SESSION_MANAGER_WEBRTC_REMOTE', 'false'); });
import Dialog from './runtime/PddRemoteAssistDialog.jsx';
afterEach(cleanup);
afterAll(() => vi.unstubAllEnvs());
const shop = { id: 101, name: '合成JPEG店铺', savedDeviceId: 'device', savedDeviceName: '合成电脑', savedDeviceAgentVersion: '0.3.49' };
it('纯JPEG授权失败也停止转圈并展示本用途授权位置', async () => {
  const api = vi.fn(async (path: string) => {
    if (path.includes('/browser-sessions/active')) return { browserSession: { id: 'browser', status: 'open' } };
    throw new Error('该电脑未允许远程控制');
  });
  const { container } = render(<Dialog shop={shop} requestJson={api} requestBlob={vi.fn()} onRequestChange={vi.fn()} onClose={vi.fn()} />);
  expect((await screen.findByRole('alert')).textContent).toContain('授权电脑 → 远程协助设置');
  expect(container.querySelector('.sm-remote-spinner')).toBeNull();
  expect(container.querySelector('.sm-remote-stage.empty')).not.toBeNull();
});
it('纯JPEG的历史ended/open/safe_closed不能提示浏览器已安全关闭', async () => {
  const api = vi.fn(async (path: string) => {
    if (path.includes('/browser-sessions/active')) return { browserSession: { id: 'browser', status: 'open' } };
    if (path === '/api/session-manager/remote-sessions') return { id: 'remote', status: 'requested' };
    return { id: 'remote', status: 'ended', browserStatus: 'open', closeStage: 'safe_closed' };
  });
  const { container } = render(<Dialog shop={shop} requestJson={api} requestBlob={vi.fn()} onRequestChange={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/session-manager/remote-sessions/remote'));
  expect(screen.queryByText(/店铺已安全关闭/)).toBeNull();
  expect(container.querySelector('.sm-remote-spinner')).toBeNull();
});

it('纯JPEG首帧前确认关闭属于成功终态，不继续转圈', async () => {
  const api = vi.fn(async (path: string) => {
    if (path.includes('/browser-sessions/active')) return { browserSession: { id: 'browser', status: 'open' } };
    if (path === '/api/session-manager/remote-sessions') return { id: 'remote', status: 'requested' };
    return { id: 'remote', status: 'ended', browserStatus: 'closed', closeStage: 'safe_closed' };
  });
  const { container } = render(<Dialog shop={shop} requestJson={api} requestBlob={vi.fn()} onRequestChange={vi.fn()} onClose={vi.fn()} />);
  await screen.findByRole('button', { name: '完成' });
  expect(container.querySelector('.sm-remote-spinner')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});
