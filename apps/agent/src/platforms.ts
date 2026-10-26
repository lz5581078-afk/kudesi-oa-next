import type { BrowserContext, Page } from 'playwright-core';

/** 各平台商家后台：只允许在这些域名里操作、怎么判断已登录、怎么填账号密码。 */
export interface PlatformDef {
  code: string;
  name: string;
  homeUrl: string;
  /** 域名后缀（含子域名） */
  hosts: string[];
  loginHosts: string[];
  /** 已登录页面上应该能看到的文字，至少命中 2 个才算登录成功 */
  signals: string[];
  /** 这些主机不能作为“已登录”的证据（买家侧页面等） */
  excludedHosts?: string[];
  /** 域名本身就能证明是商家后台（登录后才会跳到的地址） */
  trustedHosts?: string[];
  allowHttp?: boolean;
  selectors?: { account?: string[]; password?: string[]; submit?: string[]; passwordMode?: string[] };
}

const PLATFORMS: Record<string, PlatformDef> = {
  pdd: {
    code: 'pdd', name: '拼多多', homeUrl: 'https://mms.pinduoduo.com/', hosts: ['pinduoduo.com'], loginHosts: [],
    signals: ['商品管理', '订单管理', '店铺管理', '数据中心'], trustedHosts: ['yingxiao.pinduoduo.com', 'cashier.pinduoduo.com'],
  },
  taobao: {
    code: 'taobao', name: '淘宝/天猫', homeUrl: 'https://myseller.taobao.com/home.htm', hosts: ['taobao.com', 'tmall.com', 'alipay.com'],
    loginHosts: ['loginmyseller.taobao.com', 'login.taobao.com', 'passport.taobao.com', 'auth.alipay.com'],
    signals: ['千牛工作台', '店铺管理', '交易管理', '商品管理'],
    excludedHosts: ['www.taobao.com', 'item.taobao.com', 'cart.taobao.com', 'buyertrade.taobao.com', 'trade.taobao.com', 'm.taobao.com', 'www.tmall.com', 'detail.tmall.com', 'alipay.com'],
    selectors: { account: ['#fm-login-id', 'input[name="fm-login-id"]'], password: ['#fm-login-password', 'input[name="fm-login-password"]'], submit: ['button.fm-button', '.fm-button'], passwordMode: ['.password-login-tab-item', '.password-login-link'] },
  },
  douyin: {
    code: 'douyin', name: '抖音电商', homeUrl: 'https://fxg.jinritemai.com/login/common', hosts: ['jinritemai.com'], loginHosts: ['doudian-sso.jinritemai.com'],
    signals: ['抖店工作台', '订单管理', '商品管理', '店铺管理'],
    selectors: { account: ['input[placeholder*="邮箱"]', 'input[type="email"]', 'input[placeholder*="手机号"]'], password: ['input[placeholder*="登录密码"]'], submit: ['button:has-text("立即登录")'], passwordMode: ['text=邮箱登录', 'text=账号密码登录'] },
  },
  kuaishou: {
    code: 'kuaishou', name: '快手电商', homeUrl: 'https://s.kwaixiaodian.com/', hosts: ['kwaixiaodian.com'], loginHosts: ['login.kwaixiaodian.com'],
    signals: ['快手小店', '订单管理', '商品管理', '店铺管理'],
    selectors: { account: ['input[placeholder="请输入手机号"]'], password: ['input[placeholder="请输入密码"]'], submit: ['button:has-text("登录")'], passwordMode: ['text=账号登录'] },
  },
  jd: {
    code: 'jd', name: '京东', homeUrl: 'https://shop.jd.com/', hosts: ['jd.com', 'jdpay.com'], loginHosts: ['login.shop.jd.com', 'passport.shop.jd.com', 'passport.jd.com'],
    signals: ['京麦', '订单管理', '商品管理', '店铺管理'],
    selectors: { account: ['input[placeholder="请输入京东账号"]', 'input[placeholder="请输入账号名/邮箱"]', '#loginname'], password: ['input[placeholder="请输入登录密码"]', '#nloginpwd'], submit: ['button:has-text("立即登录")', '#loginsubmit'], passwordMode: ['text=密码登录', '[role="tab"]:has-text("密码登录")'] },
  },
};

const ALIASES = new Map<string, string>([
  ['pdd', 'pdd'], ['拼多多', 'pdd'],
  ['taobao', 'taobao'], ['tmall', 'taobao'], ['淘宝', 'taobao'], ['天猫', 'taobao'],
  ['douyin', 'douyin'], ['抖音', 'douyin'], ['抖店', 'douyin'],
  ['kuaishou', 'kuaishou'], ['快手', 'kuaishou'],
  ['jd', 'jd'], ['京东', 'jd'],
]);

