import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { log } from './config';

/** 找本机的 Chrome（没有就用 Edge）。助手不自带浏览器，用电脑上现成的。 */
export function findBrowserExecutable(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  const override = env.KUDESI_CHROME;
  if (override) {
    if (!exists(override)) throw new Error(`KUDESI_CHROME 指定的浏览器不存在：${override}`);
    return override;
  }
  const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = env['LOCALAPPDATA'] ?? '';
  const candidates = process.platform === 'win32'
    ? [`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`, `${local}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((p) => p && exists(p));
  if (!found) throw new Error('这台电脑上没找到 Chrome 或 Edge，请先安装 Google Chrome');
  return found;
}

export interface ShopBrowser { storeId: number; profileKey?: string; context: BrowserContext; closed: boolean }
let active: ShopBrowser | null = null;

export const activeShop = (): ShopBrowser | null => (active && !active.closed ? active : null);

/** 同一时间只开一家店铺的窗口；换店铺会先关掉上一家。每家店铺一个独立 Profile，登录状态互不影响。 */
export async function openShopContext(storeId: number, profileDir: string, profileKey = String(storeId)): Promise<{ shop: ShopBrowser; page: Page }> {
  if (active && !active.closed && (active.storeId !== storeId || (active.profileKey ?? String(active.storeId)) !== profileKey)) await closeActive();
  if (!active || active.closed) {
    await fsp.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const headless = process.env.KUDESI_AGENT_HEADLESS === '1';
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: findBrowserExecutable(),
      headless,
      viewport: headless ? { width: 1366, height: 900 } : null,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      acceptDownloads: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', ...(headless ? ['--no-sandbox'] : ['--start-maximized'])],
    });
    const shop: ShopBrowser = { storeId, profileKey, context, closed: false };
    context.once('close', () => { shop.closed = true; if (active === shop) active = null; void log(`店铺 ${storeId} 的浏览器窗口已关闭`); });
    active = shop;
  }
  const shop = active!;
  const page = shop.context.pages().find((p) => !p.isClosed()) ?? (await shop.context.newPage());
  await page.bringToFront().catch(() => undefined);
  return { shop, page };
}

export async function closeActive(): Promise<void> {
  const s = active;
  active = null;
  if (s && !s.closed) { s.closed = true; await s.context.close().catch(() => undefined); }
}
