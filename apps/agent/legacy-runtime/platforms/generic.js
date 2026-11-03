const {
  hasVisibleLoginSurface,
  verifyStableAuthentication
} = require('./auth-verification');

function createPlatformAdapter(definition) {
  const { loginWithCredentials: runCredentialLogin } = require('./credential-login');
  const loginPattern = /扫码登录|账号登录|手机号登录|密码登录|验证码登录|立即登录|请先登录|重新登录|登录后继续|手机验证|安全验证|商家登录|电商登录/;
  const authenticatedHosts = new Set(definition.authenticatedHosts || []);
  const authenticatedDomainSuffixes = new Set(definition.authenticatedDomainSuffixes || []);
  const authenticationExcludedHosts = new Set(definition.authenticationExcludedHosts || []);
  const authenticationExcludedDomainSuffixes = new Set(definition.authenticationExcludedDomainSuffixes || []);
  const deniedExactHosts = new Set(definition.deniedExactHosts || []);
  const deniedHosts = new Set(definition.deniedHosts || []);
  const allowedDomainSuffixes = new Set(definition.allowedDomainSuffixes || []);

  function matchesHostOrSubdomain(host, expected) {
    return host === expected || host.endsWith(`.${expected}`);
  }

  function ownsUrl(value) {
    try {
      const url = new URL(String(value || ''));
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || deniedExactHosts.has(host) ||
          [...deniedHosts].some((denied) => matchesHostOrSubdomain(host, denied))) {
        return false;
      }
      return definition.allowedHosts.some((allowed) => allowed.startsWith('*.')
        ? matchesHostOrSubdomain(host, allowed.slice(2)) : host === allowed) ||
        [...allowedDomainSuffixes].some((allowed) => matchesHostOrSubdomain(host, allowed));
    } catch {
      return false;
    }
  }

  function isLoginUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return definition.loginHosts.includes(url.hostname.toLowerCase()) || /login|passport|auth/i.test(url.pathname);
    } catch {
      return true;
    }
  }

  async function ensureHome(page) {
    if (!ownsUrl(page.url()) || isLoginUrl(page.url())) {
      await page.goto(definition.homeUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    }
  }

  async function inspectAuthentication(page) {
    if (!ownsUrl(page.url()) || isLoginUrl(page.url())) return { authenticated: false, signals: [], reason: 'login_or_external_url' };
    const url = new URL(page.url());
    const hostname = url.hostname.toLowerCase();
    // Linked service pages can be controlled without proving the shop is logged in.
    if (authenticationExcludedHosts.has(hostname) ||
        [...authenticationExcludedDomainSuffixes].some((excluded) => matchesHostOrSubdomain(hostname, excluded))) {
      return { authenticated: false, signals: [], reason: 'authentication_excluded_host' };
    }
    const body = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    if (loginPattern.test(body) || await hasVisibleLoginSurface(page)) {
      return { authenticated: false, signals: [], reason: 'visible_login_surface' };
    }
    const textSignals = definition.authenticatedSignals.filter((signal) => body.includes(signal));
    const trustedMerchantHost = authenticatedHosts.has(hostname) ||
      [...authenticatedDomainSuffixes].some((allowed) => matchesHostOrSubdomain(hostname, allowed));
    const signals = textSignals.length >= 2
      ? textSignals
      : trustedMerchantHost
        ? [`merchant_host:${hostname}`, `merchant_route:${url.pathname || '/'}`]
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
      platformCode: definition.platformCode,
      ...options
    });
  }

  async function waitForHumanLogin(context, page, timeoutMs, signal) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('用户已取消登录请求');
      const authenticatedPage = await findAuthenticatedPage(context, page);
      if (authenticatedPage) return authenticatedPage;
      const openPages = typeof context?.pages === 'function'
        ? context.pages().filter((candidate) => candidate && !candidate.isClosed?.())
        : [];
      if (!openPages.length) throw new Error('登录窗口已关闭，请在网页重新执行');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`等待${definition.platformName}人工登录超时`);
  }

  async function loginWithCredentials(context, page, credentials) {
    return runCredentialLogin({
      context,
      page,
      credentials,
      findAuthenticatedPage,
      platformCode: definition.platformCode
    });
  }

  return Object.freeze({
    platformCode: definition.platformCode,
    platformName: definition.platformName,
    homeUrl: definition.homeUrl,
    allowedHosts: Object.freeze([...definition.allowedHosts]),
    ensureHome,
    findAuthenticatedPage,
    inspectAuthentication,
    isAuthenticated,
    loginWithCredentials,
    ownsUrl,
    verifyAuthentication,
    waitForHumanLogin
  });
}

module.exports = { createPlatformAdapter };
