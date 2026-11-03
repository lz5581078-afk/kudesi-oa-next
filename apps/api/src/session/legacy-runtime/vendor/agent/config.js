const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const AGENT_VERSION = require('./version.json').version;

function agentDataDir() {
  if (process.env.SESSION_MANAGER_AGENT_DATA_DIR) return path.resolve(process.env.SESSION_MANAGER_AGENT_DATA_DIR);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'KudesiSessionManagerAgent');
  }
  return path.join(os.homedir(), '.kudesi-session-manager-agent');
}

function agentConfigPath() {
  return path.join(agentDataDir(), 'agent.json');
}

async function loadConfig() {
  try {
    const config = JSON.parse(await fs.readFile(agentConfigPath(), 'utf8'));
    return { ...config, shops: config.shops || {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveConfig(config) {
  await fs.mkdir(agentDataDir(), { recursive: true, mode: 0o700 });
  const target = agentConfigPath();
  const temporary = `${target}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    let lastError;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      try {
        await fs.rename(temporary, target);
        return;
      } catch (error) {
        lastError = error;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
      }
    }
    throw lastError;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function clearDeviceAuthorization(config) {
  const {
    deviceId: _deviceId,
    deviceCode: _deviceCode,
    deviceToken: _deviceToken,
    ...preserved
  } = config || {};
  await saveConfig({
    ...preserved,
    shops: preserved.shops || {},
    revokedAt: new Date().toISOString()
  });
}

function createDeviceKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
}

function ensureShopProfile(config, storeId, storeName, platformCode = 'pdd') {
  const key = String(storeId);
  const existing = config.shops[key];
  if (existing) {
    const existingPlatform = existing.platformCode || 'pdd';
    if (existingPlatform !== platformCode) {
      throw new Error('店铺平台已变更，需要重新确认 Profile');
    }
    existing.storeName = storeName || existing.storeName;
    existing.platformCode = existingPlatform;
    return existing;
  }
  const profile = {
    storeId: key,
    storeName,
    platformCode,
    localProfileId: crypto.randomUUID(),
    pendingSessionVersion: 0,
    appliedSessionVersion: 0,
    pendingSessionHash: '',
    localStateHash: '',
    localLoginStatus: 'pending'
  };
  config.shops[key] = profile;
  return profile;
}

function profileDir(profile) {
  return path.join(agentDataDir(), 'profiles', profile.platformCode || 'pdd', profile.localProfileId);
}

async function removeLegacySyncedState(profile) {
  const root = path.resolve(profileDir(profile));
  const target = path.resolve(root, 'kudesi-synced-auth.json');
  if (path.dirname(target) !== root) return { removed: false, reason: 'outside_profile' };
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: false, reason: 'missing' };
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) return { removed: false, reason: 'unexpected_type' };
  await fs.unlink(target);
  return { removed: true, reason: 'legacy_file' };
}

function managedWindowPath() {
  return path.join(agentDataDir(), 'managed-window.json');
}

module.exports = {
  AGENT_VERSION,
  agentConfigPath,
  agentDataDir,
  clearDeviceAuthorization,
  createDeviceKeyPair,
  ensureShopProfile,
  loadConfig,
  managedWindowPath,
  profileDir,
  removeLegacySyncedState,
  saveConfig,
};
