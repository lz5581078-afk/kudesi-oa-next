const { ensureShopProfile, profileDir, saveConfig, shopProfileKey } = require('./config');
const {
  activeShopBrowserSession,
  closeUnmanagedBrowserPages,
  openShopBrowser,
  registerActiveShopBrowserSession,
  verifyAdapterAuthentication
} = require('./browser');
const { getPlatformAdapter } = require('./platforms');
const { agentApi } = require('./api');
const { markLocalLoginStatus, updateBinding } = require('./sessions');
const { writeAgentStatus } = require('./status');
const { ensureChromeForTestingRuntime } = require('./chrome-for-testing');
const { registerRemoteBrowser } = require('./remote-assistance');
const { resolveBrowserProcessId } = require('./browser-process');

const STEP_PROGRESS = {
  opening_profile: 20,
  checking_local: 35,
  auto_login: 55,
  verifying: 85,
  waiting_login: 70,
  completed: 100
};

async function defaultEnsureProfileBinding(config, request) {
  const key = String(request.store_id);
  const platformCode = request.platform_code || request.platformCode;
  if (!platformCode) throw new Error('打开请求缺少服务器确认的平台代码');
  const existed = Boolean(config.shops[shopProfileKey(config, key)]);
  const profile = ensureShopProfile(config, key, request.store_name, platformCode);
  await saveConfig(config);
  if (!existed) {
    await updateBinding(config, key, profile.localProfileId, {
      loginStatus: 'pending',
      sessionVersion: 0,
      appliedSessionVersion: 0
    });
  }
  return profile;
}

async function defaultRegisterManagedBrowser(config, request, opened, executablePath, overrides = {}) {
  const callAgentApi = overrides.agentApi || agentApi;
  const closeExtraPages = overrides.closeUnmanagedBrowserPages || closeUnmanagedBrowserPages;
  const findBrowserProcessId = overrides.resolveBrowserProcessId || resolveBrowserProcessId;
  const registerBrowser = overrides.registerRemoteBrowser || registerRemoteBrowser;
  const registerActiveBrowser = overrides.registerActiveShopBrowserSession || registerActiveShopBrowserSession;
  const existing = activeShopBrowserSession(opened.context);
  if (existing?.browserSessionId) return { id: existing.browserSessionId };
  await closeExtraPages(opened.context, opened.page);
  const pageUrl = opened.page?.url?.() || '';
  const browserProcessId = await findBrowserProcessId(opened.context);
  const browserSession = await callAgentApi(config, '/api/session-manager/agent/browser-sessions', {
    method: 'POST',
    body: JSON.stringify({
      openRequestId: request.id,
      storeId: request.store_id,
      localProfileId: opened.profile.localProfileId,
      platformCode: opened.profile.platformCode,
      pageUrl
    })
  });
  let unregisterBrowser;
  try {
    unregisterBrowser = registerBrowser(opened.context, {
      browserSessionId: browserSession.id,
      shopName: request.store_name,
      shopId: request.store_id,
      deviceId: config.deviceId,
      localProfileId: opened.profile.localProfileId,
      platformCode: opened.profile.platformCode,
      executablePath,
      profileDirectory: profileDir(opened.profile),
      browserProcessId,
      page: opened.page
    });
    registerActiveBrowser(opened.context, {
      browserSessionId: browserSession.id,
      unregisterBrowser,
      reportBrowserClosed: () => callAgentApi(
        config,
        `/api/session-manager/agent/browser-sessions/${browserSession.id}`,
        { method: 'PATCH', body: JSON.stringify({ action: 'closed' }) }
      )
    });
  } catch (error) {
    unregisterBrowser?.();
    await opened.context?.close?.().catch(() => undefined);
    await callAgentApi(
      config,
      `/api/session-manager/agent/browser-sessions/${browserSession.id}`,
      { method: 'PATCH', body: JSON.stringify({ action: 'error' }) }
    ).catch(() => undefined);
    throw error;
  }
  return browserSession;
}

