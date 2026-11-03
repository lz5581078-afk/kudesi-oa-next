const { agentApi } = require('./api');
const { verifyAdapterAuthentication } = require('./browser');
const { defaultRemoteInputRegistry } = require('./remote-input');
const { getPlatformAdapter } = require('./platforms');
const { markLocalLoginStatus } = require('./sessions');

const REMOTE_COMMAND_KINDS = Object.freeze(['click', 'drag', 'scroll']);
const REMOTE_FRAME_INTERVAL_MS = 400;
const REMOTE_FRAME_MAX_BYTES = 650000;
const BROWSER_HEARTBEAT_INTERVAL_MS = 5000;

const registeredBrowsers = new Map();
let activeRemotePointer = null;

function isAllowedMerchantUrl(value, platformCode = 'pdd') {
  try { return getPlatformAdapter(platformCode).ownsUrl(value); }
  catch { return false; }
}

function remotePoint(value, fallbackTime = 0) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const t = Math.round(Number(value.t) || fallbackTime);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y, t: Math.max(0, Math.min(8000, t)) };
}

function normalizeRemoteCommand(command = {}) {
  const kind = String(command.kind || '');
  const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
  if (!REMOTE_COMMAND_KINDS.includes(kind)) throw new Error('不支持的远程操作');
  if (kind === 'scroll') {
    const deltaY = Math.max(-2000, Math.min(2000, Math.round(Number(payload.deltaY) || 0)));
    if (!deltaY) throw new Error('滚动距离无效');
    return { ...command, kind, payload: { deltaY } };
  }
  if (kind === 'click') {
    const point = remotePoint(payload.point);
    if (!point) throw new Error('点击位置无效');
    return { ...command, kind, payload: { point } };
  }
  const phase = String(payload.phase || '');
  if (['start', 'move', 'end'].includes(phase)) {
    const point = remotePoint(payload.point);
    if (!point) throw new Error('实时拖动位置无效');
    return { ...command, kind, payload: { phase, point } };
  }
  if (!Array.isArray(payload.points) || payload.points.length < 2 || payload.points.length > 80) {
    throw new Error('拖动轨迹无效');
  }
  const points = payload.points.map((point, index) => remotePoint(point, index * 40));
  if (points.some((point) => !point)) throw new Error('拖动轨迹无效');
  let previous = 0;
  for (const point of points) {
    if (point.t < previous) point.t = previous;
    previous = point.t;
  }
  return { ...command, kind, payload: { points } };
}

function selectMerchantPage(context, platformCode = 'pdd') {
  const pages = context.pages();
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const page = pages[index];
    if (page && !page.isClosed() && isAllowedMerchantUrl(page.url(), platformCode)) return page;
  }
  return null;
}

function registerRemoteBrowser(context, metadata) {
  const browserSessionId = String(metadata?.browserSessionId || '');
  if (!/^[0-9a-f-]{36}$/i.test(browserSessionId)) throw new Error('浏览器会话编号无效');
  const platformCode = String(metadata?.platformCode || '');
  const page = metadata?.page || selectMerchantPage(context, platformCode);
  const registration = {
    context,
    browserSessionId,
    title: String(metadata?.title || ''),
    shopName: String(metadata?.shopName || ''),
    shopId: String(metadata?.shopId || ''),
    deviceId: String(metadata?.deviceId || ''),
    localProfileId: String(metadata?.localProfileId || ''),
    platformCode,
    executablePath: String(metadata?.executablePath || ''),
    profileDirectory: String(metadata?.profileDirectory || ''),
    browserProcessId: Number(metadata?.browserProcessId),
    page
  };
  if (!registration.shopId || !registration.deviceId || !registration.localProfileId || !registration.platformCode ||
      !registration.executablePath || !registration.profileDirectory ||
      !Number.isInteger(registration.browserProcessId) || registration.browserProcessId <= 0 || !page) {
    throw new Error('浏览器远程注册信息不完整');
  }
  const unregisterInput = defaultRemoteInputRegistry.register(registration);
  registeredBrowsers.set(browserSessionId, registration);
  return () => {
    if (registeredBrowsers.get(browserSessionId) === registration) {
      registeredBrowsers.delete(browserSessionId);
      unregisterInput();
    }
  };
}

function getRemoteBrowserRegistration(browserSessionId) {
  return registeredBrowsers.get(String(browserSessionId || '')) || null;
}

async function closeRemoteBrowserRegistration(binding = {}) {
  const registration = getRemoteBrowserRegistration(binding.browserSessionId);
  if (!registration) throw new Error('浏览器窗口不存在或已经关闭');
  const exactBinding = String(binding.browserSessionId || '') === registration.browserSessionId
    && String(binding.shopId || '') === registration.shopId
    && String(binding.deviceId || '') === registration.deviceId
    && String(binding.localProfileId || '') === registration.localProfileId;
  if (!exactBinding) throw new Error('浏览器关闭任务归属不一致');
  await releaseRemotePointer();
  await registration.context.close();
  return { browserSessionId: registration.browserSessionId, closed: true };
}

