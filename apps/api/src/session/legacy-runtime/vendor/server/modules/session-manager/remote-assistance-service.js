const crypto = require('crypto');
const { isAllowedPlatformUrl, normalizePlatform, platformDefinition } = require('./platform-registry');

const REMOTE_COMMAND_KINDS = Object.freeze(['click', 'drag', 'scroll']);
const REMOTE_SESSION_SECONDS = 10 * 60;
const REMOTE_LIVENESS_SECONDS = 45;
const REMOTE_CLOSE_TIMEOUT_SECONDS = 60;
const MINIMUM_REMOTE_AGENT_VERSION = '0.2.5';

function publicError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function uuid(value, label) {
  const normalized = String(value || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(normalized)) throw publicError(`${label}无效`);
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) throw publicError(`${label}无效`);
  return normalized;
}

function cleanText(value, maximum) {
  return String(value || '').trim().slice(0, maximum);
}

function versionAtLeast(actual, minimum) {
  const left = String(actual || '').split('.').map((value) => Number(value) || 0);
  const right = String(minimum || '').split('.').map((value) => Number(value) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) > (right[index] || 0)) return true;
    if ((left[index] || 0) < (right[index] || 0)) return false;
  }
  return true;
}

function isAllowedMerchantUrl(value, platformCode = 'pdd') {
  return isAllowedPlatformUrl(platformCode, value);
}

function normalizePoint(value, fallbackTime = 0) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const t = Math.round(Number(value.t) || fallbackTime);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y, t: Math.max(0, Math.min(8000, t)) };
}

function normalizeRemoteCommand(body = {}) {
  const kind = cleanText(body.kind, 20);
  if (!REMOTE_COMMAND_KINDS.includes(kind)) throw publicError('不支持的远程操作');
  if (kind === 'scroll') {
    const raw = Math.round(Number(body.deltaY) || 0);
    const deltaY = Math.max(-2000, Math.min(2000, raw));
    if (!deltaY) throw publicError('滚动距离无效');
    return { kind, payload: { deltaY } };
  }
  if (kind === 'click') {
    const point = normalizePoint(body.point);
    if (!point) throw publicError('点击位置无效');
    return { kind, payload: { point } };
  }
  const phase = cleanText(body.phase, 20);
  if (['start', 'move', 'end'].includes(phase)) {
    const point = normalizePoint(body.point);
    if (!point) throw publicError('实时拖动位置无效');
    return { kind, payload: { phase, point } };
  }
  if (!Array.isArray(body.points) || body.points.length < 2 || body.points.length > 80) {
    throw publicError('拖动轨迹无效');
  }
  const points = body.points.map((point, index) => normalizePoint(point, index * 40));
  if (points.some((point) => !point)) throw publicError('拖动轨迹无效');
  let previous = 0;
  for (const point of points) {
    if (point.t < previous) point.t = previous;
    previous = point.t;
  }
  return { kind, payload: { points } };
}

async function createRemoteSession({ companyId, workspaceId, userId, browserSessionId, deviceId, shopId, withTransaction }) {
  const browserId = uuid(browserSessionId, '浏览器会话编号');
  const targetDeviceId = uuid(deviceId, '设备编号');
  const targetShopId = positiveInteger(shopId, '店铺编号');
  const id = crypto.randomUUID();
  let target;
  let platformCode;
  await withTransaction(async (tx) => {
    const [row] = await tx.query(
      `SELECT browser.id, browser.company_id, browser.workspace_id, browser.user_id, browser.shop_id, browser.device_id,
              browser.local_profile_id, browser.status, browser.page_url, browser.last_agent_at,
              device.status AS device_status, device.last_seen_at, device.agent_version,
              device.device_code, device.name AS device_name, store.platform AS store_platform
       FROM managed_browser_sessions browser
       JOIN session_devices device ON device.id = browser.device_id
       JOIN stores store ON store.id = browser.shop_id AND store.company_id = browser.company_id
       WHERE browser.id = ? LIMIT 1 FOR UPDATE`,
      [browserId]
    );
    if (!row) throw publicError('浏览器窗口不存在', 409);
    if (Number(row.company_id) !== Number(companyId) || Number(row.workspace_id) !== Number(workspaceId) || Number(row.user_id) !== Number(userId)) {
      throw publicError('无权远程操作这个浏览器窗口', 403);
    }
    if (row.device_id !== targetDeviceId || Number(row.shop_id) !== targetShopId) {
      throw publicError('店铺、电脑和浏览器窗口不匹配', 409);
    }
    if (row.status !== 'open') throw publicError('浏览器窗口不存在', 409);
    platformCode = normalizePlatform(row.store_platform);
    if (platformCode === 'unsupported_platform' || !isAllowedMerchantUrl(row.page_url, platformCode)) {
      throw publicError('店铺页面已离开所属平台允许的商家域名', 403);
    }
    if (row.device_status !== 'active') throw publicError('目标电脑已撤销', 409);
    if (!versionAtLeast(row.agent_version, MINIMUM_REMOTE_AGENT_VERSION)) {
      throw publicError(`请先把 Windows 助手升级到 ${MINIMUM_REMOTE_AGENT_VERSION}`, 409);
    }
    const browserAlive = row.last_agent_at && Date.now() - new Date(row.last_agent_at).getTime() <= REMOTE_LIVENESS_SECONDS * 1000;
    const deviceAlive = row.last_seen_at && Date.now() - new Date(row.last_seen_at).getTime() <= REMOTE_LIVENESS_SECONDS * 1000;
    if (!browserAlive || !deviceAlive) throw publicError('远程电脑或浏览器窗口已离线', 409);
    await tx.execute(
      `UPDATE session_remote_commands command_row
       JOIN session_remote_sessions remote ON remote.id = command_row.session_id
       SET command_row.status = 'cancelled', command_row.completed_at = CURRENT_TIMESTAMP
       WHERE remote.user_id = ? AND remote.workspace_id = ? AND remote.device_id = ?
         AND remote.browser_session_id = ?
         AND remote.status IN ('requested','connected')
         AND command_row.status IN ('queued','running')`,
      [userId, workspaceId, targetDeviceId, browserId]
    );
    await tx.execute(
      `UPDATE session_remote_sessions
       SET status = 'closed', closed_at = CURRENT_TIMESTAMP, frame_data = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND workspace_id = ? AND device_id = ? AND browser_session_id = ?
         AND status IN ('requested','connected')`,
      [userId, workspaceId, targetDeviceId, browserId]
    );
    await tx.execute(
      `INSERT INTO session_remote_sessions
        (id, company_id, workspace_id, user_id, shop_id, device_id, browser_session_id, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ${REMOTE_SESSION_SECONDS} SECOND))`,
      [id, companyId, workspaceId, userId, targetShopId, targetDeviceId, browserId]
    );
    target = row;
  });
  return {
    id,
    status: 'requested',
    expiresInSeconds: REMOTE_SESSION_SECONDS,
    browserSessionId: browserId,
    device: { id: targetDeviceId, code: target.device_code, name: target.device_name },
    shopId: targetShopId,
    platformCode,
    platformName: platformDefinition(platformCode).platformName
  };
}

