const { WebSocket } = require('ws');
const { agentApi } = require('./api');
const { agentDataDir } = require('./config');
const { activeShopBrowserStoreId } = require('./browser');
const { recoverMissingBrowserClose } = require('./browser-close-recovery');
const { startCaptureSidecar } = require('./capture-sidecar');
const { createWebRtcDiagnosticLogger, summarizeSidecarMessage } = require('./webrtc-diagnostics');
const { RemoteInputError, defaultRemoteInputRegistry, isAllowedPlatformUrl } = require('./remote-input');
const {
  BROWSER_HEARTBEAT_INTERVAL_MS,
  activeBrowserSessionIds,
  closeRemoteBrowserRegistration,
  saveRemoteBrowserRegistration,
  getRemoteBrowserRegistration,
  heartbeatRegisteredBrowsers,
  reportBrowserClose,
  reportBrowserCloseProgress,
  reportRemoteError,
  selectMerchantPage
} = require('./remote-assistance');

const MAX_SIGNAL_BYTES = 64 * 1024;
const WEBRTC_POLL_INTERVAL_MS = 500;
const INPUT_COMMAND_TIMEOUT_MS = 2_000;
const REMOTE_QUALITY_PROFILES = Object.freeze({
  clear: 6_000_000,
  balanced: 4_000_000,
  smooth: 2_000_000
});

function withInputCommandTimeout(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('远程输入执行超时，请重试');
      error.code = 'REMOTE_INPUT_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function assertAuthoritativeRegistration(config, binding, registration) {
  const matches = registration &&
    String(binding?.remoteSessionId || '') &&
    String(binding.browserSessionId || '') === String(registration.browserSessionId || '') &&
    String(binding.localProfileId || '') === String(registration.localProfileId || '') &&
    String(binding.shopId || '') === String(registration.shopId || '') &&
    String(binding.deviceId || '') === String(registration.deviceId || '') &&
    String(binding.platformCode || '') === String(registration.platformCode || '') &&
    String(binding.deviceId || '') === String(config?.deviceId || '');
  if (!matches) throw new Error('WebRTC浏览器会话归属不一致');
  const page = resolveRegistrationPage(registration);
  if (!page) throw new Error('浏览器窗口不存在或没有可控制的商家标签页');
  if (!registration.context?.once || !registration.executablePath || !registration.profileDirectory ||
      !Number.isInteger(Number(registration.browserProcessId)) || Number(registration.browserProcessId) <= 0) {
    throw new Error('WebRTC浏览器注册信息不完整');
  }
}

function resolveRegistrationPage(registration) {
  const current = registration?.page;
  if (current && !current.isClosed?.() &&
      isAllowedPlatformUrl(registration.platformCode, current.url?.())) return current;
  const replacement = selectMerchantPage(registration?.context, registration?.platformCode);
  if (replacement) registration.page = replacement;
  return replacement;
}

function signalingUrl(serverUrl, signalingPath) {
  const server = new URL(serverUrl);
  const target = new URL(signalingPath, server);
  if (target.origin !== server.origin || !['http:', 'https:'].includes(target.protocol)) {
    throw new Error('WebRTC信令地址无效');
  }
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  return target.toString();
}