async function runOpenShop(config, request, overrides = {}) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(overrides.signal?.reason);
  if (overrides.signal?.aborted) forwardAbort();
  else overrides.signal?.addEventListener('abort', forwardAbort, { once: true });
  let latestUpdate = null;
  const reportProgress = overrides.reportProgress || (async (update) => {
    await agentApi(
      config,
      `/api/session-manager/agent/open-requests/${request.id}`,
      { method: 'PATCH', body: JSON.stringify({ status: statusForStep(update.currentStep), ...update }) }
    );
    await writeAgentStatus({
      state: update.status,
      currentStep: update.currentStep,
      progress: update.progress,
      taskType: 'open_shop',
      taskName: request.store_name,
      message: update.errorMessage
    }, { force: update.currentStep === 'completed' || update.currentStep === 'failed' });
  });
  const reportStep = async (currentStep, details = {}) => {
    latestUpdate = { status: statusForStep(currentStep), progress: STEP_PROGRESS[currentStep], currentStep, ...details };
    return reportProgress(latestUpdate);
  };
  const leaseTimer = overrides.reportProgress ? null : setInterval(() => {
    if (!latestUpdate || ['completed', 'failed'].includes(latestUpdate.status)) return;
    reportProgress(latestUpdate).catch((error) => controller.abort(error));
  }, 10_000);
  let opened = null;
  try {
    await reportStep('opening_profile');
    const ensureProfileBinding = overrides.ensureProfileBinding || defaultEnsureProfileBinding;
    await ensureProfileBinding(config, request);
    const platformCode = request.platform_code || request.platformCode || '';
    const adapter = overrides.adapter || getPlatformAdapter(platformCode);
    const loginCredentials = request.login_credentials;
    request.login_credentials = null;
    const executablePath = overrides.executablePath || await (
      overrides.ensureChromeForTestingRuntime || ensureChromeForTestingRuntime
    )();
    opened = await (overrides.openShopBrowser || openShopBrowser)(
      config,
      String(request.store_id),
      request.store_name,
      {
        executablePath,
        adapter,
        onStep: reportStep,
        reportBinding: (profile, binding) => updateBinding(config, request.store_id, profile.localProfileId, binding)
      }
    );
    const managedBrowser = { ...opened, localProfileId: opened.profile.localProfileId, request };
    if (overrides.registerManagedBrowser) await overrides.registerManagedBrowser(managedBrowser);
    else await defaultRegisterManagedBrowser(config, request, opened, executablePath);
    if (!opened.reconciliation.authenticated) {
      const credentials = loginCredentials;
      let loginResult = null;
      if (credentials?.account && credentials?.password && typeof adapter.loginWithCredentials === 'function') {
        await reportStep('auto_login');
        loginResult = await adapter.loginWithCredentials(opened.context, opened.page, credentials);
        if (loginResult?.page) opened.page = loginResult.page;
      }
      const authenticatedAfterAutoLogin = loginResult?.status === 'authenticated';
      if (!authenticatedAfterAutoLogin) {
        await reportStep('waiting_login', {
          errorCode: loginResult?.status === 'verification_required' ? 'LOGIN_VERIFICATION_REQUIRED' : '',
          errorMessage: loginResult?.message || '登录态已失效，请在远程窗口完成登录'
        });
        opened.page = await adapter.waitForHumanLogin(
          opened.context,
          opened.page,
          overrides.loginTimeoutMs || 30 * 60_000,
          controller.signal
        ) || opened.page;
      }
      await reportStep('verifying');
      const verification = await verifyAdapterAuthentication(adapter, opened.context, opened.page, { attempts: 2 });
      if (!verification.authenticated || !verification.evidence) throw new Error('未检测到已登录店铺页面');
      opened.page = verification.page;
      await (overrides.markLocalLoginStatus || markLocalLoginStatus)(
        config,
        String(request.store_id),
        opened.profile.localProfileId,
        'valid',
        { ...overrides.sessionOptions, verification: verification.evidence }
      );
    }
    await reportStep('completed');
    return opened;
  } catch (error) {
    if (controller.signal.aborted && opened?.context?.close) {
      await opened.context.close().catch(() => undefined);
    }
    await reportProgress({
      status: 'failed',
      progress: 100,
      currentStep: 'failed',
      errorCode: error.code || 'OPEN_SHOP_FAILED',
      errorMessage: error.message || '打开店铺失败'
    }).catch(() => undefined);
    throw error;
  } finally {
    if (leaseTimer) clearInterval(leaseTimer);
    overrides.signal?.removeEventListener('abort', forwardAbort);
  }
}

function statusForStep(step) {
  if (step === 'waiting_login') return 'waiting_human';
  if (step === 'completed') return 'completed';
  return 'running';
}

module.exports = { STEP_PROGRESS, defaultRegisterManagedBrowser, runOpenShop, statusForStep };