async function saveRemoteBrowserRegistration(config, binding = {}, options = {}) {
  const registration = getRemoteBrowserRegistration(binding.browserSessionId);
  if (!registration) throw new Error('浏览器窗口不存在或已经关闭');
  const exactBinding = String(binding.browserSessionId || '') === registration.browserSessionId
    && String(binding.shopId || '') === registration.shopId
    && String(binding.deviceId || '') === registration.deviceId
    && String(binding.localProfileId || '') === registration.localProfileId;
  if (!exactBinding) throw new Error('浏览器保存任务归属不一致');
  const adapter = getPlatformAdapter(registration.platformCode);
  const verification = await (options.verifyAuthentication || verifyAdapterAuthentication)(
    adapter,
    registration.context,
    registration.page,
    { attempts: 2 }
  );
  if (!verification?.authenticated || !verification.page || !verification.evidence) {
    return {
      browserSessionId: registration.browserSessionId,
      saved: false,
      reason: 'not_authenticated'
    };
  }
  await (options.markLocalLoginStatus || markLocalLoginStatus)(
    config,
    registration.shopId,
    registration.localProfileId,
    'valid',
    {
      ...(options.sessionOptions || {}),
      verification: verification.evidence
    }
  );
  registration.page = verification.page;
  return { browserSessionId: registration.browserSessionId, saved: true, mode: 'local_profile' };
}

function activeBrowserSessionIds() {
  return [...registeredBrowsers.keys()];
}

async function releaseRemotePointer() {
  const active = activeRemotePointer;
  activeRemotePointer = null;
  if (!active || active.page.isClosed()) return;
  await active.page.mouse.up().catch(() => undefined);
}

async function executeRemoteCommand(page, sessionId, rawCommand, platformCode = 'pdd') {
  const command = normalizeRemoteCommand(rawCommand);
  if (!isAllowedMerchantUrl(page.url(), platformCode)) throw new Error('当前页面已离开所属平台允许的商家域名');
  const viewport = await page.evaluate(() => ({
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight)
  }));
  if (command.kind === 'scroll') {
    await releaseRemotePointer();
    await page.mouse.wheel(0, command.payload.deltaY);
    return;
  }
  if (command.kind === 'click') {
    await releaseRemotePointer();
    const point = command.payload.point;
    await page.mouse.click(point.x * viewport.width, point.y * viewport.height);
    return;
  }
  const { phase } = command.payload;
  if (phase) {
    const point = command.payload.point;
    if (phase === 'start') {
      await releaseRemotePointer();
      await page.mouse.move(point.x * viewport.width, point.y * viewport.height);
      await page.mouse.down();
      activeRemotePointer = { page, sessionId };
      return;
    }
    if (!activeRemotePointer || activeRemotePointer.page !== page || activeRemotePointer.sessionId !== sessionId) {
      throw new Error('实时拖动尚未开始');
    }
    if (phase === 'move') {
      await page.mouse.move(point.x * viewport.width, point.y * viewport.height, { steps: 2 });
      return;
    }
    try {
      await page.mouse.move(point.x * viewport.width, point.y * viewport.height, { steps: 2 });
    } finally {
      await releaseRemotePointer();
    }
    return;
  }
  const points = command.payload.points;
  await releaseRemotePointer();
  const first = points[0];
  await page.mouse.move(first.x * viewport.width, first.y * viewport.height);
  await page.mouse.down();
  try {
    let previousTime = first.t || 0;
    for (const point of points.slice(1)) {
      const pointTime = Math.max(previousTime, Math.min(8000, point.t || previousTime));
      const waitMs = Math.min(160, pointTime - previousTime);
      if (waitMs > 0) await page.waitForTimeout(waitMs);
      await page.mouse.move(point.x * viewport.width, point.y * viewport.height);
      previousTime = pointTime;
    }
  } finally {
    await page.mouse.up();
  }
}

async function uploadFrame(config, sessionId, page, platformCode = 'pdd') {
  if (!isAllowedMerchantUrl(page.url(), platformCode)) throw new Error('当前页面已离开所属平台允许的商家域名');
  const viewport = await page.evaluate(() => ({
    width: Math.max(1, Math.round(window.innerWidth)),
    height: Math.max(1, Math.round(window.innerHeight))
  }));
  let screenshot = await page.screenshot({
    type: 'jpeg', quality: 36, fullPage: false, scale: 'css', animations: 'allow', timeout: 8000
  });
  if (screenshot.length > REMOTE_FRAME_MAX_BYTES) {
    screenshot = await page.screenshot({
      type: 'jpeg', quality: 20, fullPage: false, scale: 'css', animations: 'allow', timeout: 8000
    });
  }
  if (screenshot.length > REMOTE_FRAME_MAX_BYTES) throw new Error('当前页面截图过大，暂时无法传输远程画面');
  await agentApi(config, '/api/session-manager/agent/remote', {
    method: 'POST',
    body: JSON.stringify({
      action: 'frame', sessionId, pageUrl: page.url(),
      width: viewport.width, height: viewport.height,
      frame: screenshot.toString('base64')
    })
  });
}