async function createWebRtcAgentSession(options = {}) {
  const {
    config,
    binding,
    registration,
    inputRegistry = defaultRemoteInputRegistry,
    getTicket = (pathname) => agentApi(config, pathname, { method: 'POST', body: '{}' }),
    createSocket = (url) => new WebSocket(url),
    startSidecar = startCaptureSidecar,
    dataDirectory = agentDataDir(),
    onDiagnostic = null,
    inputCommandTimeoutMs = INPUT_COMMAND_TIMEOUT_MS
  } = options;
  assertAuthoritativeRegistration(config, binding, registration);
  if (!inputRegistry?.dispatch) throw new Error('WebRTC输入注册表不可用');
  const writeDiagnostic = onDiagnostic || createWebRtcDiagnosticLogger(dataDirectory);

  const ticket = await getTicket(
    `/api/session-manager/agent/remote-sessions/${binding.remoteSessionId}/webrtc-ticket`
  );
  if (!ticket?.ticket || !ticket?.signalingPath || !Array.isArray(ticket.iceServers) ||
      !['all', 'relay'].includes(ticket.iceTransportPolicy)) {
    throw new Error('WebRTC单次票据响应无效');
  }

  let stopped = false;
  let closeResult = { unexpected: false, error: '' };
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let paired = false;
  let sidecarStarted = false;
  let awaitingRestartAnswer = false;
  let inputBusy = false;
  let sidecarMessages = Promise.resolve();
  const queueSidecarMessage = (message) => {
    sidecarMessages = sidecarMessages.then(() => handleSidecarMessage(message));
    sidecarMessages.catch((error) => {
      if (!stopped) void stop(true, failureResult(error?.message || 'WebRTC sidecar通信失败'));
    });
    return sidecarMessages;
  };
  const routeSidecarMessage = (message) => {
    if (message?.type !== 'input') return queueSidecarMessage(message);
    const inputMessage = handleInputMessage(message);
    inputMessage.catch((error) => {
      if (!stopped) void stop(true, failureResult(error?.message || 'WebRTC输入通信失败'));
    });
    return inputMessage;
  };
  const socket = createSocket(signalingUrl(config.serverUrl, ticket.signalingPath));
  const sidecar = startSidecar({
    context: registration.context,
    browserSessionId: binding.browserSessionId,
    remoteSessionId: binding.remoteSessionId,
    shopId: binding.shopId,
    deviceId: binding.deviceId,
    localProfileId: binding.localProfileId,
    agentDataDirectory: dataDirectory,
    executablePath: registration.executablePath,
    profileDirectory: registration.profileDirectory,
    browserProcessId: Number(registration.browserProcessId),
    mode: 'webrtc',
    codec: 'h264',
    onMessage: routeSidecarMessage
  });
  if (typeof sidecar.withForegroundPreserved === 'function') {
    inputRegistry.setForegroundGuard?.(
      binding.browserSessionId,
      (operation) => sidecar.withForegroundPreserved(operation)
    );
  }

  socket.on('open', () => {
    if (stopped) return;
    socket.send(JSON.stringify({ type: 'authenticate', role: 'agent', ticket: ticket.ticket }));
  });
  socket.on('message', (data, isBinary) => {
    if (stopped) return;
    if (isBinary || Buffer.byteLength(data) > MAX_SIGNAL_BYTES) {
      void stop(true, failureResult('WebRTC信令消息无效'));
      return;
    }
    let message;
    try { message = JSON.parse(String(data)); }
    catch { void stop(true, failureResult('WebRTC信令消息格式无效')); return; }
    if (message.type === 'paired') {
      paired = true;
      if (!sidecarStarted) {
        sidecarStarted = true;
        sidecar.start(ticket.iceServers, ticket.iceTransportPolicy);
      }
      return;
    }
    if (message.type === 'waiting') return;
    if (message.type === 'recovery-request') {
      if (!paired || !sidecarStarted) {
        void stop(true, failureResult('WebRTC恢复请求状态无效'));
        return;
      }
      void handleRecoveryRequest(message);
      return;
    }
    if (!paired || !sidecarStarted || !['answer', 'ice', 'restart-offer'].includes(message.type)) {
      void stop(true, failureResult('WebRTC信令协议状态无效'));
      return;
    }
    if (message.type === 'ice' && message.candidate === null) return;
    if (message.type === 'restart-offer') {
      awaitingRestartAnswer = true;
      sidecar.send({ type: 'restartOffer', sdp: message.sdp });
    } else {
      sidecar.send(message.type === 'answer'
        ? { type: 'answer', sdp: message.sdp }
        : { type: 'ice', candidate: message.candidate, sdpMid: message.sdpMid || '' });
    }
  });
  socket.on('close', (code, reason) => {
    if (stopped) return;
    const normalizedCode = Number(code) || 1006;
    const normalizedReason = sanitizeCloseReason(reason);
    const expected = normalizedCode === 1000 && paired;
    void stop(false, expected
      ? { unexpected: false, error: '' }
      : failureResult(`WebRTC信令连接已关闭（${normalizedCode}${normalizedReason ? `：${normalizedReason}` : ''}）`));
  });
  socket.on('error', () => {
    if (!stopped) void stop(true, failureResult('WebRTC信令连接失败'));
  });

  let page = null;
  const onPageClosed = () => ensureTargetAlive();
  const ensureTargetAlive = () => {
    const replacement = resolveRegistrationPage(registration);
    if (!replacement) {
      void stop();
      return;
    }
    bindPage(replacement);
  };
  const onFrameNavigated = (frame) => {
    if (!page.mainFrame || frame === page.mainFrame()) ensureTargetAlive();
  };
  const bindPage = (replacement) => {
    if (page === replacement) return;
    page?.removeListener?.('framenavigated', onFrameNavigated);
    page?.removeListener?.('close', onPageClosed);
    page = replacement;
    registration.page = replacement;
    page.on?.('framenavigated', onFrameNavigated);
    page.once?.('close', onPageClosed);
  };
  bindPage(resolveRegistrationPage(registration));
  const targetMonitor = setInterval(ensureTargetAlive, 250);
  targetMonitor.unref?.();
  let expiryTimer = null;
  const updateExpiresAt = (value) => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    const expiresAt = Date.parse(value || '');
    if (!Number.isFinite(expiresAt)) return;
    expiryTimer = setTimeout(() => void stop(), Math.max(0, expiresAt - Date.now()));
    expiryTimer.unref?.();
  };
  updateExpiresAt(binding.expiresAt);

  async function handleSidecarMessage(message) {
    if (stopped) return;
    writeDiagnostic(summarizeSidecarMessage(message));
    if (message?.state === 'failed') {
      throw new Error(String(message.error || 'WebRTC sidecar运行失败').slice(0, 300));
    }
    if (message?.type === 'offer' || message?.type === 'ice' || message?.type === 'answer') {
      if (!paired || socket.readyState !== 1) throw new Error('WebRTC信令对端尚未就绪');
      if (message.type === 'answer') {
        if (!awaitingRestartAnswer) throw new Error('WebRTC ICE恢复状态无效');
        awaitingRestartAnswer = false;
        socket.send(JSON.stringify({ type: 'restart-answer', sdp: message.sdp }));
      } else {
        socket.send(JSON.stringify(message));
      }
      return;
    }
  }

  async function handleInputMessage(message) {
    if (stopped) return;
    writeDiagnostic(summarizeSidecarMessage(message));
    const data = String(message.data || '');
    if (!data || Buffer.byteLength(data) > MAX_SIGNAL_BYTES) throw new Error('WebRTC输入消息无效');
    const control = JSON.parse(data);
    if (control?.type === 'requestKeyFrame') {
      sidecar.requestKeyFrame();
      return;
    }
    if (control?.type === 'refreshControl') {
      const refreshId = String(control.refreshId || '');
      if (!refreshId || refreshId.length > 100) throw new Error('WebRTC控制刷新编号无效');
      try {
        await inputRegistry.refresh(binding);
        sidecar.requestKeyFrame();
        sidecar.sendData?.({ type: 'controlRefreshed', refreshId, ok: true });
      } catch (error) {
        sidecar.sendData?.({
          type: 'controlRefreshed',
          refreshId,
          ok: false,
          error: String(error?.message || '控制通道刷新失败').slice(0, 200)
        });
      }
      return;
    }
    if (control?.type === 'quality') {
      const mode = String(control.mode || '');
      const level = String(control.level || '');
      if (!['auto', 'clear', 'balanced', 'smooth'].includes(mode) || !REMOTE_QUALITY_PROFILES[level] ||
          (mode !== 'auto' && mode !== level)) {
        sidecar.sendData?.({ type: 'qualityApplied', mode, level, ok: false, error: '远程画质档位无效' });
        return;
      }
      const bitrate = REMOTE_QUALITY_PROFILES[level];
      sidecar.setBitrate(bitrate);
      sidecar.requestKeyFrame();
      sidecar.sendData?.({ type: 'qualityApplied', mode, level, bitrate, ok: true });
      writeDiagnostic({ event: 'quality_applied', mode, level, bitrate });
      return;
    }
    if (control?.type !== 'input' || !control.command) throw new Error('不支持的WebRTC控制消息');
    if (inputBusy) {
      sidecar.sendData?.({
        type: 'inputResult',
        commandId: control.command.commandId,
        ok: false,
        reason: 'input_busy',
        error: '上一操作仍在处理中，请稍后重试'
      });
      return;
    }
    inputBusy = true;
    const startedAt = Date.now();
    try {
      await withInputCommandTimeout(
        inputRegistry.dispatch(binding, control.command),
        inputCommandTimeoutMs
      );
      // Input can repaint the browser chrome before the next periodic frame.
      sidecar.requestKeyFrame();
      writeDiagnostic({
        event: 'input_completed',
        commandType: String(control.command.type || 'unknown').slice(0, 30),
        durationMs: Date.now() - startedAt
      });
      sidecar.sendData?.({ type: 'inputResult', commandId: control.command.commandId, ok: true });
    } catch (error) {
      if (error instanceof RemoteInputError && error.fatal) throw error;
      const reason = error?.code === 'REMOTE_INPUT_TIMEOUT'
        ? 'input_timeout'
        : error instanceof RemoteInputError ? error.reason : 'window_input_failed';
      writeDiagnostic({
        event: 'input_rejected',
        reason,
        commandType: String(control.command.type || 'unknown').slice(0, 30),
        durationMs: Date.now() - startedAt
      });
      sidecar.sendData?.({
        type: 'inputResult',
        commandId: control.command.commandId,
        ok: false,
        reason,
        error: reason === 'input_timeout'
          ? '远程输入执行超时，请重试'
          : String(error.message || '输入执行失败').slice(0, 200)
      });
    } finally {
      inputBusy = false;
    }
  }

  async function handleRecoveryRequest(message) {
    const recoveryId = String(message?.recoveryId || '');
    if (!recoveryId || recoveryId.length > 100 || stopped) return;
    try {
      await inputRegistry.refresh(binding);
      sidecar.requestKeyFrame();
      if (!stopped && socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'recovery-ack', recoveryId, ok: true }));
      }
    } catch (error) {
      if (!stopped && socket.readyState === 1) {
        socket.send(JSON.stringify({
          type: 'recovery-ack',
          recoveryId,
          ok: false,
          error: String(error?.message || '画面与控制恢复失败').slice(0, 200)
        }));
      }
    }
  }

  async function stop(closeSocket = true, result = { unexpected: false, error: '' }) {
    if (stopped) return;
    stopped = true;
    closeResult = result;
    clearInterval(targetMonitor);
    if (expiryTimer) clearTimeout(expiryTimer);
    page?.removeListener?.('framenavigated', onFrameNavigated);
    page?.removeListener?.('close', onPageClosed);
    registration.context.removeListener?.('close', stop);
    inputRegistry.setForegroundGuard?.(binding.browserSessionId, null);
    if (closeSocket && socket.readyState < 2) socket.close(1000, 'agent_session_stopped');
    await sidecar.stop();
    resolveClosed(closeResult);
  }

  registration.context.once('close', stop);
  return Object.freeze({ closed, stop, updateExpiresAt });
}

