const crypto = require('crypto');
const { isAllowedPlatformUrl, normalizePlatform } = require('./platform-registry');

const AUTHENTICATION_VERIFICATION_METHOD = 'platform_page_stable_v2';

function publicError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function normalizeAuthenticationEvidence(input, platformCode, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw publicError('有效登录态必须包含平台验证证据');
  }
  const method = String(input.method || '').trim();
  const evidencePlatformCode = String(input.platformCode || '').trim();
  const url = String(input.url || '').trim().slice(0, 1_000);
  const checkedAt = new Date(input.checkedAt);
  const checks = Math.floor(Number(input.checks || 0));
  const signals = [...new Set((Array.isArray(input.signals) ? input.signals : [])
    .map((signal) => String(signal || '').trim().slice(0, 120))
    .filter(Boolean))].slice(0, 12);
  const ageMs = Math.abs(now.getTime() - checkedAt.getTime());
  if (
    method !== AUTHENTICATION_VERIFICATION_METHOD
    || evidencePlatformCode !== platformCode
    || !isAllowedPlatformUrl(platformCode, url)
    || !Number.isFinite(checkedAt.getTime())
    || ageMs > 30 * 60_000
    || checks < 2
    || signals.length < 2
  ) {
    throw publicError('登录态验证证据无效或已经过期');
  }
  return { method, platformCode, url, checkedAt: checkedAt.toISOString(), checks, signals };
}

async function reportBinding({ device, binding, query, execute }) {
  const storeId = Number(binding?.storeId);
  const localProfileId = String(binding?.localProfileId || '').trim();
  const loginStatus = String(binding?.loginStatus || '').trim();
  const platformCode = String(binding?.platformCode || '').trim();
  const localStateHash = String(binding?.localStateHash || '').trim().toLowerCase();
  const sessionVersion = Math.max(0, Math.floor(Number(binding?.sessionVersion || 0)));
  const appliedSessionVersion = Math.max(0, Math.floor(Number(binding?.appliedSessionVersion || 0)));
  if (!Number.isInteger(storeId) || storeId <= 0 || !/^[0-9a-f-]{36}$/i.test(localProfileId)) {
    throw publicError('店铺绑定信息无效');
  }
  if (!['pending', 'synced', 'valid', 'expired', 'error'].includes(loginStatus)) {
    throw publicError('店铺登录状态无效');
  }
  if (localStateHash && !/^[0-9a-f]{64}$/.test(localStateHash)) {
    throw publicError('本机登录态校验值无效');
  }
  if (!Number.isFinite(sessionVersion) || !Number.isFinite(appliedSessionVersion)) {
    throw publicError('登录态版本无效');
  }
  const [store] = await query(
    `SELECT store.id, store.platform FROM stores store
     JOIN session_managed_shops managed
       ON managed.store_id = store.id AND managed.company_id = store.company_id AND managed.workspace_id = ? AND managed.status = 'active'
     WHERE store.id = ? AND store.company_id = ? LIMIT 1`,
    [device.workspaceId, storeId, device.companyId]
  );
  if (!store) throw publicError('店铺尚未加入登录态管理或不属于当前企业', 404);
  if (normalizePlatform(store.platform) !== platformCode) throw publicError('店铺平台与本机 Profile 不匹配', 409);
  const verification = loginStatus === 'valid'
    ? normalizeAuthenticationEvidence(binding?.verification, platformCode)
    : null;
  try {
    await execute(
      `INSERT INTO session_device_shop_bindings
        (id, company_id, workspace_id, device_id, store_id, local_profile_id, login_status,
         session_version, applied_session_version, local_state_hash, authentication_evidence, last_verified_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), IF(? = 'valid', CURRENT_TIMESTAMP, NULL), ?)
       ON DUPLICATE KEY UPDATE
         local_profile_id = VALUES(local_profile_id),
         login_status = VALUES(login_status),
         session_version = GREATEST(session_version, VALUES(session_version)),
         applied_session_version = GREATEST(applied_session_version, VALUES(applied_session_version)),
         local_state_hash = COALESCE(NULLIF(VALUES(local_state_hash), ''), local_state_hash),
         authentication_evidence = IF(VALUES(login_status) = 'valid', VALUES(authentication_evidence), NULL),
         last_verified_at = IF(VALUES(login_status) = 'valid', CURRENT_TIMESTAMP, last_verified_at),
         last_error = VALUES(last_error), updated_at = CURRENT_TIMESTAMP`,
      [
        crypto.randomUUID(), device.companyId, device.workspaceId, device.id, storeId, localProfileId, loginStatus,
        sessionVersion, appliedSessionVersion, localStateHash || null, verification ? JSON.stringify(verification) : null, loginStatus,
        String(binding?.lastError || '').trim().slice(0, 1000) || null
      ]
    );
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') throw publicError('该浏览器 Profile 已绑定其他店铺');
    throw error;
  }
  return { ok: true };
}

module.exports = {
  AUTHENTICATION_VERIFICATION_METHOD,
  normalizeAuthenticationEvidence,
  reportBinding
};
