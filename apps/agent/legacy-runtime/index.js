const { AgentApiError, agentApi } = require('./api');
const { clearDeviceAuthorization, loadConfig } = require('./config');
const { runOpenShop } = require('./open-shop');
const { writeAgentStatus, writeLiveness } = require('./status');
const { ensureChromeForTestingRuntime } = require('./chrome-for-testing');
const { activeBrowserSessionIds, startRemoteAssistance } = require('./remote-assistance');
const { startWebRtcAssistance } = require('./webrtc-assistance');
const { checkLatestRelease, claimAndApplyUpdate } = require('./online-update');

const HEARTBEAT_INTERVAL_MS = 5_000;
const SESSION_SYNC_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;
const LOOP_TICK_MS = 1_000;
const UPDATE_POLL_INTERVAL_MS = 10_000;
const VERSION_CHECK_INTERVAL_MS = 5 * 60_000;

function createForegroundRequestRunner(work) {
  let running = false;
  let currentRequestId = null;
  let controller = null;
  return {
    get running() { return running; },
    get currentRequestId() { return currentRequestId; },
    async run(request) {
      if (running) return false;
      running = true;
      currentRequestId = String(request.id);
      controller = new AbortController();
      try {
        await work(request, controller.signal);
        return true;
      } finally {
        running = false;
        currentRequestId = null;
        controller = null;
      }
    },
    stopCurrentJob(requestId) {
      if (!controller || (requestId && String(requestId) !== currentRequestId)) return false;
      controller.abort(new Error('服务器已取消当前任务'));
      return true;
    }
  };
}

async function syncSessionsBestEffort(config, overrides = {}) {
  return { ok: true, errors: [], mode: 'local_only', disabled: true };
}

async function runAgent() {
  const config = await loadConfig();
  if (!config?.deviceToken) throw new Error('助手尚未绑定，请先使用 OA 绑定码完成电脑绑定');
  try {
    await writeAgentStatus({ state: 'installing_components', currentStep: 'checking_browser', progress: 5, message: '正在检查专用 Chrome' });
    await ensureChromeForTestingRuntime();
  } catch (error) {
    await writeAgentStatus({ state: 'error', currentStep: 'browser_component_failed', progress: 100, message: error.message });
  }
  const runner = createForegroundRequestRunner((request, signal) => runOpenShop(config, request, { signal }));
  const stopRemoteAssistance = startWebRtcAssistance(config, {
    canRecoverBrowser: () => !runner.running,
    onStatus: (status, force = false) => writeAgentStatus(status, { force })
  });
  const stopJpegFallback = startRemoteAssistance(config);
  let lastHeartbeatAt = 0;
  let lastOpenPollAt = 0;
  let lastUpdatePollAt = 0;
  let lastVersionCheckAt = 0;
  let stopping = false;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    stopping = true;
    await stopRemoteAssistance();
    await stopJpegFallback();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopping) {
      try {
        const now = Date.now();
        if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
          const heartbeat = await agentApi(config, '/api/session-manager/agent/heartbeat', {
            method: 'POST',
            body: JSON.stringify({
              agentVersion: require('./config').AGENT_VERSION,
              currentStep: runner.running ? 'opening_shop' : 'idle',
              currentRequestId: runner.currentRequestId,
              activeBrowserSessionIds: activeBrowserSessionIds()
            })
          });
          if (heartbeat.authorized === false) {
            await clearDeviceAuthorization(config);
            await writeAgentStatus({ state: 'revoked', currentStep: 'authorization_revoked', progress: 0, message: '电脑授权已撤销，请重新绑定' }, { force: true });
            break;
          }
          if (heartbeat.stopCurrentJob) runner.stopCurrentJob(heartbeat.currentRequestId);
          await writeLiveness();
          if (!runner.running && activeBrowserSessionIds().length === 0) {
            await writeAgentStatus({ state: 'idle', currentStep: 'idle', progress: 0, lastConnectedAt: new Date().toISOString() });
          }
          lastHeartbeatAt = now;
        }
        if (now - lastVersionCheckAt >= VERSION_CHECK_INTERVAL_MS) {
          await checkLatestRelease(config).catch(() => undefined);
          lastVersionCheckAt = now;
        }
        if (!runner.running && now - lastOpenPollAt >= POLL_INTERVAL_MS) {
          const { request } = await agentApi(config, '/api/session-manager/agent/open-requests');
          lastOpenPollAt = now;
          if (request) void runner.run(request).catch(() => undefined);
        }
        if (!runner.running && now - lastUpdatePollAt >= UPDATE_POLL_INTERVAL_MS) {
          await claimAndApplyUpdate(config, { browserSessionIds: activeBrowserSessionIds() });
          lastUpdatePollAt = now;
        }
      } catch (error) {
        if (error instanceof AgentApiError && [401, 403].includes(error.status)) {
          await clearDeviceAuthorization(config);
          await writeAgentStatus({ state: 'revoked', currentStep: 'authorization_revoked', progress: 0, message: '电脑授权已撤销，请重新绑定' }, { force: true });
          break;
        }
        await writeAgentStatus({ state: 'offline', currentStep: 'retrying', progress: 0, message: '暂时无法连接 OA，助手将自动重试' });
      }
      await new Promise((resolve) => setTimeout(resolve, LOOP_TICK_MS));
    }
  } finally {
    await stop();
  }
}

if (require.main === module) {
  runAgent().catch((error) => {
    console.error(`[agent] ${error.message || '助手运行失败'}`);
    process.exitCode = 1;
  });
}

module.exports = {
  HEARTBEAT_INTERVAL_MS,
  LOOP_TICK_MS,
  POLL_INTERVAL_MS,
  SESSION_SYNC_INTERVAL_MS,
  UPDATE_POLL_INTERVAL_MS,
  VERSION_CHECK_INTERVAL_MS,
  createForegroundRequestRunner,
  runAgent,
  syncSessionsBestEffort
};
