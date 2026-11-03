const { agentApi } = require('./api');
const { saveConfig, shopProfileKey } = require('./config');

const LOCAL_ONLY_RESULT = Object.freeze({ mode: 'local_only', disabled: true });

async function updateBinding(config, storeId, localProfileId, input, options = {}) {
  const api = options.api || agentApi;
  return api(config, '/api/session-manager/agent/bindings', {
    method: 'POST',
    body: JSON.stringify({
      storeId,
      localProfileId,
      platformCode: config.shops[shopProfileKey(config, storeId)]?.platformCode,
      ...input
    })
  });
}

async function markLocalLoginStatus(config, storeId, localProfileId, loginStatus, options = {}) {
  const profile = config.shops?.[shopProfileKey(config, storeId)];
  if (profile) {
    profile.localLoginStatus = loginStatus;
    await (options.save || saveConfig)(config);
  }
  return updateBinding(config, storeId, localProfileId || profile?.localProfileId, {
    loginStatus,
    sessionVersion: 0,
    appliedSessionVersion: 0,
    localStateHash: '',
    lastError: options.lastError || '',
    verification: options.verification
  }, options);
}

async function cloudSessionDisabled() {
  return { ...LOCAL_ONLY_RESULT };
}

const publishSessionState = cloudSessionDisabled;
const rememberLocalSessionState = cloudSessionDisabled;
const syncSessionRecipients = cloudSessionDisabled;
const syncPendingSession = cloudSessionDisabled;
const syncPendingSessions = cloudSessionDisabled;

module.exports = {
  LOCAL_ONLY_RESULT,
  markLocalLoginStatus,
  publishSessionState,
  rememberLocalSessionState,
  syncSessionRecipients,
  syncPendingSession,
  syncPendingSessions,
  updateBinding
};
