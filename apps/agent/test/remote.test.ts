import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cases from '../../../packages/shared/src/remote-input.cases.json';
import { AgentApiError } from '../src/api';
import { consentText, windowsConsentPrompt } from '../src/remote-consent';
import { keyCombo, parseRemoteInput, type RemoteInput } from '../src/remote-input';
import { RemoteRunner, type RemoteDeps } from '../src/remote';
import type { ExchangeResult, RemoteApi, RemoteOffer } from '../src/remote-api';
import type { RtcPeer } from '../src/remote-rtc';
import { loadRemotePolicy, saveRemotePolicy } from '../src/remote-settings';
import type { Frame, RemoteTarget } from '../src/remote-target';

describe('远程输入校验（和 shared 用同一组用例）', () => {
  it.each(cases.valid.map((c, i) => [i, c] as const))('合法 %i', (_i, c) => { expect(parseRemoteInput(c)).not.toBeNull(); });
  it.each(cases.invalid.map((c, i) => [i, c] as const))('非法 %i 被拒绝', (_i, c) => { expect(parseRemoteInput(c)).toBeNull(); });
  it('组合键写法', () => {
    expect(keyCombo('a', 0)).toBe('a');
    expect(keyCombo('a', 2)).toBe('Control+a');
    expect(keyCombo('Enter', 8 | 1)).toBe('Alt+Shift+Enter');
    expect(keyCombo('Space', 0)).toBe(' ');
  });
});

describe('本机同意：设置与弹窗', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kudesi-remote-')); process.env.KUDESI_AGENT_DATA_DIR = dir; delete process.env.KUDESI_AGENT_REMOTE; });
  afterEach(async () => { delete process.env.KUDESI_AGENT_DATA_DIR; delete process.env.KUDESI_AGENT_REMOTE; await fs.rm(dir, { recursive: true, force: true }); });
  it('默认关闭；保存后读得到；环境变量优先；乱写的值当关闭', async () => {
    expect(await loadRemotePolicy()).toBe('off');
    await saveRemotePolicy('prompt');
    expect(await loadRemotePolicy()).toBe('prompt');
    process.env.KUDESI_AGENT_REMOTE = 'auto';
    expect(await loadRemotePolicy()).toBe('auto');
    delete process.env.KUDESI_AGENT_REMOTE;
    await fs.writeFile(path.join(dir, 'remote.json'), JSON.stringify({ policy: 'root' }));
    expect(await loadRemotePolicy()).toBe('off');
    await expect(saveRemotePolicy('yes' as never)).rejects.toThrow();
  });
  const info = { requestedByName: '小王', storeName: '测试店', mode: 'control' as const, reason: '滑块验证', minutes: 15 };
  it('弹窗文字写清楚谁、哪家店、能做什么、多久', () => {
    const t = consentText(info);
    for (const w of ['小王', '测试店', '查看并操作', '滑块验证', '15 分钟', '不同意']) expect(t).toContain(w);
    expect(consentText({ ...info, mode: 'view' })).toContain('申请远程协助：查看这台');
  });
  const fakeSpawn = (output: string, ms = 0) => vi.fn((_cmd: string, _args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void; env?: NodeJS.ProcessEnv };
    child.stdout = new EventEmitter(); child.kill = () => undefined; child.env = opts.env;
    setTimeout(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', 0); }, ms);
    return child;
  });
  it('只有点“是”（返回 6）才算同意；超时/否/出错/非 Windows 都是不同意；文字不拼进命令', async () => {
    const yes = fakeSpawn('6\r\n');
    expect(await windowsConsentPrompt(yes as never, 'win32')(info)).toBe(true);
    const args = yes.mock.calls[0][1].join(' ');
    expect(args).not.toContain('测试店'); // 文字走环境变量
    expect(yes.mock.calls[0][2].env?.KUDESI_CONSENT_TEXT).toContain('测试店');
    expect(await windowsConsentPrompt(fakeSpawn('7') as never, 'win32')(info)).toBe(false);
    expect(await windowsConsentPrompt(fakeSpawn('-1') as never, 'win32')(info)).toBe(false);
    expect(await windowsConsentPrompt(fakeSpawn('') as never, 'win32')(info)).toBe(false);
    expect(await windowsConsentPrompt(fakeSpawn('6') as never, 'linux')(info)).toBe(false);
    const boom = vi.fn(() => { throw new Error('no powershell'); });
    expect(await windowsConsentPrompt(boom as never, 'win32')(info)).toBe(false);
  });
});

