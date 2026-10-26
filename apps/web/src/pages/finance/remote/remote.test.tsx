import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChecker } from '@kudesi/shared';
import { Shops } from '../StoreWithdrawalPage';
import { RemoteAssistDialog } from './RemoteAssistDialog';
import { RemoteDeviceSettings, RemoteHistory } from './RemotePanels';
import type { RemoteApi, RemoteSession, RemoteShopState } from './remoteApi';
import { createViewerConnection, keyInputFrom, mapPointer } from './viewerConnection';

let perms = { isCompanyAdmin: false, allow: ['finance.doc-withdrawal.view', 'finance.session.remote'] as string[], deny: [] as string[] };
vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: '测试员' }, loading: false, can: createChecker(perms) }),
}));
const mockShops = vi.fn();
vi.mock('./remoteApi', async (orig) => ({ ...(await orig<typeof import('./remoteApi')>()), remoteApi: { shops: (...a: unknown[]) => mockShops(...a), history: vi.fn().mockResolvedValue([]) } }));
beforeEach(() => { perms = { isCompanyAdmin: false, allow: ['finance.doc-withdrawal.view', 'finance.session.remote'], deny: [] }; mockShops.mockReset(); });
afterEach(cleanup);

describe('画面坐标与键盘映射', () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 };
  it('视频按比例居中：黑边点不到，画面内换算成 0~1', () => {
    // 1600x600 的画面放进 800x600：宽撑满，高 300，上下各 150 黑边
    expect(mapPointer(rect, 1600, 600, 500, 350)).toEqual({ x: 0.5, y: 0.5 });
    expect(mapPointer(rect, 1600, 600, 100, 199)).toBeNull(); // 上黑边（画面从 y=200 开始）
    expect(mapPointer(rect, 1600, 600, 100, 200)).toEqual({ x: 0, y: 0 });
    expect(mapPointer(rect, 0, 0, 500, 350)).toBeNull();
    expect(mapPointer(rect, 1600, 600, NaN, 350)).toBeNull();
  });
  it('键盘：字符、命名键、修饰键；输入法组合和功能键不发', () => {
    const e = (key: string, o: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing: boolean }> = {}) => keyInputFrom({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...o });
    expect(e('a')).toEqual({ t: 'key', key: 'a', mods: 0 });
    expect(e('A', { shiftKey: true })).toEqual({ t: 'key', key: 'A', mods: 0 }); // 大写字母本身已含 Shift
    expect(e('Enter', { shiftKey: true })).toEqual({ t: 'key', key: 'Enter', mods: 8 });
    expect(e('c', { ctrlKey: true })).toEqual({ t: 'key', key: 'c', mods: 2 });
    expect(e(' ')).toEqual({ t: 'key', key: 'Space', mods: 0 });
    expect(e('F5')).toBeNull();
    expect(e('Process')).toBeNull();
    expect(e('你', { isComposing: true })).toBeNull();
  });
});