async function expireRemoteSession({ id, companyId, workspaceId, userId, execute }) {
  await execute(
    `UPDATE session_remote_sessions
     SET status = 'expired', closed_at = CURRENT_TIMESTAMP, frame_data = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ? AND workspace_id = ? AND user_id = ?
       AND status IN ('requested','connected') AND expires_at <= CURRENT_TIMESTAMP`,
    [id, companyId, workspaceId, userId]
  );
}

async function timeoutRemoteBrowserClose({ id, companyId, workspaceId, userId, deviceId, execute }) {
  const target = deviceId ? 'device_id = ?' : 'id = ? AND user_id = ?';
  const values = deviceId ? [deviceId] : [id, userId];
  await execute(
    `UPDATE session_remote_sessions
     SET status = 'error', close_stage = 'close_failed',
         error_message = '等待 Windows 助手安全关闭店铺浏览器超时，浏览器可能仍在运行',
         closed_at = CURRENT_TIMESTAMP, frame_data = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE company_id = ? AND workspace_id = ? AND ${target} AND status = 'closing'
       AND COALESCE(close_requested_at, updated_at) < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${REMOTE_CLOSE_TIMEOUT_SECONDS} SECOND)`,
    [companyId, workspaceId, ...values]
  );
}

async function getRemoteSession({ companyId, workspaceId, userId, sessionId, query, execute }) {
  const id = uuid(sessionId, '远程会话编号');
  await expireRemoteSession({ id, companyId, workspaceId, userId, execute });
  await timeoutRemoteBrowserClose({ id, companyId, workspaceId, userId, execute });
  const [session] = await query(
    `SELECT remote.id, remote.status, remote.transport_mode, remote.expires_at, remote.last_agent_at,
            remote.connected_at, remote.close_stage, remote.close_requested_at,
            remote.close_completed_at, remote.frame_sequence, remote.frame_width,
            remote.frame_height, remote.frame_url,
            (remote.frame_data IS NOT NULL) AS frame_available,
            remote.error_message, remote.browser_session_id, browser.status AS browser_status,
            remote.shop_id, remote.device_id, device.device_code, device.name AS device_name
     FROM session_remote_sessions remote
     JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
     JOIN session_devices device ON device.id = remote.device_id
     WHERE remote.id = ? AND remote.company_id = ? AND remote.workspace_id = ? AND remote.user_id = ? LIMIT 1`,
    [id, companyId, workspaceId, userId]
  );
  if (!session) throw publicError('远程操作会话不存在', 404);
  return {
    id: session.id,
    status: session.status,
    transportMode: session.transport_mode,
    expiresAt: session.expires_at,
    lastAgentAt: session.last_agent_at,
    connectedAt: session.connected_at,
    closeStage: session.close_stage,
    closeRequestedAt: session.close_requested_at,
    closeCompletedAt: session.close_completed_at,
    frameSequence: Number(session.frame_sequence || 0),
    frameWidth: Number(session.frame_width || 0),
    frameHeight: Number(session.frame_height || 0),
    frameUrl: session.frame_url,
    frameAvailable: Boolean(session.frame_available),
    error: session.error_message,
    browserStatus: session.browser_status,
    browserSessionId: session.browser_session_id,
    shopId: Number(session.shop_id),
    device: { id: session.device_id, code: session.device_code, name: session.device_name }
  };
}

async function renewRemoteSession({ companyId, workspaceId, userId, sessionId, execute }) {
  const id = uuid(sessionId, '远程会话编号');
  const result = await execute(
    `UPDATE session_remote_sessions remote
     JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
     JOIN session_devices device ON device.id = remote.device_id
     SET remote.expires_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ${REMOTE_SESSION_SECONDS} SECOND),
         remote.updated_at = CURRENT_TIMESTAMP
     WHERE remote.id = ? AND remote.company_id = ? AND remote.workspace_id = ? AND remote.user_id = ?
       AND remote.status IN ('requested','connected')
       AND browser.status = 'open' AND browser.workspace_id = remote.workspace_id
       AND browser.device_id = remote.device_id AND browser.shop_id = remote.shop_id
       AND device.status = 'active' AND device.workspace_id = remote.workspace_id`,
    [id, companyId, workspaceId, userId]
  );
  if (!Number(result?.affectedRows)) throw publicError('远程操作会话已经结束，无法续期', 409);
  return { id, renewed: true, expiresInSeconds: REMOTE_SESSION_SECONDS };
}

