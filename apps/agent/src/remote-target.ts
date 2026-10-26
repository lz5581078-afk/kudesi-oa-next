import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import { ownsUrl, type PlatformDef } from './platforms';
import { keyCombo, type RemoteInput } from './remote-input';

export interface Frame { jpegBase64: string; width: number; height: number }

/**
 * 被协助的东西：一家店铺的浏览器窗口。画面从这里来，操作往这里去。
 * 这是抓屏/注入操作的接口：默认实现 PlaywrightRemoteTarget 用 Chrome 自带的调试协议（Windows、Mac、Linux 通用，
 * 不需要原生组件）；只能拍到浏览器页面内容，拍不到系统弹窗和浏览器外框。以后要拍整个桌面，实现这个接口换掉即可。
 */
export interface RemoteTarget {
  /** 开始推送画面；只推送平台自己域名下的页面，页面跑到别的域名就暂停并通过 onNotice 提示 */
  start(onFrame: (f: Frame) => void, onNotice: (message: string) => void): Promise<void>;
  /** 店铺窗口被关掉 */
  onClosed(cb: () => void): void;
  /** 注入一条已校验的输入；页面不在平台域名下会拒绝 */
  inject(input: RemoteInput): Promise<void>;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TargetOptions { quality?: number; maxWidth?: number; maxHeight?: number; pagePollMs?: number }

export class PlaywrightRemoteTarget implements RemoteTarget {
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private stopped = false;
  private closedCb: (() => void) | null = null;
  private emit: ((f: Frame) => void) | null = null;
  private notice: ((m: string) => void) | null = null;
  private noticed = '';
  private watcher: NodeJS.Timeout | null = null;
  private lastSize = { w: 0, h: 0 };

  constructor(private readonly context: BrowserContext, private readonly platform: PlatformDef, private readonly opts: TargetOptions = {}) {}

  onClosed(cb: () => void) { this.closedCb = cb; this.context.once('close', () => { if (!this.stopped) cb(); }); }

  /** 当前要共享的页面：最后一个在平台域名下的标签页 */
  private pick(): Page | null {
    const pages = this.context.pages().filter((p) => !p.isClosed() && ownsUrl(this.platform, p.url()));
    return pages.length ? pages[pages.length - 1] : null;
  }

  private say(m: string) { if (m !== this.noticed) { this.noticed = m; this.notice?.(m); } }

  async start(onFrame: (f: Frame) => void, onNotice: (m: string) => void): Promise<void> {
    this.emit = onFrame; this.notice = onNotice;
    await this.attach();
    // 标签页切换/跳转：每 700ms 检查一次共享的页面是否还合规，必要时换页或暂停
    this.watcher = setInterval(() => { void this.attach().catch(() => undefined); }, this.opts.pagePollMs ?? 700);
  }

  private async attach() {
    if (this.stopped) return;
    const next = this.pick();
    if (next === this.page && (!next || this.cdp)) return;
    if (this.page !== next || !next) await this.detach();
    if (!next) { this.say('当前页面不在平台域名下，画面已暂停'); return; }
    this.page = next;
    this.noticed = '';
    const cdp = await this.context.newCDPSession(next);
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (e: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number } }) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => undefined);
      // 页面一旦离开平台域名，立刻不再外发这一帧
      if (this.stopped || this.page !== next || !ownsUrl(this.platform, next.url())) return;
      const w = Math.round(e.metadata.deviceWidth ?? 0), h = Math.round(e.metadata.deviceHeight ?? 0);
      if (w > 0 && h > 0) this.lastSize = { w, h };
      this.emit?.({ jpegBase64: e.data, width: w, height: h });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.opts.quality ?? 60, maxWidth: this.opts.maxWidth ?? 1280, maxHeight: this.opts.maxHeight ?? 900, everyNthFrame: 1 });
    await next.bringToFront().catch(() => undefined);
  }

  private async detach() {
    const c = this.cdp; this.cdp = null; this.page = null;
    if (c) { await c.send('Page.stopScreencast').catch(() => undefined); await c.detach().catch(() => undefined); }
  }

  /** 以最近一帧的页面尺寸（CSS 像素）换算坐标；没拿到就读页面窗口尺寸 */
  private async size(page: Page) {
    if (this.lastSize.w > 0) return this.lastSize;
    const s = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    return s;
  }

  async inject(input: RemoteInput): Promise<void> {
    const page = this.page;
    if (!page || page.isClosed() || !ownsUrl(this.platform, page.url())) throw new Error('当前页面不在平台域名下，不能操作');
    if (input.t === 'key') { await page.keyboard.press(keyCombo(input.key, input.mods)); return; }
    if (input.t === 'text') { await page.keyboard.insertText(input.text); return; }
    const { w, h } = await this.size(page);
    const x = Math.min(w - 1, Math.max(0, Math.round(input.x * w))), y = Math.min(h - 1, Math.max(0, Math.round(input.y * h)));
    if (input.t === 'move') await page.mouse.move(x, y);
    else if (input.t === 'down') { await page.mouse.move(x, y); await page.mouse.down({ button: input.button }); }
    else if (input.t === 'up') { await page.mouse.move(x, y); await page.mouse.up({ button: input.button }); }
    else if (input.t === 'click') await page.mouse.click(x, y, { button: input.button, clickCount: input.count });
    else if (input.t === 'wheel') { await page.mouse.move(x, y); await page.mouse.wheel(input.dx, input.dy); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watcher) clearInterval(this.watcher);
    await this.detach();
    await sleep(0);
  }
}
