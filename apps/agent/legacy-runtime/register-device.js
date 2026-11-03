const os = require('os');
const { AGENT_VERSION, createDeviceKeyPair, loadConfig, saveConfig, validateProfileNamespace } = require('./config');

async function registerDevice(options = {}) {
  const serverUrl = String(options.serverUrl || process.env.SESSION_MANAGER_SERVER_URL || 'https://lc.kudesi.com/').trim().replace(/\/+$/, '');
  const pairingCode = String(options.pairingCode || process.env.SESSION_MANAGER_PAIRING_CODE || '').trim().toUpperCase();
  if (!/^https:\/\//i.test(serverUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(serverUrl)) throw new Error('OA 地址必须使用 HTTPS（本机开发地址除外）');
  if (!/^[A-Z0-9]{8}$/.test(pairingCode)) throw new Error('绑定码格式不正确');
  const existing = await loadConfig();
  const keys = existing?.privateKeyPem && existing?.publicKeyPem
    ? { privateKey: existing.privateKeyPem, publicKey: existing.publicKeyPem }
    : createDeviceKeyPair();
  const response = await fetch(`${serverUrl}/api/session-manager/agent/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingCode,
      name: options.name || os.hostname(),
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      agentVersion: AGENT_VERSION,
      publicKeyPem: keys.publicKey
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || '电脑绑定失败');
  const profileNamespace = validateProfileNamespace(body.profileNamespace);
  await saveConfig({
    serverUrl,
    profileNamespace,
    deviceId: body.deviceId,
    deviceCode: body.deviceCode,
    deviceToken: body.deviceToken,
    name: options.name || os.hostname(),
    publicKeyPem: keys.publicKey,
    privateKeyPem: keys.privateKey,
    shops: existing?.shops || {}
  });
  return { deviceId: body.deviceId, deviceCode: body.deviceCode };
}

if (require.main === module) {
  registerDevice().then(() => console.log('电脑绑定成功，助手将使用独立店铺 Profile。')).catch((error) => {
    console.error(error.message || '电脑绑定失败');
    process.exitCode = 1;
  });
}

module.exports = { registerDevice };