async function requestRemoteBrowserClose({ companyId, workspaceId, userId, sessionId, withTransaction }) {
  const id = uuid(sessionId, '远程会话编号');
  let response;
  await withTransaction(async (tx) => {
    await timeoutRemoteBrowserClose({ id, companyId, workspaceId, userId, execute: tx.execute });
    const [session] = await tx.query(
      `SELECT remote.id, remote.company_id, remote.workspace_id, remote.user_id, remote.shop_id, remote.device_id,
              remote.browser_session_id, remote.status AS remote_status,
              browser.local_profile_id, browser.status AS browser_status,
              device.status AS device_status
       FROM session_remote_sessions remote
       JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
         AND browser.company_id = remote.company_id AND browser.workspace_id = remote.workspace_id
         AND browser.device_id = remote.device_id AND browser.shop_id = remote.shop_id
         AND browser.user_id = remote.user_id
       JOIN session_devices device ON device.id = remote.device_id
         AND device.company_id = remote.company_id AND device.workspace_id = remote.workspace_id
       WHERE remote.id = ? LIMIT 1 FOR UPDATE`,
      [id]
    );
    if (!session) throw publicError('远程操作会话不存在', 404);
    if (Number(session.company_id) !== Number(companyId) || Number(session.workspace_id) !== Number(workspaceId) || Number(session.user_id) !== Number(userId)) {
      throw publicError('无权关闭这个店铺浏览器', 403);
    }
    // Media can be stopped independently of the browser. Historical hosts also
    // wrote 'ended' when revoking transport; only the browser's confirmed state
    // permits an idempotent successful close response.
    if (session.browser_status === 'closed') {
      response = {
        id,
        status: 'ended',
        browserStatus: 'closed',
        browserSessionId: session.browser_session_id,
        deviceId: session.device_id,
        shopId: Number(session.shop_id)
      };
      return;
    }
    if (session.remote_status === 'closing') {
      response = {
        id,
        status: 'closing',
        browserStatus: session.browser_status,
        browserSessionId: session.browser_session_id,
        deviceId: session.device_id,
        shopId: Number(session.shop_id)
      };
      return;
    }
    if (session.device_status !== 'active') throw publicError('目标电脑已撤销，无法安全关闭浏览器', 409);
    if (!['open', 'closing'].includes(session.browser_status)) {
      throw publicError('店铺浏览器状态异常，无法确认安全关闭', 409);
    }
    if (!['requested', 'connected', 'error', 'closed', 'expired', 'ended'].includes(session.remote_status)) {
      throw publicError('远程操作会话已经结束', 409);
    }
    await tx.execute(
      `UPDATE session_remote_commands command_row
       JOIN session_remote_sessions remote ON remote.id = command_row.session_id
       SET command_row.status = 'cancelled', command_row.completed_at = CURRENT_TIMESTAMP
       WHERE remote.id = ? AND remote.company_id = ? AND remote.workspace_id = ? AND remote.user_id = ?
         AND command_row.status IN ('queued','running')`,
      [id, companyId, workspaceId, userId]
    );
    await tx.execute(
      `UPDATE managed_browser_sessions
       SET status = 'closing', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ? AND workspace_id = ? AND device_id = ? AND shop_id = ?
         AND local_profile_id = ? AND status IN ('open','closing')`,
      [session.browser_session_id, companyId, workspaceId, session.device_id, session.shop_id, session.local_profile_id]
    );
    await tx.execute(
      `UPDATE session_remote_sessions
       SET status = 'closing', close_stage = 'stopping_remote',
           close_requested_at = CURRENT_TIMESTAMP, close_completed_at = NULL,
           error_message = NULL, frame_data = NULL, frame_mime = NULL,
           frame_width = NULL, frame_height = NULL, frame_url = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ? AND workspace_id = ? AND user_id = ?`,
      [id, companyId, workspaceId, userId]
    );
    response = {
      id,
      status: 'closing',
      browserStatus: 'closing',
      browserSessionId: session.browser_session_id,
      deviceId: session.device_id,
      shopId: Number(session.shop_id)
    };
  });
  return response;
}

async function closeRemoteSession({ companyId, workspaceId, userId, sessionId, withTransaction }) {
  const id = uuid(sessionId, '远程会话编号');
  await withTransaction(async (tx) => {
    await tx.execute(
      `UPDATE session_remote_commands
       SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
       WHERE session_id = ? AND status IN ('queued','running')`,
      [id]
    );
    await tx.execute(
      `UPDATE session_remote_sessions
       SET status = 'closed', closed_at = CURRENT_TIMESTAMP, frame_data = NULL,
           frame_mime = NULL, frame_width = NULL, frame_height = NULL, frame_url = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ? AND workspace_id = ? AND user_id = ?
         AND status IN ('requested','connected')`,
      [id, companyId, workspaceId, userId]
    );
  });
  return { id, status: 'closed' };
}

async function switchRemoteTransport({ companyId, workspaceId, userId, sessionId, transportMode, withTransaction }) {
  const id = uuid(sessionId, '远程会话编号');
  if (!['webrtc', 'jpeg_fallback'].includes(transportMode)) throw publicError('远程传输模式无效');
  let response;
  await withTransaction(async (tx) => {
    const [session] = await tx.query(
      `SELECT remote.id, remote.status, remote.transport_mode, browser.status AS browser_status
       FROM session_remote_sessions remote
       JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
       WHERE remote.id = ? AND remote.company_id = ? AND remote.workspace_id = ? AND remote.user_id = ?
       LIMIT 1 FOR UPDATE`,
      [id, companyId, workspaceId, userId]
    );
    if (!session) throw publicError('远程操作会话不存在', 404);
    if (session.browser_status !== 'open' || !['requested', 'connected', 'error'].includes(session.status)) {
      throw publicError('当前远程会话不能切换传输模式', 409);
    }
    await tx.execute(
      `UPDATE session_remote_commands
       SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
       WHERE session_id = ? AND status IN ('queued','running')`,
      [id]
    );
    await tx.execute(
      `UPDATE session_remote_sessions
       SET transport_mode = ?, status = 'requested', error_message = NULL,
           frame_data = NULL, frame_mime = NULL, frame_width = NULL,
           frame_height = NULL, frame_url = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ? AND workspace_id = ? AND user_id = ?`,
      [transportMode, id, companyId, workspaceId, userId]
    );
    response = { id, status: 'requested', transportMode };
  });
  return response;
}