/** 只给自动化测试用：设置了 KUDESI_AGENT_TEST_URL 才会启用，正式环境不要设置。 */
function testPlatform(): PlatformDef | null {
  const raw = process.env.KUDESI_AGENT_TEST_URL;
  if (!raw) return null;
  const u = new URL(raw);
  return { code: 'test', name: '测试平台', homeUrl: raw, hosts: [u.hostname], loginHosts: [], signals: ['订单管理', '商品管理'], allowHttp: true };
}

export function getPlatform(value: string): PlatformDef {
  const key = String(value || '').trim().toLowerCase();
  const t = testPlatform(); // 测试环境：所有店铺都指向本机假平台
  if (t) return t;
  const code = ALIASES.get(key) ?? ALIASES.get(String(value || '').trim());
  const def = code ? PLATFORMS[code] : undefined;
  if (!def) throw new PlatformError('unsupported_platform', `平台「${value || '未填'}」助手暂不支持自动登录，请先在 OA 里把店铺平台改成拼多多、淘宝/天猫、抖音、快手或京东`);
  return def;
}

export class PlatformError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'PlatformError'; }
}

const hostMatches = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

export function ownsUrl(def: PlatformDef, value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && !(def.allowHttp && u.protocol === 'http:')) return false;
    const h = u.hostname.toLowerCase();
    return def.hosts.some((s) => hostMatches(h, s));
  } catch { return false; }
}

export function isLoginUrl(def: PlatformDef, value: string): boolean {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    return def.loginHosts.includes(h) || /login|passport|open\.html|\/auth/i.test(u.pathname);
  } catch { return true; }
}

const LOGIN_TEXT = /扫码登录|账号登录|手机号登录|密码登录|验证码登录|立即登录|请先登录|重新登录|登录后继续|安全验证|商家登录|电商登录/;
const VERIFY_TEXT = /短信验证码|图形验证码|手机验证|安全验证|安全校验|身份验证|滑块|拖动滑块|请进行验证|请完成验证|风险验证|异地登录/;
const LOGIN_ERROR_TEXT = /账号或密码错误|账号密码错误|手机号或密码错误|账号名或密码不正确|账号名或登录密码不正确|用户名或密码不正确|账户名与密码不匹配|密码错误|账号不存在|用户不存在|登录失败|登录异常/;

export interface AuthState { authenticated: boolean; reason: string }

/** 判断一个页面是否是“已登录的商家后台”。宁可判成没登录，也不能把登录页判成已登录。 */
export async function inspectAuth(def: PlatformDef, page: Page): Promise<AuthState> {
  const url = page.url();
  if (!ownsUrl(def, url) || isLoginUrl(def, url)) return { authenticated: false, reason: 'login_or_external_url' };
  const host = new URL(url).hostname.toLowerCase();
  if ((def.excludedHosts ?? []).some((e) => host === e || (e.split('.').length === 2 && hostMatches(host, e)))) return { authenticated: false, reason: 'excluded_host' };
  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (LOGIN_TEXT.test(body) && !(def.trustedHosts ?? []).includes(host)) return { authenticated: false, reason: 'login_surface' };
  if ((def.trustedHosts ?? []).includes(host)) return { authenticated: true, reason: '' };
  const hit = def.signals.filter((s) => body.includes(s));
  return hit.length >= 2 ? { authenticated: true, reason: '' } : { authenticated: false, reason: 'insufficient_signals' };
}

export async function findAuthenticatedPage(def: PlatformDef, context: BrowserContext, preferred?: Page): Promise<Page | null> {
  const pages = [...context.pages()].reverse().filter((p) => !p.isClosed());
  if (preferred && !preferred.isClosed()) { const i = pages.indexOf(preferred); if (i >= 0) pages.splice(i, 1); pages.unshift(preferred); }
  for (const p of pages) if ((await inspectAuth(def, p).catch(() => ({ authenticated: false }))).authenticated) return p;
  return null;
}

/** 连续两次都判成已登录才算数（避免页面刚跳转时的误判）。 */
export async function verifyAuth(def: PlatformDef, context: BrowserContext, preferred?: Page, gapMs = 1200): Promise<Page | null> {
  const first = await findAuthenticatedPage(def, context, preferred);
  if (!first) return null;
  await new Promise((r) => setTimeout(r, gapMs));
  return findAuthenticatedPage(def, context, first);
}

