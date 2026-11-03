const crypto = require('crypto');

const DEFAULT_TICKET_TTL_MS = 30_000;
const DEFAULT_TURN_TTL_SECONDS = 10 * 60;
const ROLES = new Set(['viewer', 'agent']);

function publicError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function normalizeBinding(binding = {}) {
  const normalized = {
    companyId: Number(binding.companyId),
    userId: Number(binding.userId),
    shopId: Number(binding.shopId),
    deviceId: String(binding.deviceId || ''),
    browserSessionId: String(binding.browserSessionId || ''),
    remoteSessionId: String(binding.remoteSessionId || '')
  };
  if (!Number.isInteger(normalized.companyId) || normalized.companyId <= 0 ||
      !Number.isInteger(normalized.userId) || normalized.userId <= 0 ||
      !Number.isInteger(normalized.shopId) || normalized.shopId <= 0 ||
      !/^[0-9a-f-]{36}$/i.test(normalized.deviceId) ||
      !/^[0-9a-f-]{36}$/i.test(normalized.browserSessionId) ||
      !/^[0-9a-f-]{36}$/i.test(normalized.remoteSessionId)) {
    throw publicError('WebRTC会话归属无效');
  }
  return Object.freeze(normalized);
}

function ticketDigest(ticket) {
  return crypto.createHash('sha256').update(String(ticket || ''), 'utf8').digest('hex');
}

function createWebRtcTicketStore(options = {}) {
  const now = options.now || Date.now;
  const ttlMs = Number(options.ttlMs || DEFAULT_TICKET_TTL_MS);
  if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > 60_000) {
    throw new Error('WebRTC ticket TTL must be between 1 and 60 seconds');
  }
  const entries = new Map();

  return Object.freeze({
    issue({ role, binding }) {
      if (!ROLES.has(role)) throw publicError('WebRTC票据角色无效');
      const ticket = crypto.randomBytes(32).toString('base64url');
      const expiresAtMs = now() + ttlMs;
      entries.set(ticketDigest(ticket), {
        role,
        binding: normalizeBinding(binding),
        expiresAtMs
      });
      return { ticket, expiresAt: new Date(expiresAtMs).toISOString() };
    },

    consume(ticket, expectedRole) {
      const digest = ticketDigest(ticket);
      const entry = entries.get(digest);
      if (!entry) throw publicError('WebRTC票据无效或已使用', 401);
      entries.delete(digest);
      if (entry.role !== expectedRole) throw publicError('WebRTC票据角色不匹配', 403);
      if (entry.expiresAtMs <= now()) throw publicError('WebRTC票据已过期', 401);
      return { role: entry.role, binding: entry.binding };
    },

    toJSON() {
      return { activeTicketCount: entries.size };
    }
  });
}

const defaultWebRtcTicketStore = createWebRtcTicketStore();

function createIceServerCredentials(options = {}) {
  const now = options.now || Date.now;
  const stunUrls = normalizeUrls(options.stunUrls);
  const turnUrls = normalizeUrls(options.turnUrls);
  const turnSharedSecret = String(options.turnSharedSecret || '');
  const ttlSeconds = Math.max(60, Math.min(3600, Number(options.ttlSeconds || DEFAULT_TURN_TTL_SECONDS)));
  if (!turnUrls.length) {
    if (stunUrls.length) return [{ urls: stunUrls }];
    throw publicError('STUN或TURN服务尚未配置', 503);
  }
  if (turnSharedSecret.length < 8) throw publicError('TURN共享密钥尚未配置', 503);
  const binding = normalizeBinding(options.binding);
  const expiresAt = Math.floor(now() / 1000) + ttlSeconds;
  const bindingDigest = crypto.createHash('sha256')
    .update(JSON.stringify(binding), 'utf8')
    .digest('hex')
    .slice(0, 24);
  const nonce = String(options.nonce || crypto.randomBytes(12).toString('base64url'))
    .replace(/[^0-9a-z_-]/gi, '')
    .slice(0, 32);
  if (nonce.length < 8) throw publicError('TURN凭据随机数无效');
  const username = `${expiresAt}:${bindingDigest}:${nonce}`;
  const credential = crypto.createHmac('sha1', turnSharedSecret).update(username).digest('base64');
  return [
    ...(stunUrls.length ? [{ urls: stunUrls }] : []),
    { urls: turnUrls, username, credential, credentialType: 'password' }
  ];
}

function normalizeUrls(values) {
  return (Array.isArray(values) ? values : String(values || '').split(','))
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

module.exports = {
  createIceServerCredentials,
  createWebRtcTicketStore,
  defaultWebRtcTicketStore,
  normalizeBinding
};