// ---------------- RemoteRunner（全部用假的接口，不开浏览器）----------------

class FakeTarget implements RemoteTarget {
  injected: RemoteInput[] = []; started = false; stopped = false; emit: ((f: Frame) => void) | null = null; closed: (() => void) | null = null; notice: ((m: string) => void) | null = null; failInject = false;
  async start(onFrame: (f: Frame) => void, onNotice: (m: string) => void) { this.started = true; this.emit = onFrame; this.notice = onNotice; }
  onClosed(cb: () => void) { this.closed = cb; }
  async inject(i: RemoteInput) { if (this.failInject) throw new Error('当前页面不在平台域名下，不能操作'); this.injected.push(i); }
  async stop() { this.stopped = true; }
}
class FakePeer implements RtcPeer {
  calls: string[] = []; sent: Array<Record<string, unknown>> = []; frames: string[] = []; closed = false; startOpts!: Parameters<RtcPeer['start']>[0];
  async start(o: Parameters<RtcPeer['start']>[0]) { this.startOpts = o; this.calls.push('start'); }
  async makeOffer() { this.calls.push('offer'); this.startOpts.onSignal('offer', { sdp: 'v=0 fake offer' }); }
  async setAnswer(sdp: string) { this.calls.push(`answer:${sdp}`); }
  async addIce(c: { candidate: string | null }) { this.calls.push(`ice:${c.candidate}`); }
  pushFrame(b: string) { this.frames.push(b); }
  send(m: Record<string, unknown>) { this.sent.push(m); }
  async close() { this.closed = true; }
}
const offer = (o: Partial<RemoteOffer> = {}): RemoteOffer => ({ id: 7, mode: 'control', reason: '滑块验证', requestedByName: '小王', store: { id: 3, name: '测试店', platform: 'pdd' }, maxMinutes: 15, waitSeconds: 60, ...o });

function setup(over: { offer?: RemoteOffer; policy?: 'off' | 'prompt' | 'auto'; consent?: boolean; noWindow?: boolean; script?: Array<Partial<ExchangeResult> | Error>; mode?: 'view' | 'control'; expiresInMs?: number } = {}) {
  const target = new FakeTarget(), peer = new FakePeer();
  const logs: string[] = [];
  const script = [...(over.script ?? [])];
  const calls = { accept: 0, decline: [] as Array<[number, string | undefined]>, end: [] as Array<Record<string, unknown>>, exchanges: [] as Array<Record<string, unknown>>, consent: 0 };
  const api: RemoteApi = {
    claim: async () => ({ enabled: true, session: over.offer ?? offer() }),
    accept: async (id) => { calls.accept++; return { id, mode: over.mode ?? over.offer?.mode ?? 'control', expiresAt: new Date(Date.now() + (over.expiresInMs ?? 60_000)).toISOString(), iceServers: [{ urls: ['stun:s'] }] }; },
    decline: async (id, note) => { calls.decline.push([id, note]); return { ok: true }; },
    exchange: async (_id, body) => {
      calls.exchanges.push(body);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return { status: 'active', endReason: null, mode: 'control', expiresAt: null, signals: [], rejected: 0, ...(next ?? {}) } as ExchangeResult;
    },
    end: async (_id, body) => { calls.end.push(body as Record<string, unknown>); return { ok: true }; },
  };
  const deps: RemoteDeps = {
    api, policy: async () => over.policy ?? 'prompt', consent: async () => { calls.consent++; return over.consent ?? true; },
    openTarget: () => (over.noWindow ? null : target), createPeer: () => peer, log: (m) => { logs.push(String(m)); }, exchangeMs: 5, claimMs: 0, offlineLimitMs: 60,
  };
  return { runner: new RemoteRunner(deps), target, peer, calls, logs };
}
const run = async (s: ReturnType<typeof setup>) => { await s.runner.tick(); await s.runner.idle(); };