async function reportCommand(config, commandId, ok, error) {
  await agentApi(config, '/api/session-manager/agent/remote', {
    method: 'PATCH',
    body: JSON.stringify({ commandId, ok, error: ok ? undefined : String(error || '').slice(0, 1000) })
  });
}

async function reportRemoteError(config, sessionId, error) {
  await agentApi(config, '/api/session-manager/agent/remote', {
    method: 'POST',
    body: JSON.stringify({ action: 'error', sessionId, error: String(error || '').slice(0, 1000) })
  });
}

async function reportBrowserClose(config, action, job, error) {
  return agentApi(config, '/api/session-manager/agent/remote', {
    method: 'POST',
    body: JSON.stringify({
      action,
      sessionId: job.remoteSessionId,
      browserSessionId: job.browserSessionId,
      shopId: job.shopId,
      localProfileId: job.localProfileId,
      error: error ? String(error).slice(0, 1000) : undefined
    })
  });
}

async function reportBrowserCloseProgress(config, job, stage) {
  return agentApi(config, '/api/session-manager/agent/remote', {
    method: 'POST',
    body: JSON.stringify({
      action: 'browser_close_progress',
      sessionId: job.remoteSessionId,
      stage
    })
  });
}

async function heartbeatRegisteredBrowsers(config) {
  for (const registration of registeredBrowsers.values()) {
    const pages = registration.context.pages().filter((page) => !page.isClosed());
    const page = selectMerchantPage(registration.context, registration.platformCode) || pages.at(-1);
    await agentApi(config, `/api/session-manager/agent/browser-sessions/${registration.browserSessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'heartbeat', pageUrl: page?.url() || '' })
    });
  }
}

async function runRemoteLoop(config, isStopped, stopSignal) {
  let lastFrameAt = 0;
  let lastBrowserHeartbeatAt = 0;
  let activeSessionId = '';
  while (!isStopped()) {
    let delayMs = 1500;
    try {
      if (Date.now() - lastBrowserHeartbeatAt >= BROWSER_HEARTBEAT_INTERVAL_MS) {
        await heartbeatRegisteredBrowsers(config);
        lastBrowserHeartbeatAt = Date.now();
      }
      const result = await agentApi(config, '/api/session-manager/agent/remote');
      const session = result.session;
      if (!session) {
        await releaseRemotePointer();
        activeSessionId = '';
        await wait(delayMs, stopSignal);
        continue;
      }
      delayMs = 120;
      if (activeSessionId !== session.id) {
        await releaseRemotePointer();
        activeSessionId = session.id;
        lastFrameAt = 0;
      }
      const registration = registeredBrowsers.get(session.browserSessionId);
      if (!registration) {
        await reportRemoteError(config, session.id, '浏览器窗口不存在或不属于当前电脑');
        await wait(700, stopSignal);
        continue;
      }
      const page = selectMerchantPage(registration.context, registration.platformCode);
      if (!page) {
        await reportRemoteError(config, session.id, '浏览器页面已离开所属平台允许的商家域名');
        await wait(700, stopSignal);
        continue;
      }
      for (const command of result.commands || []) {
        try {
          await executeRemoteCommand(page, session.id, command, registration.platformCode);
          await reportCommand(config, command.id, true);
        } catch (error) {
          await reportCommand(config, command.id, false, error.message || '远程操作执行失败');
        }
      }
      if (Date.now() - lastFrameAt >= REMOTE_FRAME_INTERVAL_MS) {
        await uploadFrame(config, session.id, page, registration.platformCode);
        lastFrameAt = Date.now();
      }
    } catch (error) {
      await releaseRemotePointer();
      delayMs = 1500;
    }
    await wait(delayMs, stopSignal);
  }
  await releaseRemotePointer();
}

function startRemoteAssistance(config) {
  let stopped = false;
  let signalStop = () => {};
  const stopSignal = new Promise((resolve) => { signalStop = resolve; });
  const running = runRemoteLoop(config, () => stopped, stopSignal);
  return async () => {
    stopped = true;
    signalStop();
    await running.catch(() => undefined);
  };
}

function wait(milliseconds, stopSignal) {
  return Promise.race([
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
    stopSignal
  ]);
}

module.exports = {
  activeBrowserSessionIds,
  BROWSER_HEARTBEAT_INTERVAL_MS,
  REMOTE_COMMAND_KINDS,
  REMOTE_FRAME_INTERVAL_MS,
  REMOTE_FRAME_MAX_BYTES,
  closeRemoteBrowserRegistration,
  saveRemoteBrowserRegistration,
  executeRemoteCommand,
  getRemoteBrowserRegistration,
  heartbeatRegisteredBrowsers,
  isAllowedMerchantUrl,
  normalizeRemoteCommand,
  registerRemoteBrowser,
  reportBrowserClose,
  reportBrowserCloseProgress,
  reportRemoteError,
  selectMerchantPage,
  startRemoteAssistance
};
