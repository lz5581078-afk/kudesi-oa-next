const crypto = require('crypto');

function publicError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function normalizeUuid(value, label) {
  const normalized = String(value || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(normalized)) throw publicError(`${label}无效`);
  return normalized;
}

function normalizeStoreId(value) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) throw publicError('店铺编号无效');
  return normalized;
}

function normalizePageUrl(value) {
  return String(value || '').trim().slice(0, 1000) || null;
}

const { normalizePlatform } = require('./platform-registry');

async function createManagedBrowserSession({
  device,
  openRequestId,
  storeId,
  localProfileId,
  platformCode,
  pageUrl,
  withTransaction
}) {
  const requestId = normalizeUuid(openRequestId, '打开请求编号');
  const normalizedStoreId = normalizeStoreId(storeId);
  const profileId = normalizeUuid(localProfileId, '本机 Profile 编号');
  const id = crypto.randomUUID();
  let sessionId = id;
  let recovered = false;
  let userId;

  await withTransaction(async (tx) => {
    const [request] = await tx.query(
      `SELECT request.id, request.company_id, request.workspace_id, request.requested_by_employee_id, request.store_id,
              request.target_device_id, request.status, store.platform
       FROM session_open_requests request
       JOIN stores store ON store.id = request.store_id AND store.company_id = request.company_id
       WHERE request.id = ? AND request.target_device_id = ? AND request.company_id = ? AND request.workspace_id = ? AND request.store_id = ?
         AND request.status IN ('claimed', 'running', 'waiting_human', 'opening', 'restoring', 'waiting_login', 'completed')
       LIMIT 1 FOR UPDATE`,
      [requestId, device.id, device.companyId, device.workspaceId, normalizedStoreId]
    );
    if (!request) throw publicError('打开请求不存在或不属于当前电脑', 409);
    const authoritativePlatform = normalizePlatform(request.platform);
    if (authoritativePlatform === 'unsupported_platform' || authoritativePlatform !== String(platformCode || '')) {
      throw publicError('店铺平台与打开请求不匹配', 409);
    }
    const [binding] = await tx.query(
      `SELECT company_id, workspace_id, device_id, store_id, local_profile_id
       FROM session_device_shop_bindings
       WHERE device_id = ? AND store_id = ? AND local_profile_id = ? AND company_id = ? AND workspace_id = ?
       LIMIT 1 FOR UPDATE`,
      [device.id, normalizedStoreId, profileId, device.companyId, device.workspaceId]
    );
    if (!binding) throw publicError('店铺 Profile 不存在或不属于当前电脑', 409);
    userId = Number(request.requested_by_employee_id);
    const [activeBrowser] = await tx.query(
      `SELECT id, user_id, shop_id, local_profile_id, status FROM managed_browser_sessions
       WHERE device_id = ? AND company_id = ? AND workspace_id = ? AND status IN ('open','closing')
       ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`,
      [device.id, device.companyId, device.workspaceId]
    );
    if (activeBrowser) {
      const sameManagedBrowser = activeBrowser.status === 'open'
        && Number(activeBrowser.user_id) === Number(userId)
        && Number(activeBrowser.shop_id) === normalizedStoreId
        && activeBrowser.local_profile_id === profileId;
      if (sameManagedBrowser) {
        sessionId = activeBrowser.id;
        recovered = true;
        await tx.execute(
          `UPDATE managed_browser_sessions
           SET page_url = ?, last_agent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND device_id = ? AND company_id = ? AND status = 'open'`,
          [normalizePageUrl(pageUrl), sessionId, device.id, device.companyId]
        );
        return;
      }
      const message = activeBrowser.status === 'closing'
        ? '正在安全关闭当前店铺，请关闭完成后再打开其他店铺'
        : '当前电脑已有受管店铺浏览器，请先结束远程操作并安全关闭';
      throw publicError(message, 409);
    }
    await tx.execute(
      `INSERT INTO managed_browser_sessions
        (id, company_id, workspace_id, user_id, shop_id, device_id, local_profile_id, status,
         opened_from_request_id, page_url, opened_at, last_agent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, device.companyId, device.workspaceId, userId, normalizedStoreId, device.id, profileId, requestId, normalizePageUrl(pageUrl)]
    );
  });
  return {
    id: sessionId,
    companyId: Number(device.companyId),
    workspaceId: Number(device.workspaceId),
    userId,
    shopId: normalizedStoreId,
    deviceId: device.id,
    localProfileId: profileId,
    platformCode: String(platformCode),
    status: 'open',
    pageUrl: normalizePageUrl(pageUrl),
    recovered
  };
}

async function heartbeatManagedBrowserSession({ device, browserSessionId, pageUrl, execute }) {
  const id = normalizeUuid(browserSessionId, '浏览器会话编号');
  const result = await execute(
    `UPDATE managed_browser_sessions
     SET page_url = ?, last_agent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND device_id = ? AND workspace_id = ? AND status IN ('open','closing')`,
    [normalizePageUrl(pageUrl), id, device.id, device.workspaceId]
  );
  if (!Number(result.affectedRows)) throw publicError('浏览器窗口不存在或不属于当前电脑', 409);
  return { id, status: 'open', pageUrl: normalizePageUrl(pageUrl) };
}

async function closeManagedBrowserSession({ device, browserSessionId, status = 'closed', execute }) {
  const id = normalizeUuid(browserSessionId, '浏览器会话编号');
  const terminalStatus = status === 'error' ? 'error' : 'closed';
  const result = await execute(
    `UPDATE managed_browser_sessions
     SET status = '${terminalStatus}', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND device_id = ? AND workspace_id = ? AND status IN ('open','closing')`,
    [id, device.id, device.workspaceId]
  );
  if (!Number(result.affectedRows)) throw publicError('浏览器窗口不存在或不属于当前电脑', 409);
  await execute(
    `UPDATE session_open_requests request
     JOIN managed_browser_sessions browser
       ON browser.opened_from_request_id = request.id AND browser.company_id = request.company_id
      AND browser.workspace_id = request.workspace_id
     SET request.status = 'failed', request.progress = 100, request.current_step = 'failed',
         request.error_code = 'OPEN_REQUEST_BROWSER_CLOSED',
         request.error_message = '店铺浏览器已关闭，请重新连接',
         request.lease_expires_at = NULL, request.completed_at = CURRENT_TIMESTAMP,
         request.updated_at = CURRENT_TIMESTAMP
     WHERE browser.id = ? AND browser.device_id = ? AND browser.company_id = ? AND browser.workspace_id = ?
       AND request.status IN ('claimed','running','waiting_human','opening','restoring','waiting_login')`,
    [id, device.id, device.companyId, device.workspaceId]
  );
  return { id, status: terminalStatus };
}

module.exports = {
  closeManagedBrowserSession,
  createManagedBrowserSession,
  heartbeatManagedBrowserSession
};