async function disconnectRemoteTransport({ companyId, workspaceId, userId, sessionId, execute }) {
  const id = uuid(sessionId, '远程会话编号');
  await execute(
    `UPDATE session_remote_sessions
     SET status = 'requested', error_message = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ? AND workspace_id = ? AND user_id = ?
       AND transport_mode = 'webrtc' AND status = 'connected'`,
    [id, companyId, workspaceId, userId]
  );
  return { id, disconnected: true };
}

const requestJpegFallback = (options) => switchRemoteTransport({
  ...options,
  transportMode: 'jpeg_fallback'
});

const requestWebRtcRecovery = (options) => switchRemoteTransport({
  ...options,
  transportMode: 'webrtc'
});

async function queueRemoteCommand({ companyId, workspaceId, userId, sessionId, body, query, execute }) {
  const id = uuid(sessionId, '远程会话编号');
  const command = normalizeRemoteCommand(body);
  const [session] = await query(
    `SELECT remote.id
     FROM session_remote_sessions remote
     JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
     JOIN session_devices device ON device.id = remote.device_id
     WHERE remote.id = ? AND remote.company_id = ? AND remote.workspace_id = ? AND remote.user_id = ?
       AND remote.status = 'connected' AND remote.transport_mode = 'webrtc'
       AND remote.expires_at > CURRENT_TIMESTAMP
       AND browser.status = 'open' AND browser.device_id = remote.device_id
       AND browser.shop_id = remote.shop_id AND device.status = 'active'
     LIMIT 1`,
    [id, companyId, workspaceId, userId]
  );
  if (!session) throw publicError('远程操作尚未连接或已经结束', 409);
  const result = await execute(
    `INSERT INTO session_remote_commands (session_id, kind, payload)
     VALUES (?, ?, ?)`,
    [id, command.kind, JSON.stringify(command.payload)]
  );
  return { id: Number(result.insertId || 0), queued: true, kind: command.kind };
}

async function getRemoteCommand({ companyId, workspaceId, userId, sessionId, commandId, query }) {
  const remoteId = uuid(sessionId, '远程会话编号');
  const id = positiveInteger(commandId, '远程操作编号');
  const [command] = await query(
    `SELECT command_row.id, command_row.kind, command_row.status, command_row.error_message,
            command_row.created_at, command_row.claimed_at, command_row.completed_at
     FROM session_remote_commands command_row
     JOIN session_remote_sessions remote ON remote.id = command_row.session_id
     WHERE command_row.id = ? AND remote.id = ? AND remote.company_id = ? AND remote.workspace_id = ? AND remote.user_id = ?
     LIMIT 1`,
    [id, remoteId, companyId, workspaceId, userId]
  );
  if (!command) throw publicError('远程操作不存在', 404);
  return {
    id: Number(command.id),
    kind: command.kind,
    status: command.status,
    error: command.error_message || '',
    createdAt: command.created_at,
    claimedAt: command.claimed_at,
    completedAt: command.completed_at
  };
}