// ---------- 假的 RTCPeerConnection ----------
class FakeChannel { readyState = 'connecting'; label = 'input'; sent: string[] = []; onopen: (() => void) | null = null; onclose: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null; send(t: string) { this.sent.push(t); } close() { this.readyState = 'closed'; this.onclose?.(); } open() { this.readyState = 'open'; this.onopen?.(); } reply(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); } }
class FakePC {
  static last: FakePC; ontrack: ((e: unknown) => void) | null = null; onicecandidate: ((e: { candidate: unknown }) => void) | null = null; onconnectionstatechange: (() => void) | null = null; ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;
  connectionState = 'new'; log: string[] = []; closed = false;
  constructor(public cfg: unknown) { FakePC.last = this; }
  addTransceiver(kind: string) { this.log.push(`transceiver:${kind}`); }
  async setRemoteDescription(d: { type: string; sdp: string }) { this.log.push(`remote:${d.type}`); }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription() { this.log.push('local'); }
  async addIceCandidate(c: { candidate: string }) { this.log.push(`ice:${c.candidate}`); }
  close() { this.closed = true; }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('viewerConnection', () => {
  const make = (over: Partial<Parameters<typeof createViewerConnection>[0]> = {}) => {
    const sent: Array<[string, Record<string, unknown>]> = [], states: string[] = [], msgs: Array<{ t: string }> = [];
    const conn = createViewerConnection({ iceServers: [{ urls: ['stun:x'] }], sendSignal: async (k, p) => { sent.push([k, p]); }, onStream: () => undefined, onState: (s) => states.push(s), onMessage: (m) => msgs.push(m), RTC: FakePC as never, resultTimeoutMs: 30, ...over });
    return { conn, sent, states, msgs, pc: FakePC.last };
  };
  it('先发 join；收 offer 先回 answer 再回 ice（顺序保证）；answer 之前到的 ice 先缓存', async () => {
    const { conn, sent, pc } = make();
    await flush();
    expect(sent[0][0]).toBe('join');
    expect(pc.log[0]).toBe('transceiver:video');
    await conn.handleSignals([{ id: 1, kind: 'ice', payload: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 } }, { id: 2, kind: 'ice', payload: { candidate: null } }]);
    expect(pc.log).not.toContain('ice:c1'); // 还没设置远端描述
    pc.onicecandidate!({ candidate: null }); // 本地结束标记
    await conn.handleSignals([{ id: 3, kind: 'offer', payload: { sdp: 'v=0 offer' } }]);
    pc.onicecandidate!({ candidate: { candidate: 'local1', sdpMid: '0', sdpMLineIndex: 0 } });
    await flush();
    expect(pc.log).toEqual(['transceiver:video', 'remote:offer', 'ice:c1', 'local']);
    expect(sent.map((x) => x[0])).toEqual(['join', 'ice', 'answer', 'ice']);
  });
  it('数据通道打开才算连上；操作得到助手确认后完成，失败原因原样返回；超时报错；非法操作不发出', async () => {
    const { conn, states, msgs, pc } = make();
    expect(states).toEqual(['connecting']);
    await expect(conn.sendInput({ t: 'click', x: 0.5, y: 0.5, button: 'left', count: 1 })).rejects.toThrow(/还没建立/);
    const ch = new FakeChannel();
    pc.ondatachannel!({ channel: ch });
    ch.open();
    expect(states).toContain('connected');
    const ok = conn.sendInput({ t: 'move', x: 0.1, y: 0.2 });
    const sentMsg = JSON.parse(ch.sent[0]);
    expect(sentMsg).toMatchObject({ t: 'move', x: 0.1, y: 0.2 });
    ch.reply({ t: 'result', id: sentMsg.id, ok: true });
    await expect(ok).resolves.toBeUndefined();
    const bad = conn.sendInput({ t: 'key', key: 'a', mods: 0 });
    ch.reply({ t: 'result', id: JSON.parse(ch.sent[1]).id, ok: false, error: '当前是只观看模式，不能操作' });
    await expect(bad).rejects.toThrow(/只观看/);
    await expect(conn.sendInput({ t: 'move', x: 5, y: 0 })).rejects.toThrow(/无效/);
    expect(ch.sent).toHaveLength(2);
    await expect(conn.sendInput({ t: 'text', text: 'abc' })).rejects.toThrow(/超时/);
    ch.reply({ t: 'notice', message: '页面离开平台域名' });
    expect(msgs).toEqual([{ t: 'notice', message: '页面离开平台域名' }]);
  });
  it('只收名为 input 的通道；关闭会发 bye 并释放连接，之后收到的信令不再处理', async () => {
    const { conn, sent, states, pc } = make();
    const stranger = new FakeChannel(); stranger.label = 'other';
    pc.ondatachannel!({ channel: stranger });
    expect(stranger.readyState).toBe('closed');
    conn.close();
    await flush();
    expect(sent.at(-1)![0]).toBe('bye');
    expect(pc.closed).toBe(true);
    expect(states.at(-1)).toBe('closed');
    await conn.handleSignals([{ id: 9, kind: 'offer', payload: { sdp: 'x' } }]);
    expect(pc.log).not.toContain('remote:offer');
  });
});

