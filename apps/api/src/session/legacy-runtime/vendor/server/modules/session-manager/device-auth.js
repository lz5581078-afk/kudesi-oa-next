const crypto = require('crypto');

const PAIRING_TTL_MS = 10 * 60_000;
const DEVICE_ONLINE_WINDOW_MS = 45_000;
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function publicError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function hashAgentSecret(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function createRandomText(length, alphabet = PAIRING_ALPHABET) {
  let result = '';
  while (result.length < length) {
    const value = crypto.randomBytes(1)[0];
    if (value >= Math.floor(256 / alphabet.length) * alphabet.length) continue;
    result += alphabet[value % alphabet.length];
  }
  return result;
}

function createPairingCode() {
  return createRandomText(8);
}

function createAgentSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function assertRsa3072PublicKey(publicKeyPem) {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    const details = key.asymmetricKeyDetails || {};
    if (key.asymmetricKeyType !== 'rsa' || Number(details.modulusLength || 0) < 3072) {
      throw new Error('weak key');
    }
  } catch (_error) {
    throw publicError('设备公钥必须是有效的 RSA-3072 公钥');
  }
}

async function createPairing({ companyId, workspaceId, employeeId, execute, now = new Date() }) {
  const code = createPairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  await execute(
    `INSERT INTO session_device_pairings
      (id, company_id, workspace_id, employee_id, code_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), companyId, workspaceId, employeeId, hashAgentSecret(code), expiresAt]
  );
  return { code, expiresAt };
}

function normalizeDevice(device) {
  const normalized = {
    name: String(device?.name || '').trim().slice(0, 80),
    hostname: String(device?.hostname || '').trim().slice(0, 190),
    platform: String(device?.platform || '').trim().slice(0, 40),
    arch: String(device?.arch || '').trim().slice(0, 40),
    agentVersion: String(device?.agentVersion || '').trim().slice(0, 40),
    publicKeyPem: String(device?.publicKeyPem || '').trim()
  };
  if (!normalized.name || !normalized.hostname || !normalized.platform || !normalized.arch || !normalized.agentVersion) {
    throw publicError('设备注册信息不完整');
  }
  assertRsa3072PublicKey(normalized.publicKeyPem);
  return normalized;
}

async function registerDevice({ pairingCode, device, withTransaction, now = new Date() }) {
  const code = String(pairingCode || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(code)) throw publicError('绑定码无效、已过期或已使用');
  const normalized = normalizeDevice(device);

  return withTransaction(async (tx) => {
    const [pairing] = await tx.query(
      `SELECT id, company_id, workspace_id, employee_id
       FROM session_device_pairings
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
       LIMIT 1 FOR UPDATE`,
      [hashAgentSecret(code), now]
    );
    if (!pairing) throw publicError('绑定码无效、已过期或已使用');

    const deviceId = crypto.randomUUID();
    const secret = createAgentSecret();
    const deviceCode = createRandomText(12);
    await tx.execute(
      `INSERT INTO session_devices
        (id, company_id, workspace_id, registered_by_employee_id, device_code, name, hostname,
         platform, arch, agent_version, public_key_pem, token_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        deviceId,
        pairing.company_id,
        pairing.workspace_id,
        pairing.employee_id,
        deviceCode,
        normalized.name,
        normalized.hostname,
        normalized.platform,
        normalized.arch,
        normalized.agentVersion,
        normalized.publicKeyPem,
        hashAgentSecret(secret)
      ]
    );
    const consumed = await tx.execute(
      'UPDATE session_device_pairings SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL',
      [pairing.id]
    );
    if (Number(consumed.affectedRows) !== 1) throw publicError('绑定码无效、已过期或已使用');
    return {
      deviceId,
      deviceCode,
      deviceToken: `${deviceId}.${secret}`,
      companyId: Number(pairing.company_id),
      workspaceId: Number(pairing.workspace_id)
    };
  });
}

function parseAgentAuthorization(authorization) {
  const match = /^Bearer\s+([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,})$/i.exec(String(authorization || ''));
  return match ? { deviceId: match[1], secret: match[2] } : null;
}

async function authenticateAgent({ authorization, query }) {
  const credentials = parseAgentAuthorization(authorization);
  if (!credentials) return null;
  const [device] = await query(
    `SELECT id, company_id, workspace_id, registered_by_employee_id, device_code, name,
            agent_version, public_key_pem, token_hash, last_seen_at
     FROM session_devices
     WHERE id = ? AND status = 'active'
     LIMIT 1`,
    [credentials.deviceId]
  );
  if (!device) return null;
  const expected = Buffer.from(String(device.token_hash || ''), 'hex');
  const actual = Buffer.from(hashAgentSecret(credentials.secret), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return {
    id: device.id,
    companyId: Number(device.company_id),
    workspaceId: Number(device.workspace_id),
    employeeId: Number(device.registered_by_employee_id),
    deviceCode: device.device_code,
    name: device.name,
    agentVersion: device.agent_version,
    publicKeyPem: device.public_key_pem,
    lastSeenAt: device.last_seen_at || null
  };
}

async function revokeDevice({ companyId, workspaceId, deviceId, execute }) {
  const result = await execute(
    "UPDATE session_devices SET status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ? AND workspace_id = ? AND status = 'active'",
    [deviceId, companyId, workspaceId]
  );
  return Number(result.affectedRows) === 1;
}

async function restoreDevice({ companyId, workspaceId, deviceId, execute }) {
  const result = await execute(
    "UPDATE session_devices SET status = 'active', last_seen_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ? AND workspace_id = ? AND status = 'revoked'",
    [deviceId, companyId, workspaceId]
  );
  return Number(result.affectedRows) === 1;
}

async function deleteDevice({ companyId, workspaceId, deviceId, execute }) {
  const result = await execute(
    "UPDATE session_devices SET status = 'deleted', last_seen_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ? AND workspace_id = ? AND status = 'revoked'",
    [deviceId, companyId, workspaceId]
  );
  return Number(result.affectedRows) === 1;
}

async function updateDeviceRemark({ companyId, workspaceId, deviceId, remark, query, execute }) {
  const normalizedRemark = String(remark ?? '').trim();
  if (normalizedRemark.length > 80) {
    const error = new Error('电脑备注不能超过 80 个字符');
    error.statusCode = 400;
    error.publicMessage = error.message;
    throw error;
  }
  const [device] = await query(
    `SELECT id, name FROM session_devices
     WHERE id = ? AND company_id = ? AND workspace_id = ? AND status <> 'deleted' LIMIT 1`,
    [deviceId, companyId, workspaceId]
  );
  if (!device) return null;
  await execute(
    `UPDATE session_devices SET remark = NULLIF(?, ''), updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ? AND workspace_id = ? AND status <> 'deleted'`,
    [normalizedRemark, deviceId, companyId, workspaceId]
  );
  return { id: device.id, name: device.name, remark: normalizedRemark };
}

module.exports = {
  DEVICE_ONLINE_WINDOW_MS,
  PAIRING_TTL_MS,
  assertRsa3072PublicKey,
  authenticateAgent,
  createAgentSecret,
  createPairing,
  createPairingCode,
  deleteDevice,
  hashAgentSecret,
  parseAgentAuthorization,
  registerDevice,
  restoreDevice,
  revokeDevice,
  updateDeviceRemark
};