async function claimRemoteWork({ device, withTransaction, includeCommands = true }) {
  let response = { session: null, commands: [] };
  await withTransaction(async (tx) => {
    await tx.execute(
      `UPDATE session_remote_sessions
       SET status = 'expired', closed_at = CURRENT_TIMESTAMP, frame_data = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE device_id = ? AND workspace_id = ? AND status IN ('requested','connected')
         AND expires_at <= CURRENT_TIMESTAMP`,
      [device.id, device.workspaceId]
    );
    const [session] = await tx.query(
      `SELECT remote.id, remote.browser_session_id, remote.shop_id, remote.device_id,
              remote.status, remote.expires_at, browser.local_profile_id, store.platform AS store_platform
       FROM session_remote_sessions remote
       JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
       JOIN stores store ON store.id = remote.shop_id AND store.company_id = remote.company_id
       WHERE remote.device_id = ? AND remote.company_id = ? AND remote.workspace_id = ?
         AND remote.status IN ('requested','connected') AND remote.transport_mode = 'jpeg_fallback'
         AND remote.expires_at > CURRENT_TIMESTAMP
         AND browser.status = 'open' AND browser.device_id = remote.device_id
         AND browser.shop_id = remote.shop_id AND browser.company_id = remote.company_id AND browser.workspace_id = remote.workspace_id
       ORDER BY remote.created_at DESC LIMIT 1 FOR UPDATE`,
      [device.id, device.companyId, device.workspaceId]
    );
    if (!session) return;
    const commands = includeCommands ? await tx.query(
      `SELECT id, kind, payload FROM session_remote_commands
       WHERE session_id = ? AND status = 'queued'
       ORDER BY id LIMIT 10 FOR UPDATE`,
      [session.id]
    ) : [];
    if (commands.length) {
      const placeholders = commands.map(() => '?').join(',');
      await tx.execute(
        `UPDATE session_remote_commands
         SET status = 'running', claimed_at = CURRENT_TIMESTAMP
         WHERE id IN (${placeholders}) AND status = 'queued'`,
        commands.map((command) => command.id)
      );
    }
    await tx.execute(
      `UPDATE session_remote_sessions SET last_agent_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [session.id]
    );
    response = {
      session: {
        id: session.id,
        browserSessionId: session.browser_session_id,
        shopId: Number(session.shop_id),
        deviceId: session.device_id,
        localProfileId: session.local_profile_id,
        status: session.status,
        expiresAt: session.expires_at,
        platformCode: normalizePlatform(session.store_platform)
      },
      commands: commands.map((command) => ({
        id: Number(command.id),
        kind: command.kind,
        payload: typeof command.payload === 'string' ? JSON.parse(command.payload) : command.payload
      }))
    };
  });
  return response;
}

async function claimWebRtcWork({ device, withTransaction }) {
  let response = { sessions: [], closeJobs: [], commands: [] };
  await withTransaction(async (tx) => {
    await timeoutRemoteBrowserClose({
      companyId: device.companyId, workspaceId: device.workspaceId, deviceId: device.id, execute: tx.execute
    });
    await tx.execute(
      `UPDATE session_remote_sessions
       SET status = 'expired', closed_at = CURRENT_TIMESTAMP, frame_data = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE device_id = ? AND workspace_id = ? AND status IN ('requested','connected')
         AND expires_at <= CURRENT_TIMESTAMP`,
      [device.id, device.workspaceId]
    );
    const sessions = await tx.query(
      `SELECT remote.id, remote.browser_session_id, remote.shop_id, remote.device_id,
              remote.status, remote.expires_at, browser.local_profile_id, store.platform AS store_platform
       FROM session_remote_sessions remote
       JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
       JOIN stores store ON store.id = remote.shop_id AND store.company_id = remote.company_id
       WHERE remote.device_id = ? AND remote.company_id = ? AND remote.workspace_id = ?
         AND remote.status IN ('requested','connected') AND remote.transport_mode = 'webrtc'
         AND remote.expires_at > CURRENT_TIMESTAMP
         AND browser.status = 'open' AND browser.device_id = remote.device_id
         AND browser.shop_id = remote.shop_id AND browser.company_id = remote.company_id AND browser.workspace_id = remote.workspace_id
       ORDER BY remote.created_at`,
      [device.id, device.companyId, device.workspaceId]
    );
    const closeJobs = await tx.query(
      `SELECT remote.id, remote.browser_session_id, remote.shop_id, remote.device_id,
              browser.local_profile_id
       FROM session_remote_sessions remote
       JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
       JOIN session_devices device ON device.id = remote.device_id
       WHERE remote.device_id = ? AND remote.company_id = ? AND remote.workspace_id = ?
         AND (remote.status = 'closing' OR (remote.status = 'error' AND remote.close_stage = 'close_failed' AND remote.close_requested_at IS NOT NULL))
         AND browser.status IN ('closing','closed') AND browser.device_id = remote.device_id
         AND browser.shop_id = remote.shop_id AND browser.company_id = remote.company_id AND browser.workspace_id = remote.workspace_id
         AND device.status = 'active'
       ORDER BY remote.close_requested_at LIMIT 1`,
      [device.id, device.companyId, device.workspaceId]
    );
    for (const closeJob of closeJobs) {
      await tx.execute(
        `UPDATE session_remote_sessions
         SET close_stage = IF(close_stage = 'stopping_remote', 'notifying_agent', close_stage),
             last_agent_at = CURRENT_TIMESTAMP
         WHERE id = ? AND device_id = ? AND status = 'closing'`,
        [closeJob.id, device.id]
      );
    }
    for (const session of sessions) {
      await tx.execute(
        `UPDATE session_remote_sessions SET last_agent_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [session.id]
      );
    }
    response = {
      sessions: sessions.map((session) => ({
        id: session.id,
        browserSessionId: session.browser_session_id,
        shopId: Number(session.shop_id),
        deviceId: session.device_id,
        localProfileId: session.local_profile_id,
        status: session.status,
        expiresAt: session.expires_at,
        platformCode: normalizePlatform(session.store_platform)
      })),
      closeJobs: closeJobs.map((job) => ({
        remoteSessionId: job.id,
        browserSessionId: job.browser_session_id,
        shopId: Number(job.shop_id),
        deviceId: job.device_id,
        localProfileId: job.local_profile_id
      })),
      commands: []
    };
  });
  return response;
}

async function reportRemoteBrowserCloseProgress({ device, sessionId, stage, execute }) {
  const id = uuid(sessionId, '远程会话编号');
  const normalizedStage = cleanText(stage, 40);
  if (!['saving_profile', 'closing_browser'].includes(normalizedStage)) {
    throw publicError('浏览器关闭阶段无效');
  }
  const result = await execute(
    `UPDATE session_remote_sessions
     SET close_stage = ?, last_agent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ? AND workspace_id = ? AND device_id = ? AND status = 'closing'`,
    [normalizedStage, id, device.companyId, device.workspaceId, device.id]
  );
  if (!Number(result.affectedRows)) throw publicError('浏览器关闭任务不存在或不属于当前电脑', 409);
  return { id, status: 'closing', closeStage: normalizedStage };
}

