import type { Page } from 'playwright-core';
import { api, type OpenRequest } from './api';
import { activeShop, openShopContext } from './browser';
import { log, profileDirFor, writeStatus, type AgentConfig } from './config';
import { ensureHome, findAuthenticatedPage, getPlatform, inspectAuth, loginWithCredentials, PlatformError, verifyAuth, waitForHumanLogin } from './platforms';

export interface JobOptions { loginTimeoutMs?: number; signal?: AbortSignal; onProgress?: (step: string, percent: number) => Promise<void> }

/** 从错误文字里抹掉密码，再交给服务器。 */
export function scrub(text: string, secret?: string | null): string {
  const t = String(text ?? '').slice(0, 280);
  return secret && secret.length >= 3 ? t.split(secret).join('******') : t;
}

/** 打开店铺：专用 Profile → 本地登录态有效就直接用 → 否则自动登录 → 需要人时等人在窗口里登录。 */
export async function openShop(cfg: AgentConfig, req: OpenRequest, o: JobOptions = {}): Promise<void> {
  const def = getPlatform(req.store.platform);
  const storeId = storeIdOf(req);
  await o.onProgress?.('opening_profile', 60);
  const profileKey = profileKeyOf(cfg, req);
  const { shop, page } = await openShopContext(storeId, await profileDirFor(cfg, profileKey), String(profileKey));
  let current: Page = page;
  await ensureHome(def, current).catch(() => undefined);
  await o.onProgress?.('checking_local', 65);
  let ok = await verifyAuth(def, shop.context, current);
  if (ok) return void (await log(`店铺「${req.store.name}」本机登录态有效`));
  const cred = req.credentials;
  if (cred?.account && cred.password) {
    await o.onProgress?.('auto_login', 75);
    await writeStatus({ state: 'busy', message: '正在自动登录', store: req.store.name });
    const r = await loginWithCredentials(def, shop.context, current, cred);
    if (r.status === 'authenticated') return void (await log(`店铺「${req.store.name}」自动登录成功`));
    if (r.status === 'rejected') throw new PlatformError('credential_rejected', r.message);
    await log(`店铺「${req.store.name}」自动登录需要人工：${r.message}`);
  }
  await o.onProgress?.('waiting_login', 80);
  await writeStatus({ state: 'waiting_login', message: '请在店铺窗口里完成登录', store: req.store.name });
  current = await waitForHumanLogin(def, shop.context, current, o.loginTimeoutMs ?? 30 * 60_000, o.signal);
  await o.onProgress?.('verifying', 95);
  ok = await verifyAuth(def, shop.context, current);
  if (!ok) throw new PlatformError('login_expired', '没有检测到已登录的店铺页面');
}

/** 截取当前店铺窗口里正在看的页面（提现凭证）。优先截已登录的后台页面。 */
export async function captureShop(cfg: AgentConfig, req: OpenRequest): Promise<Buffer> {
  const def = getPlatform(req.store.platform);
  const shop = activeShop();
  if (!shop || shop.storeId !== storeIdOf(req) || (req.profileKey && shop.profileKey !== String(profileKeyOf(cfg, req)))) throw new PlatformError('no_window', '这家店铺的窗口没有打开，请先在 OA 里点“立即登录”并完成提现操作');
  const pages = shop.context.pages().filter((p) => !p.isClosed());
  if (!pages.length) throw new PlatformError('no_window', '店铺窗口里没有页面');
  const authed = await findAuthenticatedPage(def, shop.context, pages[pages.length - 1]);
  const target = authed ?? pages[pages.length - 1];
  void cfg;
  await target.bringToFront().catch(() => undefined);
  return target.screenshot({ type: 'png', fullPage: false, timeout: 20_000 });
}

export function storeIdOf(req: OpenRequest): number {
  if (!req.store.id) throw new PlatformError('bad_request', '服务器没有给出店铺编号');
  return req.store.id;
}

export function profileKeyOf(cfg: AgentConfig, req: { profileKey?: string; store: { id: number } }): number | string {
  if (!req.profileKey) return req.store.id; // Compatibility for older servers; existing profiles remain in place.
  if (!/^\d+:(finance_withdrawal|company_store_maintenance):\d+$/.test(req.profileKey)) throw new PlatformError('bad_request', '店铺登录环境标识无效');
  return `${new URL(cfg.serverUrl).origin}|${req.profileKey}`;
}

export async function runJob(cfg: AgentConfig, req: OpenRequest, o: JobOptions = {}): Promise<void> {
  const secret = req.credentials?.password ?? null;
  try {
    if (req.kind === 'capture') {
      const png = await captureShop(cfg, req);
      await api.upload(cfg, req.id, png, `提现凭证-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`);
      await log(`已上传店铺「${req.store.name}」页面截图`);
    } else {
      await openShop(cfg, req, { ...o, onProgress: async (step, progress) => { await api.report(cfg, req.id, { status: 'progress', step, progress }).catch(() => undefined); await o.onProgress?.(step, progress); } });
      await api.report(cfg, req.id, { status: 'succeeded' });
    }
  } catch (e) {
    const code = e instanceof PlatformError ? e.code : req.kind === 'capture' ? 'capture_failed' : 'open_failed';
    const text = scrub((e as Error).message, secret);
    await log(`请求 ${req.id} 失败（${code}）：${text}`);
    await api.report(cfg, req.id, { status: 'failed', errorCode: code === 'login_expired' ? 'login_expired' : code, errorText: text }).catch(() => undefined);
  } finally {
    req.credentials = null;
  }
}

export { inspectAuth };
