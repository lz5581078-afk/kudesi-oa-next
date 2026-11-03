const {
  hasVisibleLoginSurface,
  verifyStableAuthentication
} = require('./auth-verification');

const HOME_URL = 'https://mms.pinduoduo.com/';
const { loginWithCredentials: runCredentialLogin } = require('./credential-login');
const AUTHENTICATED_MERCHANT_HOSTS = new Set([
  'yingxiao.pinduoduo.com',
  'cashier.pinduoduo.com'
]);

function ownsUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'pinduoduo.com' || host.endsWith('.pinduoduo.com'));
  } catch (_error) {
    return false;
  }
}

function isLoginUrl(value) {
  return /login|open\.html|passport/i.test(String(value));
}

async function ensureHome(page) {
  if (!ownsUrl(page.url()) || isLoginUrl(page.url())) {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  }
}

async function inspectAuthentication(page) {
  const url = page.url();
  if (!ownsUrl(url) || isLoginUrl(url)) return { authenticated: false, signals: [], reason: 'login_or_external_url' };
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const body = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  if (/扫码登录|账号登录|手机号登录|密码登录|验证码登录|请先登录|安全验证|商家登录/.test(body) || await hasVisibleLoginSurface(page)) {
    return { authenticated: false, signals: [], reason: 'visible_login_surface' };
  }
  const dashboardSignals = ['商品管理', '订单管理', '店铺管理', '数据中心'].filter((signal) => body.includes(signal));
  const editorSignals = ['基本信息', '商品标题', '商品属性', '保存草稿'].filter((signal) => body.includes(signal));
  const textSignals = dashboardSignals.length >= 2 ? dashboardSignals : editorSignals;
  const trustedMerchantHost = AUTHENTICATED_MERCHANT_HOSTS.has(hostname);
  const signals = textSignals.length >= 2
    ? textSignals
    : trustedMerchantHost
      ? [`merchant_host:${hostname}`, `merchant_route:${parsedUrl.pathname || '/'}`]
      : textSignals;
  return {
    authenticated: textSignals.length >= 2 || trustedMerchantHost,
    signals,
    reason: textSignals.length >= 2 || trustedMerchantHost ? '' : 'insufficient_authenticated_signals'
  };
}

async function isAuthenticated(page) {
  return (await inspectAuthentication(page)).authenticated;
}

async function findAuthenticatedPage(context, preferredPage) {
  const pages = typeof context?.pages === 'function' ? context.pages() : [];
  const candidates = [...pages].reverse();
  if (preferredPage && !preferredPage.isClosed?.()) {
    const index = candidates.indexOf(preferredPage);
    if (index >= 0) candidates.splice(index, 1);
    candidates.unshift(preferredPage);
  }
  for (const candidate of candidates) {
    if (!candidate || candidate.isClosed?.() || !ownsUrl(candidate.url?.())) continue;
    if ((await inspectAuthentication(candidate).catch(() => ({ authenticated: false }))).authenticated) return candidate;
  }
  return null;
}

async function verifyAuthentication(context, preferredPage, options = {}) {
  return verifyStableAuthentication({
    context,
    preferredPage,
    findAuthenticatedPage,
    inspectAuthentication,
    platformCode: 'pdd',
    ...options
  });
}

async function waitForHumanLogin(context, page, timeoutMs, signal) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('用户已取消登录请求');
    }
    const authenticatedPage = await findAuthenticatedPage(context, page);
    if (authenticatedPage) return authenticatedPage;
    const openPages = typeof context?.pages === 'function'
      ? context.pages().filter((candidate) => candidate && !candidate.isClosed?.())
      : [];
    if (!openPages.length) throw new Error('登录窗口已关闭，请在网页重新执行');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('等待拼多多人工登录超时');
}

async function loginWithCredentials(context, page, credentials) {
  return runCredentialLogin({ context, page, credentials, findAuthenticatedPage, platformCode: 'pdd' });
}

const pddPlatformAdapter = {
  platformCode: 'pdd',
  platformName: '拼多多',
  homeUrl: HOME_URL,
  allowedHosts: ['*.pinduoduo.com', 'pinduoduo.com'],
  ensureHome,
  findAuthenticatedPage,
  inspectAuthentication,
  isAuthenticated,
  loginWithCredentials,
  ownsUrl,
  verifyAuthentication,
  waitForHumanLogin
};

module.exports = { pddPlatformAdapter };