async function completeRemoteBrowserClose({
  device, sessionId, browserSessionId, shopId, localProfileId, withTransaction
}) {
  const id = uuid(sessionId, '远程会话编号');
  const browserId = uuid(browserSessionId, '浏览器会话编号');
  const profileId = uuid(localProfileId, '本机 Profile 编号');
  const targetShopId = positiveInteger(shopId, '店铺编号');
  let response;
  await withTransaction(async (tx) => {
    const [session] = await tx.query(
      `SELECT remote.id, remote.company_id, remote.workspace_id, remote.shop_id, remote.device_id,
              remote.browser_session_id, remote.status AS remote_status, remote.close_stage, remote.close_requested_at,
              browser.local_profile_id, browser.status AS browser_status
       FROM session_remote_sessions remote
       JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
       WHERE remote.id = ? LIMIT 1 FOR UPDATE`,
      [id]
    );
    if (!session) throw publicError('浏览器关闭任务不存在', 404);
    const exactBinding = Number(session.company_id) === Number(device.companyId)
      && Number(session.workspace_id) === Number(device.workspaceId)
      && session.device_id === device.id
      && session.browser_session_id === browserId
      && Number(session.shop_id) === targetShopId
      && session.local_profile_id === profileId;
    if (!exactBinding) throw publicError('浏览器关闭任务不属于当前电脑或店铺', 403);
    if (session.remote_status === 'ended' && session.browser_status === 'closed') {
      response = { id, status: 'ended', browserStatus: 'closed', unchanged: true };
      return;
    }
    const pendingClose = session.remote_status === 'closing' ||
      (session.remote_status === 'error' && session.close_stage === 'close_failed' && session.close_requested_at);
    if (!pendingClose || !['closing', 'closed'].includes(session.browser_status)) {
      throw publicError('浏览器关闭任务已经关闭或状态不一致', 409);
    }
    if (session.browser_status === 'closing') {
      await tx.execute(
        `UPDATE managed_browser_sessions
         SET status = 'closed', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND device_id = ? AND workspace_id = ? AND status = 'closing'`,
        [browserId, device.id, device.workspaceId]
      );
    }
    await tx.execute(
      `UPDATE session_remote_sessions
       SET status = 'ended', close_stage = 'safe_closed',
           close_completed_at = CURRENT_TIMESTAMP, closed_at = CURRENT_TIMESTAMP,
           error_message = NULL, frame_data = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ? AND workspace_id = ? AND device_id = ?
         AND (status = 'closing' OR (status = 'error' AND close_stage = 'close_failed' AND close_requested_at IS NOT NULL))`,
      [id, device.companyId, device.workspaceId, device.id]
    );
    response = { id, status: 'ended', browserStatus: 'closed' };
  });
  return response;
}

async function failRemoteBrowserClose({ device, sessionId, error, execute }) {
  const id = uuid(sessionId, '远程会话编号');
  const result = await execute(
    `UPDATE session_remote_sessions remote
     JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
     SET remote.status = 'error', remote.close_stage = 'close_failed',
         remote.error_message = ?, remote.closed_at = CURRENT_TIMESTAMP,
         remote.frame_data = NULL, remote.updated_at = CURRENT_TIMESTAMP,
         browser.status = IF(browser.status = 'closing', 'open', browser.status),
         browser.updated_at = CURRENT_TIMESTAMP
     WHERE remote.id = ? AND remote.company_id = ? AND remote.workspace_id = ? AND remote.device_id = ?
       AND (remote.status = 'closing' OR (remote.status = 'error' AND remote.close_stage = 'close_failed' AND remote.close_requested_at IS NOT NULL))`,
    [cleanText(error, 1000) || '店铺浏览器安全关闭失败', id, device.companyId, device.workspaceId, device.id]
  );
  if (!Number(result.affectedRows)) throw publicError('浏览器关闭任务不存在或已经处理', 409);
  return { id, status: 'error', closeStage: 'close_failed' };
}

async function uploadRemoteFrame({ device, sessionId, pageUrl, width, height, frameBase64, query, execute }) {
  const id = uuid(sessionId, '远程会话编号');
  const normalizedUrl = cleanText(pageUrl, 1000);
  const encoded = typeof frameBase64 === 'string' ? frameBase64 : '';
  if (!encoded || encoded.length > 900000) throw publicError('远程画面为空或过大', 413);
  const frame = Buffer.from(encoded, 'base64');
  if (frame.length < 4 || frame.length > 650000 || frame[0] !== 0xff || frame[1] !== 0xd8) {
    throw publicError('远程画面格式无效');
  }
  const normalizedWidth = Math.floor(Number(width) || 0);
  const normalizedHeight = Math.floor(Number(height) || 0);
  if (normalizedWidth < 1 || normalizedWidth > 8192 || normalizedHeight < 1 || normalizedHeight > 8192) {
    throw publicError('远程画面尺寸无效');
  }
  const [session] = await query(
    `SELECT remote.id, remote.browser_session_id, store.platform AS store_platform
     FROM session_remote_sessions remote
     JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
     JOIN stores store ON store.id = remote.shop_id AND store.company_id = remote.company_id
     WHERE remote.id = ? AND remote.device_id = ? AND remote.company_id = ? AND remote.workspace_id = ?
       AND remote.status IN ('requested','connected') AND remote.transport_mode = 'jpeg_fallback'
       AND remote.expires_at > CURRENT_TIMESTAMP
       AND browser.status = 'open' AND browser.device_id = remote.device_id
       AND browser.shop_id = remote.shop_id
     LIMIT 1`,
    [id, device.id, device.companyId, device.workspaceId]
  );
  if (!session) throw publicError('远程操作会话已经结束', 409);
  const platformCode = normalizePlatform(session.store_platform);
  if (!isAllowedMerchantUrl(normalizedUrl, platformCode)) throw publicError('页面已离开所属平台允许的商家域名', 403);
  await execute(
    `UPDATE session_remote_sessions
     SET status = 'connected', connected_at = COALESCE(connected_at, CURRENT_TIMESTAMP),
         last_agent_at = CURRENT_TIMESTAMP, frame_sequence = frame_sequence + 1,
         frame_mime = 'image/jpeg', frame_width = ?, frame_height = ?, frame_url = ?,
         frame_data = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND device_id = ? AND workspace_id = ? AND transport_mode = 'jpeg_fallback'
       AND status IN ('requested','connected')`,
    [normalizedWidth, normalizedHeight, normalizedUrl, frame, id, device.id, device.workspaceId]
  );
  await execute(
    `UPDATE managed_browser_sessions
     SET page_url = ?, last_agent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND device_id = ? AND workspace_id = ? AND status = 'open'`,
    [normalizedUrl, session.browser_session_id, device.id, device.workspaceId]
  );
  return { connected: true };
}

async function reportRemoteError({ device, sessionId, error, execute }) {
  const id = uuid(sessionId, '远程会话编号');
  const result = await execute(
    `UPDATE session_remote_sessions
     SET status = 'error', error_message = ?, closed_at = CURRENT_TIMESTAMP,
         frame_data = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND device_id = ? AND workspace_id = ? AND status IN ('requested','connected')`,
    [cleanText(error, 1000) || '远程电脑无法提供画面', id, device.id, device.workspaceId]
  );
  if (!Number(result.affectedRows)) throw publicError('远程操作会话已经结束', 409);
  return { failed: true };
}