function sanitizeCloseReason(reason) {
  return String(Buffer.isBuffer(reason) ? reason.toString('utf8') : (reason || ''))
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);
}

function failureResult(error) {
  return { unexpected: true, error: String(error || 'WebRTC远程连接异常').slice(0, 500) };
}

function authoritativeBinding(config, session) {
  const binding = {
    remoteSessionId: String(session?.id || ''),
    browserSessionId: String(session?.browserSessionId || ''),
    shopId: Number(session?.shopId),
    deviceId: String(session?.deviceId || ''),
    localProfileId: String(session?.localProfileId || ''),
    platformCode: String(session?.platformCode || ''),
    expiresAt: session?.expiresAt
  };
  if (!binding.remoteSessionId || !binding.browserSessionId || !binding.localProfileId || !binding.platformCode ||
      !Number.isInteger(binding.shopId) || binding.shopId <= 0 ||
      !binding.deviceId || binding.deviceId !== String(config?.deviceId || '')) {
    throw new Error('WebRTC领取会话绑定无效');
  }
  return binding;
}

function assertClaimRegistration(binding, registration) {
  if (!registration ||
      String(registration.browserSessionId || '') !== binding.browserSessionId ||
      String(registration.localProfileId || '') !== binding.localProfileId ||
      String(registration.shopId || '') !== String(binding.shopId) ||
      String(registration.deviceId || '') !== binding.deviceId) {
    throw new Error('WebRTC浏览器会话归属不一致');
  }
}

