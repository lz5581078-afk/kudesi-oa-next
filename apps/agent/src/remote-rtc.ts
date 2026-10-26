import { chromium, type Browser, type Page } from 'playwright-core';
import { findBrowserExecutable } from './browser';

export interface IceServer { urls: string[]; username?: string; credential?: string }

/**
 * WebRTC 的助手一侧（发画面、收操作）。Node 本身没有 WebRTC，所以这里再起一个“不带界面、不带任何登录信息”的
 * 小浏览器页面专门跑 RTCPeerConnection：画面（店铺窗口的截图帧）画到 canvas 上，用 captureStream 变成视频轨道；
 * 网页发来的操作走数据通道 "input"。这个页面不访问任何网址，不碰店铺的 Profile。
 * 不想用这个方案的话（比如以后接原生 WebRTC 组件），实现 RtcPeer 接口替换即可。
 */
export interface RtcPeer {
  /** 创建连接并等待对方 join；offer / ice 通过 onSignal 往外发 */
  start(o: { iceServers: IceServer[]; onSignal: (kind: 'offer' | 'ice', payload: Record<string, unknown>) => void; onInput: (raw: string) => void; onState: (state: string) => void }): Promise<void>;
  /** 网页发来 join：生成 offer */
  makeOffer(): Promise<void>;
  setAnswer(sdp: string): Promise<void>;
  addIce(c: { candidate: string | null; sdpMid?: string | null; sdpMLineIndex?: number | null }): Promise<void>;
  /** 新的一帧画面 */
  pushFrame(jpegBase64: string): void;
  /** 通过数据通道给网页发一条消息（操作结果、提示） */
  send(message: Record<string, unknown>): void;
  close(): Promise<void>;
}

const PAGE_SCRIPT = String.raw`
(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 800;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#222'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  let last = null, pc = null, dc = null, pending = Promise.resolve();
  const draw = () => { if (!last) return; if (canvas.width !== last.width || canvas.height !== last.height) { canvas.width = last.width; canvas.height = last.height; } ctx.drawImage(last, 0, 0); };
  setInterval(draw, 120); // 画面没变化时也持续出帧，后加入的网页能马上看到
  window.__frame = (b64) => {
    pending = pending.then(async () => {
      const blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob();
      const bmp = await createImageBitmap(blob);
      const old = last; last = bmp; draw(); if (old && old.close) old.close();
    }).catch(() => undefined);
  };
  window.__start = (iceServers) => {
    pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    const stream = canvas.captureStream(10);
    const track = stream.getVideoTracks()[0];
    try { track.contentHint = 'detail'; } catch (e) {}
    const sender = pc.addTrack(track, stream);
    try { const p = sender.getParameters(); p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}]; p.encodings[0].maxBitrate = 2500000; sender.setParameters(p).catch(() => {}); } catch (e) {}
    dc = pc.createDataChannel('input', { ordered: true });
    dc.onmessage = (e) => { if (typeof e.data === 'string' && e.data.length < 4096) window.__kInput(e.data); };
    dc.onopen = () => window.__kState('channel-open');
    pc.onicecandidate = (e) => window.__kSignal('ice', e.candidate ? { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } : { candidate: null });
    pc.onconnectionstatechange = () => window.__kState(pc.connectionState);
  };
  window.__offer = async () => { const o = await pc.createOffer(); await pc.setLocalDescription(o); window.__kSignal('offer', { sdp: o.sdp }); };
  window.__answer = async (sdp) => { await pc.setRemoteDescription({ type: 'answer', sdp }); };
  window.__ice = async (c) => { if (c.candidate === null) return; await pc.addIceCandidate({ candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null }); };
  window.__send = (text) => { if (dc && dc.readyState === 'open') dc.send(text); };
  window.__close = () => { try { dc && dc.close(); pc && pc.close(); } catch (e) {} };
})();
`;

export interface ChromeRtcOptions { executablePath?: string; extraArgs?: string[] }

export class ChromeRtcPeer implements RtcPeer {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private inflight = 0;
  constructor(private readonly opts: ChromeRtcOptions = {}) {}

  async start(o: Parameters<RtcPeer['start']>[0]): Promise<void> {
    const sandboxOff = process.env.KUDESI_AGENT_HEADLESS === '1' || process.env.KUDESI_AGENT_NO_SANDBOX === '1';
    this.browser = await chromium.launch({
      executablePath: this.opts.executablePath ?? findBrowserExecutable(),
      headless: true,
      // 没有摄像头/麦克风/声音；内网直连需要看到真实内网地址，不用 mDNS 隐藏
      args: ['--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-features=WebRtcHideLocalIpsWithMdns', ...(sandboxOff ? ['--no-sandbox'] : []), ...(this.opts.extraArgs ?? [])],
    });
    const ctx = await this.browser.newContext();
    this.page = await ctx.newPage();
    await this.page.exposeFunction('__kSignal', (kind: string, payload: Record<string, unknown>) => o.onSignal(kind as 'offer' | 'ice', payload));
    await this.page.exposeFunction('__kInput', (raw: string) => o.onInput(raw));
    await this.page.exposeFunction('__kState', (s: string) => o.onState(s));
    await this.page.setContent('<!doctype html><html><body></body></html>');
    await this.page.evaluate(PAGE_SCRIPT);
    await this.page.evaluate((ice) => (window as unknown as { __start: (i: unknown) => void }).__start(ice), o.iceServers);
  }

  private get p(): Page { if (!this.page) throw new Error('WebRTC 还没有启动'); return this.page; }
  async makeOffer() { await this.p.evaluate(() => (window as unknown as { __offer: () => Promise<void> }).__offer()); }
  async setAnswer(sdp: string) { await this.p.evaluate((s) => (window as unknown as { __answer: (s: string) => Promise<void> }).__answer(s), sdp); }
  async addIce(c: { candidate: string | null; sdpMid?: string | null; sdpMLineIndex?: number | null }) { await this.p.evaluate((x) => (window as unknown as { __ice: (c: unknown) => Promise<void> }).__ice(x), c); }
  pushFrame(jpegBase64: string) {
    if (!this.page || this.inflight >= 2) return; // 来不及送就丢帧，不堆积
    this.inflight++;
    void this.page.evaluate((b) => (window as unknown as { __frame: (b: string) => void }).__frame(b), jpegBase64).catch(() => undefined).finally(() => { this.inflight--; });
  }
  send(message: Record<string, unknown>) { void this.page?.evaluate((t) => (window as unknown as { __send: (t: string) => void }).__send(t), JSON.stringify(message)).catch(() => undefined); }
  async close() {
    const b = this.browser; this.browser = null; this.page = null;
    if (b) { await b.close().catch(() => undefined); }
  }
}