async function reportRemoteCommand({ device, commandId, ok, error, execute }) {
  const id = positiveInteger(commandId, '远程操作编号');
  const result = await execute(
    `UPDATE session_remote_commands command_row
     JOIN session_remote_sessions remote ON remote.id = command_row.session_id
     SET command_row.status = ?, command_row.error_message = ?,
         command_row.completed_at = CURRENT_TIMESTAMP
     WHERE command_row.id = ? AND command_row.status = 'running' AND remote.device_id = ? AND remote.workspace_id = ?`,
    [ok ? 'completed' : 'failed', ok ? null : cleanText(error, 1000) || '远程操作执行失败', id, device.id, device.workspaceId]
  );
  if (!Number(result.affectedRows)) throw publicError('远程操作不存在或已经处理', 409);
  return { completed: Boolean(ok) };
}

async function getRemoteFrame({ companyId, workspaceId, userId, sessionId, query }) {
  const id = uuid(sessionId, '远程会话编号');
  const [frame] = await query(
    `SELECT frame_data, frame_mime, frame_sequence, frame_width, frame_height
     FROM session_remote_sessions
     WHERE id = ? AND company_id = ? AND workspace_id = ? AND user_id = ? AND status = 'connected'
       AND transport_mode = 'jpeg_fallback'
       AND expires_at > CURRENT_TIMESTAMP LIMIT 1`,
    [id, companyId, workspaceId, userId]
  );
  if (!frame) throw publicError('远程操作尚未连接或已经结束', 409);
  return frame;
}

async function findActiveManagedBrowserSession({ companyId, workspaceId, userId, shopId, deviceId, query }) {
  const targetShopId = positiveInteger(shopId, '店铺编号');
  const targetDeviceId = uuid(deviceId, '设备编号');
  const [row] = await query(
    `SELECT browser.id, browser.shop_id, browser.device_id, browser.local_profile_id,
            browser.status, browser.page_url, browser.opened_at, browser.last_agent_at
     FROM managed_browser_sessions browser
     JOIN session_devices device ON device.id = browser.device_id
     WHERE browser.company_id = ? AND browser.workspace_id = ? AND browser.user_id = ? AND browser.shop_id = ?
       AND browser.device_id = ? AND browser.status IN ('open','closing') AND device.status = 'active'
       AND (browser.status = 'closing' OR browser.last_agent_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${REMOTE_LIVENESS_SECONDS} SECOND))
     ORDER BY browser.opened_at DESC LIMIT 1`,
    [companyId, workspaceId, userId, targetShopId, targetDeviceId]
  );
  let closeSession = null;
  if (row?.status === 'closing') {
    const [remote] = await query(
      `SELECT id, status, close_stage, close_requested_at, error_message
       FROM session_remote_sessions
       WHERE browser_session_id = ? AND company_id = ? AND workspace_id = ? AND user_id = ?
         AND device_id = ? AND shop_id = ? AND close_requested_at IS NOT NULL
         AND (status = 'closing' OR (status = 'error' AND close_stage = 'close_failed'))
       ORDER BY close_requested_at DESC, created_at DESC LIMIT 1`,
      [row.id, companyId, workspaceId, userId, targetDeviceId, targetShopId]
    );
    if (remote) closeSession = {
      id: remote.id, status: remote.status, closeStage: remote.close_stage,
      closeRequestedAt: remote.close_requested_at, error: remote.error_message,
      browserSessionId: row.id, browserStatus: row.status
    };
  }
  return row ? {
    id: row.id,
    shopId: Number(row.shop_id),
    deviceId: row.device_id,
    localProfileId: row.local_profile_id,
    status: row.status,
    pageUrl: row.page_url,
    openedAt: row.opened_at,
    lastAgentAt: row.last_agent_at,
    ...(closeSession ? { closeSession } : {})
  } : null;
}

async function getWebRtcTicketBinding({ companyId, workspaceId, userId, deviceId, sessionId, query, now = Date.now }) {
  const remoteSessionId = uuid(sessionId, '远程会话编号');
  const [row] = await query(
    `SELECT remote.id, remote.company_id, remote.workspace_id, remote.user_id, remote.shop_id, remote.device_id,
            remote.browser_session_id, remote.status AS remote_status, remote.expires_at,
            browser.status AS browser_status, browser.page_url,
            browser.last_agent_at AS browser_last_agent_at,
            device.status AS device_status, device.last_seen_at AS device_last_seen_at,
            store.platform AS store_platform
     FROM session_remote_sessions remote
     JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
     JOIN session_devices device ON device.id = remote.device_id
     JOIN stores store ON store.id = remote.shop_id AND store.company_id = remote.company_id
     WHERE remote.id = ? LIMIT 1`,
    [remoteSessionId]
  );
  const expected = {
    remoteSessionId,
    companyId: Number(companyId || 0),
    workspaceId: Number(workspaceId || 0),
    userId: Number(userId || 0),
    deviceId: String(deviceId || '')
  };
  if (!validWebRtcBindingRow(row, expected, now())) {
    throw publicError('远程浏览器窗口已离线、过期或归属不匹配', 409);
  }
  return bindingFromRow(row);
}

async function authorizeWebRtcTicket({ ticket, query, now = Date.now }) {
  if (!ticket || !['viewer', 'agent'].includes(ticket.role)) return false;
  const binding = ticket.binding || {};
  const [row] = await query(
    `SELECT remote.id, remote.company_id, remote.workspace_id, remote.user_id, remote.shop_id, remote.device_id,
            remote.browser_session_id, remote.status AS remote_status, remote.expires_at,
            browser.status AS browser_status, browser.page_url,
            browser.last_agent_at AS browser_last_agent_at,
            device.status AS device_status, device.last_seen_at AS device_last_seen_at,
            store.platform AS store_platform
     FROM session_remote_sessions remote
     JOIN managed_browser_sessions browser ON browser.id = remote.browser_session_id
     JOIN session_devices device ON device.id = remote.device_id
     JOIN stores store ON store.id = remote.shop_id AND store.company_id = remote.company_id
     WHERE remote.id = ? LIMIT 1`,
    [String(binding.remoteSessionId || '')]
  );
  return validWebRtcBindingRow(row, binding, now());
}

