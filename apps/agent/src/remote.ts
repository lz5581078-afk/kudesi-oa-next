import { AgentApiError } from './api';
import { log as writeLog, type AgentConfig } from './config';
import { windowsConsentPrompt, type ConsentPrompt } from './remote-consent';
import { makeRemoteApi, type RemoteApi, type RemoteOffer, type RemoteSignalIn } from './remote-api';
import { parseRemoteInput } from './remote-input';
import { ChromeRtcPeer, type RtcPeer } from './remote-rtc';
import { loadRemotePolicy, type RemotePolicy } from './remote-settings';
import { PlaywrightRemoteTarget, type RemoteTarget } from './remote-target';
import { activeShop } from './browser';
import { getPlatform } from './platforms';

export interface RemoteDeps {
  api: RemoteApi;
  policy: () => Promise<RemotePolicy>;
  consent: ConsentPrompt;
  /** 找到这家店铺当前打开的窗口；没开就返回 null */
  openTarget: (offer: RemoteOffer) => RemoteTarget | null;
  createPeer: () => RtcPeer;
  log: (message: string) => void | Promise<void>;
  now?: () => number;
  /** 和服务器交换信令的间隔 */
  exchangeMs?: number;
  /** 领取申请的间隔 */
  claimMs?: number;
  /** 连续多久联系不上服务器就自己结束 */
  offlineLimitMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_INPUT_PER_SECOND = 120;

/**
 * 远程协助的助手一侧：轮询 OA 有没有人申请 → 按本机策略决定拒绝/弹窗/自动同意 → 同意后开始推送店铺窗口画面，
 * 经 WebRTC 点对点发给申请人，并执行他发来的操作（只观看模式一律不执行）。一次只服务一场。
 * 到点、OA 说结束、窗口关闭、联系不上 OA 都会立刻停止并释放浏览器页面。
 */
export class RemoteRunner {
  private busy: Promise<void> | null = null;
  private lastClaim = 0;
  private claiming = false;
  private stopping = false;
  private abort: (() => void) | null = null;
  constructor(private readonly deps: RemoteDeps) {}

  private say(m: string) { return Promise.resolve(this.deps.log(`[远程协助] ${m}`)).catch(() => undefined); }
  private now() { return (this.deps.now ?? Date.now)(); }

  /** 主循环每秒调一次；空闲时才去领取 */
  async tick(): Promise<void> {
    if (this.busy || this.claiming || this.stopping) return;
    if (this.now() - this.lastClaim < (this.deps.claimMs ?? 2000)) return;
    this.lastClaim = this.now();
    this.claiming = true;
    let session: RemoteOffer | null;
    try { ({ session } = await this.deps.api.claim()); } finally { this.claiming = false; }
    if (!session || this.stopping) return;
    this.busy = this.serve(session).catch((e) => this.say(`出错：${(e as Error).message}`)).finally(() => { this.busy = null; });
  }

  get active() { return this.busy !== null; }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort?.();
    await this.busy?.catch(() => undefined);
  }

  /** 等当前这一场结束（测试用） */
  async idle(): Promise<void> { await this.busy?.catch(() => undefined); }

  private async serve(offer: RemoteOffer): Promise<void> {
    const d = this.deps;
    const decline = async (why: string) => { await this.say(`拒绝申请 ${offer.id}：${why}`); await d.api.decline(offer.id, why).catch(() => undefined); };
    const policy = await d.policy();
    if (policy === 'off') return decline('电脑主人没有允许远程协助');
    const target = d.openTarget(offer);
    if (!target) return decline('店铺窗口没有打开，请先在 OA 里登录这家店铺');
    if (policy === 'prompt') {
      const ok = await d.consent({ requestedByName: offer.requestedByName, storeName: offer.store.name, mode: offer.mode, reason: offer.reason, minutes: offer.maxMinutes });
      if (!ok) return decline('电脑主人没有同意');
    }
    let accepted;
    try { accepted = await d.api.accept(offer.id); } catch (e) { await this.say(`同意失败（${(e as Error).message}）`); return; }
    await this.say(`开始协助：${offer.requestedByName} ${accepted.mode === 'control' ? '可操作' : '只观看'}店铺「${offer.store.name}」，到 ${accepted.expiresAt}`);
    await this.runSession(offer, accepted, target);
  }

