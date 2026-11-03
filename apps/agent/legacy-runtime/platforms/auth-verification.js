const AUTHENTICATION_VERIFICATION_METHOD = 'platform_page_stable_v2';

const LOGIN_SURFACE_SELECTOR = [
  'input[type="password"]',
  'iframe[src*="login" i]',
  'iframe[src*="passport" i]',
  '[class*="login" i] input',
  '[id*="login" i] input',
  '[class*="qrcode" i]'
].join(',');

async function hasVisibleLoginSurface(page) {
  try {
    const locator = page.locator(LOGIN_SURFACE_SELECTOR);
    if (!locator || typeof locator.count !== 'function') return false;
    const count = Math.min(await locator.count(), 8);
    for (let index = 0; index < count; index += 1) {
      const candidate = typeof locator.nth === 'function' ? locator.nth(index) : null;
      if (candidate && typeof candidate.isVisible === 'function' && await candidate.isVisible().catch(() => false)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function authenticationEvidence({ platformCode, page, signals, checks }) {
  return {
    method: AUTHENTICATION_VERIFICATION_METHOD,
    platformCode,
    url: String(page.url() || '').slice(0, 1_000),
    checkedAt: new Date().toISOString(),
    checks,
    signals: [...new Set(signals || [])].slice(0, 12)
  };
}

async function waitBetweenChecks(page, intervalMs) {
  if (intervalMs <= 0) return;
  if (typeof page?.waitForTimeout === 'function') await page.waitForTimeout(intervalMs);
  else await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

async function verifyStableAuthentication({
  context,
  preferredPage,
  findAuthenticatedPage,
  inspectAuthentication,
  platformCode,
  attempts = 2,
  intervalMs = 750
}) {
  let latestPage = null;
  let latestInspection = { authenticated: false, signals: [] };
  for (let index = 0; index < attempts; index += 1) {
    latestPage = await findAuthenticatedPage(context, latestPage || preferredPage);
    if (!latestPage) return { authenticated: false, page: null, signals: [], evidence: null };
    latestInspection = await inspectAuthentication(latestPage);
    if (!latestInspection.authenticated) return { ...latestInspection, page: null, evidence: null };
    if (index + 1 < attempts) await waitBetweenChecks(latestPage, intervalMs);
  }
  return {
    ...latestInspection,
    page: latestPage,
    evidence: authenticationEvidence({
      platformCode,
      page: latestPage,
      signals: latestInspection.signals,
      checks: attempts
    })
  };
}

module.exports = {
  AUTHENTICATION_VERIFICATION_METHOD,
  authenticationEvidence,
  hasVisibleLoginSurface,
  verifyStableAuthentication
};