function validWebRtcBindingRow(row, expected, nowMs) {
  if (!row || !Number.isFinite(Number(nowMs))) return false;
  const exactBinding = (!expected.companyId || Number(row.company_id) === Number(expected.companyId)) &&
    (!expected.workspaceId || Number(row.workspace_id) === Number(expected.workspaceId)) &&
    (!expected.userId || Number(row.user_id) === Number(expected.userId)) &&
    (!expected.deviceId || row.device_id === expected.deviceId) &&
    (!expected.shopId || Number(row.shop_id) === Number(expected.shopId)) &&
    (!expected.browserSessionId || row.browser_session_id === expected.browserSessionId) &&
    row.id === expected.remoteSessionId;
  if (!exactBinding || !['requested', 'connected'].includes(row.remote_status) ||
      row.browser_status !== 'open' || row.device_status !== 'active' ||
      !isAllowedMerchantUrl(row.page_url, normalizePlatform(row.store_platform))) return false;
  const expiresAt = new Date(row.expires_at).getTime();
  const browserAliveAt = new Date(row.browser_last_agent_at).getTime();
  const deviceAliveAt = new Date(row.device_last_seen_at).getTime();
  return expiresAt > nowMs && Number.isFinite(browserAliveAt) && Number.isFinite(deviceAliveAt) &&
    nowMs - browserAliveAt <= REMOTE_LIVENESS_SECONDS * 1000 &&
    nowMs - deviceAliveAt <= REMOTE_LIVENESS_SECONDS * 1000;
}

function bindingFromRow(row) {
  return {
    companyId: Number(row.company_id),
    workspaceId: Number(row.workspace_id),
    userId: Number(row.user_id),
    shopId: Number(row.shop_id),
    deviceId: row.device_id,
    browserSessionId: row.browser_session_id,
    platformCode: normalizePlatform(row.store_platform),
    remoteSessionId: row.id
  };
}

async function terminateRemoteSessionsForBrowser({ device, browserSessionId, withTransaction }) {
  const browserId = uuid(browserSessionId, '浏览器会话编号');
  await withTransaction(async (tx) => {
    await tx.execute(
      `UPDATE session_remote_commands command_row
       JOIN session_remote_sessions remote ON remote.id = command_row.session_id
       SET command_row.status = 'cancelled', command_row.completed_at = CURRENT_TIMESTAMP
       WHERE remote.browser_session_id = ? AND remote.device_id = ?
         AND remote.status IN ('requested','connected')
         AND command_row.status IN ('queued','running')`,
      [browserId, device.id]
    );
    await tx.execute(
      `UPDATE session_remote_sessions
       SET status = 'closed', closed_at = CURRENT_TIMESTAMP, frame_data = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE browser_session_id = ? AND device_id = ?
         AND status IN ('requested','connected')`,
      [browserId, device.id]
    );
  });
}

async function terminateRemoteSessionsForDevice({ companyId, workspaceId, deviceId, withTransaction }) {
  const targetDeviceId = uuid(deviceId, '设备编号');
  await withTransaction(async (tx) => {
    await tx.execute(
      `UPDATE session_remote_commands command_row
       JOIN session_remote_sessions remote ON remote.id = command_row.session_id
       SET command_row.status = 'cancelled', command_row.completed_at = CURRENT_TIMESTAMP
       WHERE remote.company_id = ? AND remote.workspace_id = ? AND remote.device_id = ?
         AND command_row.status IN ('queued','running')`,
      [companyId, workspaceId, targetDeviceId]
    );
    await tx.execute(
      `UPDATE session_remote_sessions
       SET status = 'closed', closed_at = CURRENT_TIMESTAMP, frame_data = NULL,
           frame_mime = NULL, frame_width = NULL, frame_height = NULL, frame_url = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE company_id = ? AND workspace_id = ? AND device_id = ? AND status IN ('requested','connected')`,
      [companyId, workspaceId, targetDeviceId]
    );
    await tx.execute(
      `UPDATE managed_browser_sessions
       SET status = 'closed', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE company_id = ? AND workspace_id = ? AND device_id = ? AND status = 'open'`,
      [companyId, workspaceId, targetDeviceId]
    );
  });
}

module.exports = {
  MINIMUM_REMOTE_AGENT_VERSION,
  REMOTE_COMMAND_KINDS,
  REMOTE_CLOSE_TIMEOUT_SECONDS,
  REMOTE_FRAME_MAX_BYTES: 650000,
  REMOTE_LIVENESS_SECONDS,
  REMOTE_SESSION_SECONDS,
  authorizeWebRtcTicket,
  claimRemoteWork,
  claimWebRtcWork,
  closeRemoteSession,
  completeRemoteBrowserClose,
  createRemoteSession,
  disconnectRemoteTransport,
  findActiveManagedBrowserSession,
  getWebRtcTicketBinding,
  getRemoteFrame,
  getRemoteCommand,
  getRemoteSession,
  isAllowedMerchantUrl,
  normalizeRemoteCommand,
  queueRemoteCommand,
  reportRemoteBrowserCloseProgress,
  reportRemoteCommand,
  reportRemoteError,
  requestRemoteBrowserClose,
  renewRemoteSession,
  requestJpegFallback,
  requestWebRtcRecovery,
  failRemoteBrowserClose,
  terminateRemoteSessionsForBrowser,
  terminateRemoteSessionsForDevice,
  uploadRemoteFrame,
  versionAtLeast
};
