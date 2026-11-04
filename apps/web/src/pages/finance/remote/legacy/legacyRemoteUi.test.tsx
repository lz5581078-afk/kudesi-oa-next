import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dialog from './runtime/PddRemoteAssistDialog.jsx';
import { browserCloseConfirmed, pollBrowserClose } from './runtime/remote-close-recovery.mjs';

const media = vi.hoisted(() => ({ options: null as any, sendInput: vi.fn(), close: vi.fn() }));
vi.mock('./runtime/webrtc-remote-client.js', () => ({ connectViewerWebRtc: (options: any) => {
  media.options = options;
  queueMicrotask(() => { options.onStatus('connected'); options.onStream({}); });
  return { close: media.close, sendInput: media.sendInput, setQualityMode: () => ({ level: 'balanced' }), recoverMediaAndControl: async () => undefined };
} }));
const shop = { id: 101, name: '合成店铺', savedDeviceId: 'test-device', savedDeviceName: '合成授权电脑', savedDeviceCode: 'TEST-0001', savedDeviceAgentVersion: '0.3.49' };
function transport(mode = 'connected') {
  return vi.fn(async (path: string, options?: RequestInit) => {
    if (path.includes('/browser-sessions/active')) return { browserSession: { id: 'browser', status: 'open' } };
    if (path === '/api/session-manager/remote-sessions') {
      if (mode === 'denied') throw new Error('该电脑未允许远程控制');
      if (mode === 'loading') return new Promise(() => undefined);
      return { id: 'remote', status: 'connected', browserStatus: 'open' };
    }
    if (path.endsWith('/webrtc-ticket') || path.endsWith('/heartbeat')) return {};
    if (options?.method === 'DELETE' || path.endsWith('/remote-sessions/remote')) return { id: 'remote', status: 'ended', browserStatus: 'open', closeStage: 'safe_closed' };
    throw new Error('Unexpected synthetic request');
  });
}
beforeEach(() => {
  media.options = null; media.close.mockReset(); media.sendInput.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('兼容远程窗口真实媒体和错误状态', () => {
  it('授权失败停止加载，不展示默认黑色视频框，并指出本用途设置与负责电脑', async () => {
    const { container } = render(<Dialog shop={shop} onRequestChange={vi.fn()} requestBlob={vi.fn()} onClose={vi.fn()} requestJson={transport('denied')} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('该电脑未允许远程控制');
    expect(alert.textContent).toContain('授权电脑 → 远程协助设置');
    expect(alert.textContent).toContain('合成授权电脑');
    expect(alert.textContent).toContain('TEST-0001');
    expect(container.querySelector('.sm-remote-spinner')).toBeNull();
    expect(container.querySelector('video')?.classList.contains('sm-remote-media-unready')).toBe(true);
    expect(screen.queryAllByText(/等待视频统计/)).toHaveLength(0);
  });
  it('真正等待连接仍显示加载，不能把未到帧误判为授权失败', async () => {
    const { container } = render(<Dialog shop={shop} onRequestChange={vi.fn()} requestBlob={vi.fn()} onClose={vi.fn()} requestJson={transport('loading')} />);
    await waitFor(() => expect(container.querySelector('.sm-remote-spinner')).not.toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('收到流后显示媒体，黑色视频内容不会被错误态CSS隐藏', async () => {
    const { container } = render(<Dialog shop={shop} onRequestChange={vi.fn()} requestBlob={vi.fn()} onClose={vi.fn()} requestJson={transport()} />);
    await waitFor(() => expect(container.querySelector('video')?.classList.contains('sm-remote-media-unready')).toBe(false));
    expect(container.querySelector('.sm-remote-spinner')).toBeNull();
    expect(container.querySelector('.sm-remote-stage.has-media')).not.toBeNull();
    await act(async () => { media.options.onStats({ width: 1280, height: 720 }); });
    expect(container.querySelector('video')?.classList.contains('sm-remote-media-unready')).toBe(false);
  });
  it('结束媒体但浏览器仍open不提示安全关闭，也不自动退出', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onClose = vi.fn();
    const { container } = render(<Dialog shop={shop} onRequestChange={vi.fn()} requestBlob={vi.fn()} onClose={onClose} requestJson={transport()} />);
    await waitFor(() => expect(container.querySelector('video')?.classList.contains('sm-remote-media-unready')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '结束远程操作' }));
    await screen.findByRole('button', { name: '重试关闭' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('店铺已安全关闭')).toBeNull();
    expect(screen.getByRole('button', { name: '仅退出界面' })).toBeTruthy();
  });
});

describe('浏览器关闭必须有真实确认', () => {
  it('历史ended/safe_closed标签不能替代browserStatus', async () => {
    expect(browserCloseConfirmed({ status: 'ended', closeStage: 'safe_closed', browserStatus: 'open' })).toBe(false);
    await expect(pollBrowserClose({ sessionId: 'remote', fetchJson: async () => ({ status: 'ended', closeStage: 'safe_closed', browserStatus: 'open' }), timeoutMs: 30 })).rejects.toThrow('关闭尚未确认');
  });
  it('浏览器已关闭可确认，不要求DELETE另有阶段字段', async () => {
    const result = { status: 'ended', browserStatus: 'closed' };
    await expect(pollBrowserClose({ sessionId: 'remote', fetchJson: async () => result, timeoutMs: 30 })).resolves.toEqual(result);
  });
  it('关闭请求未返回时有界超时并保留不能确认提示', async () => {
    await expect(pollBrowserClose({ sessionId: 'remote', fetchJson: async () => new Promise(() => undefined), timeoutMs: 15 })).rejects.toThrow('超时');
  });
});