export async function ensureHome(def: PlatformDef, page: Page): Promise<void> {
  if (!ownsUrl(def, page.url()) || isLoginUrl(def, page.url())) await page.goto(def.homeUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
}

export async function waitForHumanLogin(def: PlatformDef, context: BrowserContext, page: Page, timeoutMs: number, signal?: AbortSignal): Promise<Page> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new PlatformError('cancelled', '登录已被取消');
    const ok = await findAuthenticatedPage(def, context, page);
    if (ok) return ok;
    if (!context.pages().some((p) => !p.isClosed())) throw new PlatformError('window_closed', '登录窗口被关闭了，请在网页重新点“立即登录”');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new PlatformError('login_timeout', `等待${def.name}人工登录超时`);
}

const ACCOUNT = ['input[autocomplete="username"]', 'input[name="username"]', 'input[name="account"]', 'input[name="mobile"]', 'input[type="tel"]', 'input[placeholder*="账号"]', 'input[placeholder*="用户名"]', 'input[placeholder*="手机号"]'];
const PASSWORD = ['input[autocomplete="current-password"]', 'input[name="password"]', 'input[type="password"]', 'input[placeholder*="密码"]'];
const SUBMIT = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("登录")', '[role="button"]:has-text("登录")'];
const MODE = ['text=账号登录', 'text=密码登录', 'text=账号密码登录', '[role="tab"]:has-text("账号登录")', '[role="tab"]:has-text("密码登录")'];
const uniq = (...g: string[][]) => [...new Set(g.flat())];

type Scope = Page | ReturnType<Page['frames']>[number];
const scopes = (page: Page): Scope[] => [page, ...page.frames()];

async function firstVisible(page: Page, selectors: string[]) {
  for (const sel of selectors) for (const sc of scopes(page)) {
    const loc = sc.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function allText(page: Page): Promise<string> {
  const parts = await Promise.all(scopes(page).map((s) => s.locator('body').innerText({ timeout: 1000 }).catch(() => '')));
  return parts.filter(Boolean).join('\n');
}

export type LoginResult =
  | { status: 'authenticated'; page: Page }
  | { status: 'verification_required' | 'manual_required' | 'rejected'; message: string };

/** 用账号密码自动登录。遇到验证码/滑块不硬闯，交给人在店铺窗口里完成。 */
export async function loginWithCredentials(def: PlatformDef, context: BrowserContext, page: Page, cred: { account: string; password: string }, opts: { formWaitMs?: number; resultWaitMs?: number } = {}): Promise<LoginResult> {
  const sel = def.selectors ?? {};
  const accountSel = uniq(sel.account ?? [], ACCOUNT), passSel = uniq(sel.password ?? [], PASSWORD), submitSel = uniq(sel.submit ?? [], SUBMIT), modeSel = uniq(sel.passwordMode ?? [], MODE);
  const deadline = Date.now() + (opts.formWaitMs ?? 10_000);
  let modeTried = false, acc = null as Awaited<ReturnType<typeof firstVisible>>, pw = null as typeof acc;
  while (Date.now() < deadline) {
    if (!modeTried) { const m = await firstVisible(page, modeSel); if (m) { modeTried = true; await m.click().catch(() => undefined); } }
    [acc, pw] = await Promise.all([firstVisible(page, accountSel), firstVisible(page, passSel)]);
    if (acc && pw) break;
    await page.waitForTimeout(250);
  }
  if (!acc || !pw) return { status: 'manual_required', message: '没找到账号密码输入框，请在店铺窗口里手动登录' };
  await acc.fill(cred.account);
  await pw.fill(cred.password);
  const btn = await firstVisible(page, submitSel);
  if (btn) await btn.click().catch(() => pw!.press('Enter')); else await pw.press('Enter');
  const end = Date.now() + (opts.resultWaitMs ?? 15_000);
  while (Date.now() < end) {
    await page.waitForTimeout(500);
    const ok = await verifyAuth(def, context, page, 800);
    if (ok) return { status: 'authenticated', page: ok };
    const text = await allText(page);
    if (VERIFY_TEXT.test(text)) return { status: 'verification_required', message: '平台要求验证码/滑块验证，请在店铺窗口里完成' };
    if (LOGIN_ERROR_TEXT.test(text)) return { status: 'rejected', message: '平台提示账号或密码不对，请到 OA 里检查店铺的登录账号密码' };
  }
  return { status: 'manual_required', message: '登录后没有进入商家后台，请在店铺窗口里确认或手动登录' };
}