describe('RemoteRunner：是否同意', () => {
  it('本机设置为 off：直接拒绝，不弹窗、不同意、不开任何东西', async () => {
    const s = setup({ policy: 'off' });
    await run(s);
    expect(s.calls.decline).toEqual([[7, '电脑主人没有允许远程协助']]);
    expect(s.calls.accept).toBe(0); expect(s.calls.consent).toBe(0); expect(s.target.started).toBe(false);
  });
  it('店铺窗口没开：拒绝并说明原因', async () => {
    const s = setup({ noWindow: true });
    await run(s);
    expect(s.calls.decline[0][1]).toMatch(/店铺窗口没有打开/);
    expect(s.calls.accept).toBe(0); expect(s.calls.consent).toBe(0);
  });
  it('prompt 模式主人没点同意：拒绝，不同意', async () => {
    const s = setup({ consent: false });
    await run(s);
    expect(s.calls.consent).toBe(1);
    expect(s.calls.decline[0][1]).toBe('电脑主人没有同意');
    expect(s.calls.accept).toBe(0); expect(s.target.started).toBe(false); expect(s.peer.calls).toEqual([]);
  });
  it('auto 模式不弹窗直接同意；prompt 同意后才开始', async () => {
    const a = setup({ policy: 'auto', script: [{ status: 'ended', endReason: 'completed' }] });
    await run(a);
    expect(a.calls.consent).toBe(0); expect(a.calls.accept).toBe(1); expect(a.target.started).toBe(true);
    const p = setup({ script: [{ status: 'ended', endReason: 'expired' }] });
    await run(p);
    expect(p.calls.consent).toBe(1); expect(p.calls.accept).toBe(1);
  });
  it('OA 那边同意失败（已超时等）：什么也不开', async () => {
    const s = setup();
    s.runner['deps'].api.accept = async () => { throw new AgentApiError('这场远程协助已经开始或已结束', 409); };
    await run(s);
    expect(s.target.started).toBe(false); expect(s.calls.end).toEqual([]);
  });
});