  private async runSession(offer: RemoteOffer, accepted: { mode: 'view' | 'control'; expiresAt: string; iceServers: Parameters<RtcPeer['start']>[0]['iceServers'] }, target: RemoteTarget): Promise<void> {
    const d = this.deps;
    const id = offer.id;
    const peer = d.createPeer();
    const outbox: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    let inputs = 0, unreported = 0, cursor = 0;
    let done: { by: 'self' | 'server'; reason: 'completed' | 'error'; note: string } | null = null;
    const finish = (reason: 'completed' | 'error', note: string) => { if (!done) done = { by: 'self', reason, note }; };
    this.abort = () => finish('completed', '助手停止');
    if (this.stopping) finish('completed', '助手停止');
    const mode = accepted.mode;
    const expires = new Date(accepted.expiresAt).getTime();

    // ---- 操作：按到达顺序一条一条执行，并把结果回给网页 ----
    let chain: Promise<void> = Promise.resolve();
    let windowStart = this.now(), windowCount = 0;
    const onInput = (raw: string) => {
      chain = chain.then(async () => {
        let msg: unknown;
        try { msg = JSON.parse(raw); } catch { return; }
        const parsed = parseRemoteInput(msg);
        const rid = typeof (msg as { id?: unknown })?.id === 'string' ? (msg as { id: string }).id : '';
        if (!parsed) { peer.send({ t: 'result', id: rid, ok: false, error: '无效的操作' }); return; }
        if (mode !== 'control') { peer.send({ t: 'result', id: parsed.id, ok: false, error: '当前是只观看模式，不能操作' }); return; }
        const t = this.now();
        if (t - windowStart > 1000) { windowStart = t; windowCount = 0; }
        if (++windowCount > MAX_INPUT_PER_SECOND) { peer.send({ t: 'result', id: parsed.id, ok: false, error: '操作太快了' }); return; }
        try { await target.inject(parsed); inputs++; unreported++; peer.send({ t: 'result', id: parsed.id, ok: true }); }
        catch (e) { peer.send({ t: 'result', id: parsed.id, ok: false, error: (e as Error).message.slice(0, 100) }); }
      }).catch(() => undefined);
    };
    const handle = async (s: RemoteSignalIn) => {
      if (s.kind === 'join') await peer.makeOffer();
      else if (s.kind === 'answer' && typeof s.payload.sdp === 'string') await peer.setAnswer(s.payload.sdp);
      else if (s.kind === 'ice') await peer.addIce({ candidate: (s.payload.candidate as string | null) ?? null, sdpMid: s.payload.sdpMid as string | null | undefined, sdpMLineIndex: s.payload.sdpMLineIndex as number | null | undefined });
      else if (s.kind === 'bye') finish('completed', '申请人关闭了协助窗口');
    };

    try {
      target.onClosed(() => finish('completed', '店铺窗口已关闭'));
      await peer.start({
        iceServers: accepted.iceServers,
        onSignal: (kind, payload) => outbox.push({ kind, payload }),
        onInput,
        onState: (state) => {
          if (state === 'channel-open') peer.send({ t: 'meta', mode });
          if (state === 'failed') finish('error', 'WebRTC 连接失败（可能需要配置 TURN 服务）');
        },
      });
      await target.start((f) => peer.pushFrame(f.jpegBase64), (message) => peer.send({ t: 'notice', message }));
      let failingSince = 0;
      while (!done) {
        if (this.now() >= expires) { finish('completed', '到达时限'); break; }
        const send = outbox.splice(0, 50);
        const report = unreported; unreported = 0;
        try {
          const res = await d.api.exchange(id, { send, after: cursor, inputs: report });
          failingSince = 0;
          if (res.status !== 'active') { done = { by: 'server', reason: 'completed', note: res.endReason ?? '' }; break; }
          for (const s of res.signals) { cursor = Math.max(cursor, s.id); await handle(s); }
        } catch (e) {
          unreported += report; outbox.unshift(...send);
          if (e instanceof AgentApiError && [401, 403].includes(e.status)) { done = { by: 'server', reason: 'error', note: '授权被撤销' }; break; }
          if (e instanceof AgentApiError && e.status === 404) { done = { by: 'server', reason: 'error', note: '协助记录不存在' }; break; }
          failingSince ||= this.now();
          if (this.now() - failingSince > (d.offlineLimitMs ?? 20_000)) finish('error', '联系不上 OA');
        }
        if (!done) await sleep(d.exchangeMs ?? 500);
      }
    } catch (e) {
      finish('error', `启动失败：${(e as Error).message.slice(0, 120)}`);
    } finally {
      const result = done as { by: 'self' | 'server'; reason: 'completed' | 'error'; note: string } | null;
      await target.stop().catch(() => undefined);
      await peer.close().catch(() => undefined);
      this.abort = null;
      if (result?.by === 'self') await d.api.end(id, { reason: result.reason, note: result.note.slice(0, 200), inputs: unreported }).catch(() => undefined);
      await this.say(`协助结束（${result?.by === 'server' ? '由 OA 结束' : '本机结束'}）：${result?.note ?? ''}，共执行 ${inputs} 次操作`);
    }
  }
}

/** 真实环境的装配：本机 Chrome 里的店铺窗口 + 浏览器页面里的 WebRTC + Windows 弹窗 */
export function createRemoteRunner(cfg: AgentConfig, overrides: Partial<RemoteDeps> = {}): RemoteRunner {
  return new RemoteRunner({
    api: makeRemoteApi(cfg),
    policy: () => loadRemotePolicy(),
    consent: windowsConsentPrompt(),
    openTarget: (offer) => {
      const shop = activeShop();
      if (!shop || shop.storeId !== offer.store.id) return null;
      return new PlaywrightRemoteTarget(shop.context, getPlatform(offer.store.platform));
    },
    createPeer: () => new ChromeRtcPeer(),
    log: writeLog,
    ...overrides,
  });
}