// ---------- 对话框 ----------
const sess = (o: Partial<RemoteSession> = {}): RemoteSession => ({ id: 5, status: 'requested', mode: 'view', reason: '看看', mine: true, storeName: '甲店', deviceName: '办公室电脑', requestedByName: '测试员', requestedAt: '2026-10-26T10:00:00Z', acceptedAt: null, expiresAt: null, endedAt: null, secondsLeft: 0, endReason: null, endReasonLabel: null, endNote: null, canExtend: false, durationSeconds: 0, ...o });
const state = (o: Partial<RemoteShopState> = {}): RemoteShopState => ({ shopId: 1, remoteEnabled: true, allowControl: true, maxMinutes: 15, deviceOnline: true, live: null, ...o });
const fakeClient = (over: Partial<Record<keyof RemoteApi, unknown>> = {}) => ({
  request: vi.fn().mockResolvedValue({ id: 5, status: 'requested', waitSeconds: 60 }),
  poll: vi.fn().mockResolvedValue({ ...sess(), signals: [] }),
  get: vi.fn().mockResolvedValue(sess({ status: 'active', iceServers: [] })),
  signal: vi.fn().mockResolvedValue({ ok: true }),
  extend: vi.fn(), end: vi.fn().mockResolvedValue({ ok: true }), ...over,
}) as unknown as RemoteApi & Record<string, ReturnType<typeof vi.fn>>;

