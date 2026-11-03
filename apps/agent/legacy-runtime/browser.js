const fs = require('fs/promises');
const { chromium } = require('playwright-core');
const {
  ensureShopProfile,
  profileDir,
  removeLegacySyncedState,
  saveConfig
} = require('./config');
const { writeManagedWindow } = require('./status');
const { assertChromeForTestingExecutable, writeBrowserRuntimeLog } = require('./chrome-for-testing');

let activeShopSession = null;

async function verifyAdapterAuthentication(adapter, context, page, options = {}) {
  if (typeof adapter?.verifyAuthentication === 'function') {
    return adapter.verifyAuthentication(context, page, options);
  }
  const authenticatedPage = adapter?.findAuthenticatedPage
    ? await adapter.findAuthenticatedPage(context, page)
    : (await adapter?.isAuthenticated?.(page) ? page : null);
  return {
    authenticated: Boolean(authenticatedPage),
    page: authenticatedPage,
    evidence: authenticatedPage ? {
      method: 'platform_page_stable_v2',
      platformCode: adapter?.platformCode || 'test',
      url: typeof authenticatedPage.url === 'function' ? authenticatedPage.url() : 'https://test.invalid/',
      checkedAt: new Date().toISOString(),
      checks: Number(options.attempts || 2),
      signals: ['adapter_authenticated', 'test_verification']
    } : null
  };
}

function browserLaunchOptions(executablePath, headless = false) {
  return {
    executablePath,
    headless,
    viewport: headless ? undefined : null,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      ...(headless ? [] : ['--start-maximized'])
    ]
  };
}

async function reconcileProfileSession({
  config,
  profile,
  context,
  page,
  adapter,
  save = () => saveConfig(config),
  reportBinding,
  onStep = async () => {}
}) {
  await onStep('checking_local');
  await adapter.ensureHome(page).catch(() => undefined);
  const verification = await verifyAdapterAuthentication(adapter, context, page, { attempts: 2 });
  if (verification.authenticated) {
    profile.localLoginStatus = 'valid';
    await save();
    await reportBinding({
      loginStatus: 'valid',
      sessionVersion: 0,
      appliedSessionVersion: 0,
      localStateHash: '',
      verification: verification.evidence
    });
    return { source: 'local', authenticated: true, page: verification.page, verification: verification.evidence };
  }
  return { source: 'none', authenticated: false, page };
}

async function openShopBrowser(config, storeId, storeName, options = {}) {
  const profile = ensureShopProfile(config, storeId, storeName, options.adapter?.platformCode || 'pdd');
  await fs.mkdir(profileDir(profile), { recursive: true, mode: 0o700 });
  await removeLegacySyncedState(profile).catch(() => undefined);
  await saveConfig(config);

  if (activeShopSession && !activeShopSession.closed && activeShopSession.storeId !== String(storeId)) {
    await closeShopBrowserSession();
  }
  let context;
  let launchedHere = false;
  if (activeShopSession && !activeShopSession.closed && activeShopSession.storeId === String(storeId)) {
    context = activeShopSession.context;
  } else {
    await assertChromeForTestingExecutable(options?.executablePath);
    await writeBrowserRuntimeLog(profile);
    context = await chromium.launchPersistentContext(
      profileDir(profile),
      browserLaunchOptions(options.executablePath, Boolean(options.headless))
    );
    launchedHere = true;
    if (!options.headless) {
      const session = {
        storeId: String(storeId),
        context,
        closed: false,
        browserSessionId: '',
        unregisterBrowser: null,
        reportBrowserClosed: null
      };
      activeShopSession = session;
      await writeManagedWindow(storeId);
      context.once('close', () => {
        session.closed = true;
        if (activeShopSession === session) activeShopSession = null;
        session.unregisterBrowser?.();
        Promise.resolve(session.reportBrowserClosed?.()).catch(() => undefined);
        writeManagedWindow('').catch(() => undefined);
      });
    }
  }

  try {
    const page = context.pages().find((candidate) => !candidate.isClosed()) || await context.newPage();
    const reconciliation = await reconcileProfileSession({
      config,
      profile,
      context,
      page,
      adapter: options.adapter,
      reportBinding: (binding) => options.reportBinding(profile, binding),
      onStep: options.onStep
    });
    return { context, page, profile, reconciliation };
  } catch (error) {
    if (launchedHere) await context.close().catch(() => undefined);
    throw error;
  }
}

async function closeUnmanagedBrowserPages(context, managedPage) {
  if (!context?.pages || !managedPage || managedPage.isClosed?.()) {
    throw new Error('店铺浏览器目标页面不存在');
  }
  const pages = context.pages();
  if (!pages.includes(managedPage)) throw new Error('店铺浏览器目标页面不属于当前Profile');
  for (const page of pages) {
    if (page === managedPage || page.isClosed?.()) continue;
    await page.close({ runBeforeUnload: false });
  }
  if (managedPage.isClosed?.()) throw new Error('店铺浏览器目标页面已关闭');
}

async function closeShopBrowserSession(context) {
  const session = activeShopSession;
  if (!session || session.closed || (context && session.context !== context)) return;
  activeShopSession = null;
  session.closed = true;
  await session.context.close().catch(() => undefined);
  await writeManagedWindow('');
}

function activeShopBrowserStoreId() {
  return activeShopSession && !activeShopSession.closed ? activeShopSession.storeId : '';
}

function activeShopBrowserSession(context) {
  const session = activeShopSession;
  if (!session || session.closed || (context && session.context !== context)) return null;
  return session;
}

function registerActiveShopBrowserSession(context, registration) {
  const session = activeShopBrowserSession(context);
  if (!session) throw new Error('只能登记助手当前管理的店铺浏览器窗口');
  if (session.browserSessionId) return session.browserSessionId;
  session.browserSessionId = String(registration.browserSessionId || '');
  session.unregisterBrowser = registration.unregisterBrowser || null;
  session.reportBrowserClosed = registration.reportBrowserClosed || null;
  return session.browserSessionId;
}

module.exports = {
  activeShopBrowserSession,
  activeShopBrowserStoreId,
  browserLaunchOptions,
  closeUnmanagedBrowserPages,
  closeShopBrowserSession,
  openShopBrowser,
  reconcileProfileSession,
  registerActiveShopBrowserSession,
  verifyAdapterAuthentication
};
