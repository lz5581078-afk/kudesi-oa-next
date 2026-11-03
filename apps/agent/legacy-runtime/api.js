const { saveConfig, shopProfileKey, validateProfileNamespace } = require('./config');
const AGENT_API_TIMEOUT_MS = 25_000;

class AgentApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AgentApiError';
    this.status = status;
  }
}

function retryableAgentApiError(error) {
  if (error instanceof AgentApiError) {
    return [408, 425, 429].includes(error.status) || error.status >= 500;
  }
  return true;
}

async function agentApi(config, pathname, init = {}) {
  const target = new URL(pathname, config.serverUrl);
  const heartbeat = target.pathname === '/api/session-manager/agent/heartbeat';
  if (!heartbeat) {
    try { shopProfileKey(config, 1); }
    catch { throw new AgentApiError('助手缺少有效的登录环境用途，请重新绑定电脑', 403); }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('助手网络请求超时')), AGENT_API_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.deviceToken}`,
        'content-type': 'application/json',
        ...(init.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new AgentApiError(body.message || body.error || `服务器请求失败（${response.status}）`, response.status);
    if (heartbeat) {
      try {
        const profileNamespace = validateProfileNamespace(body.profileNamespace);
        // A live origin/namespace change must never reuse a browser cached by raw
        // store ID. The unchanged main loop stops on 403 and preserves profiles.
        if (config.profileNamespace !== undefined) {
          if (validateProfileNamespace(config.profileNamespace) !== profileNamespace) throw new Error('namespace changed');
        } else {
          const next = { ...config, profileNamespace };
          shopProfileKey(next, 1);
          // Persist first. A failed write must leave memory unscoped, so no
          // subsequent task poll can proceed with an uncommitted identity.
          await saveConfig(next);
          Object.assign(config, { profileNamespace });
        }
      } catch {
        throw new AgentApiError('登录环境用途未确认或无法保存，请停止并重新绑定电脑', 403);
      }
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { AGENT_API_TIMEOUT_MS, AgentApiError, agentApi, retryableAgentApiError };