describe('RemoteAssistDialog', () => {
  it('事由必填；这台电脑只允许观看时“可操作”选不了；申请带上模式和事由', async () => {
    const client = fakeClient();
    render(<RemoteAssistDialog shopId={1} storeName="甲店" deviceName="办公室电脑" state={state({ allowControl: false })} client={client} onClose={() => undefined} />);
    const apply = screen.getByRole('button', { name: '申请协助' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect((screen.getByLabelText(/可操作/) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/事由/), { target: { value: '拼多多提现要滑块验证' } });
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    await screen.findByText(/正在等对方同意/);
    expect(client.request).toHaveBeenCalledWith(1, { mode: 'view', reason: '拼多多提现要滑块验证' });
  });
  it('申请被服务器拒绝时显示原因，不进入等待', async () => {
    const { ApiError } = await import('../../../api/client');
    const client = fakeClient({ request: vi.fn().mockRejectedValue(new ApiError(403, '电脑「办公室电脑」没有开启远程协助')) });
    render(<RemoteAssistDialog shopId={1} storeName="甲店" deviceName="办公室电脑" state={state()} client={client} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/事由/), { target: { value: '随便看看' } });
    fireEvent.click(screen.getByRole('button', { name: '申请协助' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/没有开启远程协助/);
    expect(screen.queryByText(/正在等对方同意/)).toBeNull();
  });
  it('电脑同意后建立连接并显示倒计时；结束协助会通知服务器', async () => {
    const created: Array<{ sent: Array<[string, unknown]> }> = [];
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = class extends FakePC { constructor(c: unknown) { super(c); created.push({ sent: [] }); } };
    const client = fakeClient({
      poll: vi.fn().mockResolvedValue({ ...sess({ status: 'active', mode: 'control', secondsLeft: 600, canExtend: true }), signals: [] }),
    });
    const onClose = vi.fn();
    render(<RemoteAssistDialog shopId={1} storeName="甲店" deviceName="办公室电脑" state={state()} client={client} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/事由/), { target: { value: '要在电脑上完成验证' } });
    fireEvent.click(screen.getByLabelText(/可操作/));
    fireEvent.click(screen.getByRole('button', { name: '申请协助' }));
    expect(await screen.findByLabelText('剩余时间')).toBeTruthy();
    expect(screen.getByLabelText('剩余时间').textContent).toBe('10:00');
    expect(screen.getByRole('button', { name: '延长 10 分钟' })).toBeTruthy();
    await waitFor(() => expect(client.signal).toHaveBeenCalledWith(5, 'join', {})); // 一连上就通知助手
    expect(screen.getByLabelText('远程画面')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '结束协助' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(client.end).toHaveBeenCalledWith(5);
    delete (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });
  it('对方结束/到时限：显示结束原因和用时', async () => {
    const client = fakeClient({ poll: vi.fn().mockResolvedValue({ ...sess({ status: 'ended', endReason: 'expired', endReasonLabel: '到达时限', durationSeconds: 905 }), signals: [] }) });
    render(<RemoteAssistDialog shopId={1} storeName="甲店" deviceName="办公室电脑" state={state()} client={client} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/事由/), { target: { value: '结束测试' } });
    fireEvent.click(screen.getByRole('button', { name: '申请协助' }));
    expect((await screen.findByText(/协助已结束/)).textContent).toMatch(/到达时限.*15:05/);
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
  });
  it('刷新页面后回来：等待同意的接着等；已经开始的先结束旧的再重新申请', async () => {
    const waiting = fakeClient();
    render(<RemoteAssistDialog shopId={1} storeName="甲店" deviceName="办公室电脑" state={state({ live: { id: 5, status: 'requested', mode: 'view', mine: true, requestedByName: '我' } })} client={waiting} onClose={() => undefined} />);
    await screen.findByText(/正在等对方同意/);
    cleanup();
    const active = fakeClient();
    render(<RemoteAssistDialog shopId={1} storeName="甲店" deviceName="办公室电脑" state={state({ live: { id: 6, status: 'active', mode: 'view', mine: true, requestedByName: '我' } })} client={active} onClose={() => undefined} />);
    await waitFor(() => expect(active.end).toHaveBeenCalledWith(6));
    expect(screen.getByRole('button', { name: '申请协助' })).toBeTruthy();
  });
});

// ---------- 店铺列表按钮、设置面板 ----------
const shopRow = { id: 1, storeId: 11, storeName: '甲店', platform: 'pdd', deviceId: 3, deviceName: '办公室电脑', deviceStatus: 'online' as const, loginAccount: 'a', hasPassword: true, autoLogin: true, loginState: 'valid' as const, lastVerifiedAt: null, activeRequest: null };
const sessionClient = () => ({
  overview: vi.fn().mockResolvedValue({ canManage: false, total: 1, page: 1, pageSize: 50, pageCount: 1, shops: [shopRow] }),
  devices: vi.fn().mockResolvedValue([]),
}) as never;

describe('店铺列表里的“远程协助”按钮', () => {
  const renderShops = () => render(<MemoryRouter><Shops client={sessionClient()} /></MemoryRouter>);
  it('电脑没开启远程协助：没有按钮（默认关闭）', async () => {
    mockShops.mockResolvedValue({ canRemote: true, globalDisabled: false, shops: [state({ remoteEnabled: false })] });
    renderShops();
    await screen.findByText('甲店');
    await waitFor(() => expect(mockShops).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '远程协助' })).toBeNull();
  });
  it('没有 finance.session.remote 权限：不显示，也不去查', async () => {
    perms = { isCompanyAdmin: false, allow: ['finance.doc-withdrawal.view'], deny: [] };
    mockShops.mockResolvedValue({ canRemote: false, globalDisabled: false, shops: [state()] });
    renderShops();
    await screen.findByText('甲店');
    expect(screen.queryByRole('button', { name: '远程协助' })).toBeNull();
    expect(mockShops).not.toHaveBeenCalled();
  });
  it('开启且有权限：有按钮；别人正在协助时禁用并提示是谁；点击打开窗口', async () => {
    mockShops.mockResolvedValue({ canRemote: true, globalDisabled: false, shops: [state({ live: { id: 9, status: 'active', mode: 'view', mine: false, requestedByName: '小李' } })] });
    renderShops();
    const busy = (await screen.findByRole('button', { name: '远程协助' })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.title).toMatch(/小李 正在协助/);
    cleanup();
    mockShops.mockResolvedValue({ canRemote: true, globalDisabled: false, shops: [state()] });
    renderShops();
    const b = (await screen.findByRole('button', { name: '远程协助' })) as HTMLButtonElement;
    await waitFor(() => expect(b.disabled).toBe(false));
    fireEvent.click(b);
    expect(await screen.findByRole('dialog', { name: '远程协助' })).toBeTruthy();
  });
});

describe('设置面板与记录', () => {
  const info = { globalDisabled: false, iceConfigured: false, canManage: true, canRemote: true, limits: { minMinutes: 5, hardCapMinutes: 60 }, devices: [{ deviceId: 3, enabled: false, allowControl: false, maxMinutes: 15 }, { deviceId: 4, enabled: true, allowControl: true, maxMinutes: 30 }] };
  it('默认关闭；没有管理权限看不到开关；没配 STUN/TURN 有提示；管理员可开启/关闭/紧急停止', async () => {
    perms = { isCompanyAdmin: false, allow: ['finance.doc-withdrawal.view', 'finance.session.remote'], deny: [] };
    const client = { devices: vi.fn().mockResolvedValue({ ...info, canManage: false }), setDevice: vi.fn().mockResolvedValue({ ok: true }), stopAll: vi.fn().mockResolvedValue({ ended: 1, disabledDevices: 2 }) } as unknown as RemoteApi;
    render(<RemoteDeviceSettings client={client} deviceNames={{ 3: '办公室电脑', 4: '仓库电脑' }} />);
    expect((await screen.findAllByText('关闭')).length).toBeGreaterThan(0);
    expect(screen.getByText(/还没有配置 STUN\/TURN/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /开启/ })).toBeNull();
    cleanup();
    perms = { isCompanyAdmin: false, allow: ['finance.doc-withdrawal.view', 'finance.session.manage'], deny: [] };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    (client.devices as ReturnType<typeof vi.fn>).mockResolvedValue(info);
    render(<RemoteDeviceSettings client={client} deviceNames={{ 3: '办公室电脑', 4: '仓库电脑' }} />);
    fireEvent.click(await screen.findByRole('button', { name: '开启（只观看）' }));
    await waitFor(() => expect(client.setDevice).toHaveBeenCalledWith(3, { enabled: true, allowControl: false, maxMinutes: 15 }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(client.setDevice).toHaveBeenCalledWith(4, { enabled: false }));
    fireEvent.click(screen.getByRole('button', { name: '紧急停止所有远程协助' }));
    await screen.findByText(/已结束 1 场协助，关闭 2 台/);
  });
  it('记录表显示谁、哪家店、时长、结果；没有权限的人不显示', async () => {
    const row = { id: 1, storeName: '甲店', deviceName: '办公室电脑', requestedByName: '小王', mode: 'control' as const, reason: '滑块验证', status: 'ended', endReason: 'expired', endReasonLabel: '到达时限', endedByName: '', requestedAt: '2026-10-26T10:00:00Z', acceptedAt: '2026-10-26T10:00:20Z', endedAt: '2026-10-26T10:15:20Z', durationSeconds: 900, inputCount: 42, extendCount: 0 };
    const client = { history: vi.fn().mockResolvedValue([row]) } as unknown as RemoteApi;
    render(<RemoteHistory client={client} />);
    expect(await screen.findByText('15分0秒')).toBeTruthy();
    for (const t of ['小王', '甲店', '滑块验证', '可操作', '42', '到达时限']) expect(screen.getByText(t)).toBeTruthy();
    cleanup();
    perms = { isCompanyAdmin: false, allow: ['finance.doc-withdrawal.view'], deny: [] };
    const c2 = { history: vi.fn() } as unknown as RemoteApi;
    render(<RemoteHistory client={c2} />);
    expect(screen.queryByText('远程协助记录')).toBeNull();
    expect(c2.history).not.toHaveBeenCalled();
  });
});
void act;