describe('RemoteRunner：协助过程', () => {
  it('信令：join → 发 offer；answer / ice 交给连接；offer 通过下一次交换发回 OA；画面送进连接；结束后释放', async () => {
    const s = setup({
      script: [
        { signals: [{ id: 1, kind: 'join', payload: {} }] },
        { signals: [{ id: 2, kind: 'answer', payload: { sdp: 'v=0 ans' } }, { id: 3, kind: 'ice', payload: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } }] },
        { status: 'ended', endReason: 'completed' },
      ],
    });
    await s.runner.tick();
    await vi.waitFor(() => expect(s.target.started).toBe(true));
    s.target.emit!({ jpegBase64: 'AAAA', width: 10, height: 10 });
    await s.runner.idle();
    expect(s.peer.calls).toEqual(['start', 'offer', 'answer:v=0 ans', 'ice:candidate:1']);
    expect(s.peer.frames).toEqual(['AAAA']);
    const sent = s.calls.exchanges.flatMap((e) => (e.send as Array<{ kind: string }> | undefined) ?? []);
    expect(sent.map((m) => m.kind)).toEqual(['offer']);
    expect(s.calls.exchanges.map((e) => e.after)).toEqual([0, 1, 3]); // 游标推进，不重复领取
    expect(s.target.stopped).toBe(true); expect(s.peer.closed).toBe(true);
    expect(s.calls.end).toEqual([]); // 是 OA 先结束的，不用再通知
  });

  it('可操作模式：校验后执行并回结果；无效/越界/未知操作被拒绝；只观看模式一律不执行', async () => {
    const s = setup({ mode: 'control', script: Array.from({ length: 400 }, () => ({})) });
    await s.runner.tick();
    await vi.waitFor(() => expect(s.peer.calls).toContain('start'));
    const send = (m: unknown) => s.peer.startOpts.onInput(typeof m === 'string' ? m : JSON.stringify(m));
    send({ t: 'click', id: 'a', x: 0.5, y: 0.5 });
    send({ t: 'key', id: 'b', key: 'Enter' });
    send({ t: 'click', id: 'c', x: 5, y: 0.5 });
    send({ t: 'navigate', id: 'd', url: 'https://evil.example' });
    send('not json');
    await vi.waitFor(() => expect(s.peer.sent.filter((m) => m.t === 'result')).toHaveLength(4));
    await s.runner.stop();
    expect(s.target.injected.map((i) => i.t)).toEqual(['click', 'key']);
    expect(s.peer.sent.filter((m) => m.t === 'result').map((m) => [m.id, m.ok])).toEqual([['a', true], ['b', true], ['c', false], ['d', false]]);
    expect(s.calls.exchanges.reduce((n, e) => n + Number(e.inputs ?? 0), 0) + Number((s.calls.end[0]?.inputs as number) ?? 0)).toBe(2);
  });

  it('只观看：所有操作被拒绝，页面一次也没被碰', async () => {
    const s = setup({ offer: offer({ mode: 'view' }), mode: 'view', script: [{}, {}, { status: 'ended' }] });
    await s.runner.tick();
    await vi.waitFor(() => expect(s.peer.calls).toContain('start'));
    s.peer.startOpts.onInput(JSON.stringify({ t: 'click', id: 'a', x: 0.5, y: 0.5 }));
    s.peer.startOpts.onInput(JSON.stringify({ t: 'text', id: 'b', text: 'abc' }));
    await s.runner.idle();
    expect(s.target.injected).toEqual([]);
    expect(s.peer.sent.filter((m) => m.t === 'result').every((m) => m.ok === false && /只观看/.test(String(m.error)))).toBe(true);
  });

  it('注入失败（页面离开平台域名）：告诉网页失败原因，会话继续', async () => {
    const s = setup({ script: [{}, {}, { status: 'ended' }] });
    s.target.failInject = true;
    await s.runner.tick();
    await vi.waitFor(() => expect(s.peer.calls).toContain('start'));
    s.peer.startOpts.onInput(JSON.stringify({ t: 'click', id: 'a', x: 0.5, y: 0.5 }));
    await s.runner.idle();
    expect(s.peer.sent.find((m) => m.t === 'result')).toMatchObject({ ok: false, error: expect.stringMatching(/平台域名/) });
  });

  it('到点自动结束并通知 OA；申请人关闭(bye)、店铺窗口关闭、连接失败 都会结束', async () => {
    const t = setup({ expiresInMs: 30 });
    await run(t);
    expect(t.calls.end[0]).toMatchObject({ reason: 'completed', note: '到达时限' });
    expect(t.target.stopped && t.peer.closed).toBe(true);
    const b = setup({ script: [{ signals: [{ id: 1, kind: 'bye', payload: {} }] }] });
    await run(b);
    expect(b.calls.end[0]).toMatchObject({ reason: 'completed', note: expect.stringMatching(/关闭了协助窗口/) });
    const w = setup({ script: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}] });
    await w.runner.tick();
    await vi.waitFor(() => expect(w.target.closed).not.toBeNull());
    w.target.closed!();
    await w.runner.idle();
    expect(w.calls.end[0]).toMatchObject({ note: '店铺窗口已关闭' });
    const f = setup({ script: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}] });
    await f.runner.tick();
    await vi.waitFor(() => expect(f.peer.calls).toContain('start'));
    f.peer.startOpts.onState('failed');
    await f.runner.idle();
    expect(f.calls.end[0]).toMatchObject({ reason: 'error', note: expect.stringMatching(/TURN/) });
  });

  it('联系不上 OA 超过上限就自己结束；授权被撤销立即停止且不再回报', async () => {
    const off = setup({ script: Array.from({ length: 200 }, () => new Error('fetch failed')) });
    await run(off);
    expect(off.target.stopped).toBe(true);
    expect(off.calls.end[0]).toMatchObject({ reason: 'error', note: '联系不上 OA' });
    const rev = setup({ script: [new AgentApiError('设备未授权或已撤销', 401)] });
    await run(rev);
    expect(rev.target.stopped && rev.peer.closed).toBe(true);
    expect(rev.calls.end).toEqual([]);
  });

  it('stop() 立即结束进行中的协助并释放资源', async () => {
    const s = setup({ script: Array.from({ length: 500 }, () => ({})) });
    await s.runner.tick();
    await vi.waitFor(() => expect(s.peer.calls).toContain('start'));
    await s.runner.stop();
    expect(s.target.stopped && s.peer.closed).toBe(true);
    expect(s.calls.end[0]).toMatchObject({ note: '助手停止' });
    await s.runner.tick(); // 停止之后不再领取
    expect(s.calls.accept).toBe(1);
  });

  it('同一时间只服务一场；上一场没结束不再领取', async () => {
    const s = setup({ script: Array.from({ length: 500 }, () => ({})) });
    const claim = vi.spyOn(s.runner['deps'].api, 'claim');
    await s.runner.tick();
    await s.runner.tick(); await s.runner.tick();
    expect(claim).toHaveBeenCalledTimes(1);
    await s.runner.stop();
  });
});