function authoritativeCloseJob(config, job) {
  const binding = {
    remoteSessionId: String(job?.remoteSessionId || ''),
    browserSessionId: String(job?.browserSessionId || ''),
    shopId: Number(job?.shopId),
    deviceId: String(job?.deviceId || ''),
    localProfileId: String(job?.localProfileId || '')
  };
  if (!binding.remoteSessionId || !binding.browserSessionId || !binding.localProfileId ||
      !Number.isInteger(binding.shopId) || binding.shopId <= 0 ||
      binding.deviceId !== String(config?.deviceId || '')) {
    throw new Error('浏览器关闭任务绑定无效');
  }
  return binding;
}

async function waitForCloseStep(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('等待关闭步骤超时')), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createWebRtcClaimRunner(options = {}) {
  const {
    config,
    claimWork = () => agentApi(config, '/api/session-manager/agent/remote?transport=webrtc'),
    getRegistration = getRemoteBrowserRegistration,
    createSession = createWebRtcAgentSession,
    closeBrowser = closeRemoteBrowserRegistration,
    saveBrowserSession = (job) => saveRemoteBrowserRegistration(config, job),
    heartbeat = () => heartbeatRegisteredBrowsers(config),
    reportError = (sessionId, error) => reportRemoteError(config, sessionId, error?.message || error),
    reportClose = (action, job, error) => reportBrowserClose(config, action, job, error),
    reportCloseProgress = (job, stage) => reportBrowserCloseProgress(config, job, stage),
    canRecoverBrowser = () => false,
    recoverMissingBrowser = (job) => recoverMissingBrowserClose({
      config, job,
      isIdle: () => canRecoverBrowser() && !getRegistration(job.browserSessionId) &&
        !activeShopBrowserStoreId() && activeBrowserSessionIds().length === 0
    }),
    onDiagnostic = () => undefined,
    onStatus = async () => undefined,
    now = () => Date.now(),
    closeStepTimeoutMs = 5000,
    closePollWaitMs = 100
  } = options;
  const active = new Map();
  const rejectedSessions = new Map();
  const retryDelayMs = options.retryDelayMs || 5_000;
  const closeOperations = new Map();
  const missingCloseRetryAt = new Map();
  let lastHeartbeatAt = 0;
  let stopped = false;

  async function stopSession(sessionId) {
    const current = active.get(sessionId);
    active.delete(sessionId);
    if (current) await current.controller.stop();
  }

  const closeBestEffort = (work) => waitForCloseStep(Promise.resolve().then(work), closeStepTimeoutMs)
    .catch(() => undefined);

  function logClose(event, job, details = {}) {
    try {
      Promise.resolve(onDiagnostic({ event, remoteSessionId: job.remoteSessionId,
        browserSessionId: job.browserSessionId, shopId: job.shopId, ...details })).catch(() => undefined);
    } catch { /* Diagnostics must not interfere with safe close. */ }
  }

  async function processCloseJob(rawJob) {
    const job = authoritativeCloseJob(config, rawJob);
    let operation = closeOperations.get(job.remoteSessionId);
    if (operation) {
      assertClaimRegistration(job, operation.job);
    } else {
      const registration = getRegistration(job.browserSessionId);
      if (!registration) {
        if (now() < (missingCloseRetryAt.get(job.remoteSessionId) || 0)) return;
        missingCloseRetryAt.set(job.remoteSessionId, now() + 10_000);
        logClose('browser_close_recovery_started', job);
        let recovery;
        try {
          await waitForCloseStep(stopSession(job.remoteSessionId), closeStepTimeoutMs);
          recovery = await recoverMissingBrowser(job);
        } catch {
          recovery = { closed: false, reason: 'process_verification_failed' };
        }
        if (recovery?.closed !== true) {
          logClose('browser_close_recovery_pending', job, { reason: recovery?.reason || 'browser_unverified' });
          return;
        }
        operation = { job, result: { action: 'browser_closed' }, acknowledged: false,
          pending: Promise.resolve() };
        closeOperations.set(job.remoteSessionId, operation);
        missingCloseRetryAt.delete(job.remoteSessionId);
        logClose('browser_close_recovered', job, { reason: recovery.reason });
      } else {
        assertClaimRegistration(job, registration);
        operation = { job, result: null, acknowledged: false };
        closeOperations.set(job.remoteSessionId, operation);
        logClose('browser_close_started', job);
        // Keep the actual close promise alive across polls. A slow close must neither
        // block heartbeats nor start another close against the same browser.
        operation.pending = (async () => {
          await waitForCloseStep(stopSession(job.remoteSessionId), closeStepTimeoutMs);
          await closeBestEffort(() => onStatus({ state: 'saving_profile', currentStep: 'saving_profile', taskType: 'close_shop', taskName: registration.shopName || '' }));
          await closeBestEffort(() => reportCloseProgress(job, 'saving_profile'));
          await closeBestEffort(() => saveBrowserSession(job));
          await closeBestEffort(() => onStatus({ state: 'saving_profile', currentStep: 'closing_browser', taskType: 'close_shop', taskName: registration.shopName || '' }));
          await closeBestEffort(() => reportCloseProgress(job, 'closing_browser'));
          await closeBrowser(job);
          operation.result = { action: 'browser_closed' };
          logClose('browser_close_completed', job);
        })().catch((error) => {
          operation.result = { action: 'browser_close_failed', error: String(error?.message || error) };
          logClose('browser_close_failed', job);
        });
      }
    }
    await waitForCloseStep(operation.pending, closePollWaitMs).catch(() => undefined);
    if (!operation.result || operation.acknowledged) return;
    // A lost acknowledgement must retry the result, not close an unregistered or
    // replacement browser. Only an actual close failure is reported as failure.
    try {
      await waitForCloseStep(
        Promise.resolve().then(() => reportClose(operation.result.action, job, operation.result.error)),
        closeStepTimeoutMs
      );
    } catch (error) {
      logClose('browser_close_report_retry', job, { action: operation.result.action });
      throw error;
    }
    operation.acknowledged = true;
    logClose('browser_close_report_acknowledged', job, { action: operation.result.action });
    if (operation.result.action === 'browser_close_failed') closeOperations.delete(job.remoteSessionId);
    else await closeBestEffort(() => onStatus({ state: 'online_idle', currentStep: 'idle', taskType: '', taskName: '' }, true));
  }

  async function poll() {
    if (stopped) return;
    const currentTime = now();
    if (!lastHeartbeatAt || currentTime - lastHeartbeatAt >= BROWSER_HEARTBEAT_INTERVAL_MS) {
      await heartbeat().catch(() => undefined);
      lastHeartbeatAt = currentTime;
    }
    const work = await claimWork();
    const sessions = Array.isArray(work?.sessions)
      ? work.sessions
      : (work?.session ? [work.session] : []);
    const returnedIds = new Set(sessions.map((session) => String(session?.id || '')).filter(Boolean));
    const closeJobs = Array.isArray(work?.closeJobs) ? work.closeJobs : [];
    const returnedCloseIds = new Set(closeJobs.map((job) => String(job?.remoteSessionId || '')).filter(Boolean));
    for (const sessionId of missingCloseRetryAt.keys()) {
      if (!returnedCloseIds.has(sessionId)) missingCloseRetryAt.delete(sessionId);
    }
    for (const sessionId of [...active.keys()]) {
      if (!returnedIds.has(sessionId) && !returnedCloseIds.has(sessionId)) await stopSession(sessionId);
    }
    for (const sessionId of [...rejectedSessions.keys()]) {
      if (!returnedIds.has(sessionId)) rejectedSessions.delete(sessionId);
    }
    for (const [sessionId, operation] of closeOperations) {
      if (!returnedCloseIds.has(sessionId) && operation.acknowledged) closeOperations.delete(sessionId);
    }
    const closeWork = [...closeJobs];
    for (const operation of closeOperations.values()) {
      if (!returnedCloseIds.has(operation.job.remoteSessionId)) closeWork.push(operation.job);
    }
    for (const rawJob of closeWork) {
      try {
        await processCloseJob(rawJob);
      } catch (error) {
        if (!closeOperations.has(String(rawJob?.remoteSessionId || ''))) {
          await closeBestEffort(() => reportClose('browser_close_failed', rawJob, error?.message || error));
        }
      }
    }
    for (const session of sessions) {
      const sessionId = String(session.id || '');
      const current = active.get(sessionId);
      if (current) {
        current.controller.updateExpiresAt?.(session.expiresAt);
        continue;
      }
      const rejected = rejectedSessions.get(sessionId);
      if (rejected && now() < rejected.retryAt) continue;
      if (rejected) rejectedSessions.delete(sessionId);
      try {
        const binding = authoritativeBinding(config, session);
        const registration = getRegistration(binding.browserSessionId);
        assertClaimRegistration(binding, registration);
        const controller = await createSession({ config, binding, registration });
        active.set(sessionId, { controller });
        await onStatus({ state: 'remote_active', currentStep: 'remote_active', taskType: 'remote', taskName: registration.shopName || '' });
        controller.closed?.then((result) => {
          if (active.get(sessionId)?.controller === controller) {
            active.delete(sessionId);
            rejectedSessions.set(sessionId, { retryAt: now() + retryDelayMs });
            if (result?.unexpected) {
              void reportError(sessionId, new Error(result.error || 'WebRTC远程连接异常')).catch(() => undefined);
            }
          }
        }).catch((error) => {
          if (active.get(sessionId)?.controller === controller) {
            active.delete(sessionId);
            rejectedSessions.set(sessionId, { retryAt: now() + retryDelayMs });
            void reportError(sessionId, error).catch(() => undefined);
          }
        });
      } catch (error) {
        rejectedSessions.set(sessionId, { retryAt: now() + retryDelayMs });
        await reportError(sessionId, error);
      }
    }
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    await Promise.all([...active.keys()].map(stopSession));
  }

  return Object.freeze({
    get activeSessionId() { return active.keys().next().value || ''; },
    get activeSessionIds() { return [...active.keys()]; },
    poll,
    stop
  });
}

function startWebRtcAssistance(config, options = {}) {
  const runner = createWebRtcClaimRunner({ config,
    onDiagnostic: createWebRtcDiagnosticLogger(agentDataDir()), ...options });
  let stopped = false;
  let wake = () => undefined;
  const stopSignal = new Promise((resolve) => { wake = resolve; });
  const wait = options.wait || ((milliseconds) => Promise.race([
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
    stopSignal
  ]));
  const running = (async () => {
    while (!stopped) {
      try { await runner.poll(); }
      catch { /* The main agent heartbeat owns online/offline status reporting. */ }
      if (!stopped) await wait(WEBRTC_POLL_INTERVAL_MS);
    }
  })();
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    wake();
    await runner.stop();
    await running;
  };
  Object.defineProperty(stop, 'activeSessionIds', {
    enumerable: true,
    get: () => runner.activeSessionIds
  });
  return stop;
}

module.exports = {
  WEBRTC_POLL_INTERVAL_MS,
  assertAuthoritativeRegistration,
  authoritativeCloseJob,
  createWebRtcClaimRunner,
  createWebRtcAgentSession,
  signalingUrl,
  startWebRtcAssistance
};
