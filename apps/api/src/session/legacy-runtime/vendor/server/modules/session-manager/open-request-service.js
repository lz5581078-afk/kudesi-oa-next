const crypto = require('crypto');
const { normalizePlatform, platformDefinition } = require('./platform-registry');

const REQUEST_LEASE_MS = 30_000;
const DEVICE_ONLINE_WINDOW_MS = 15_000;
const ACTIVE_STATUSES = ['queued', 'claimed', 'running', 'waiting_human', 'opening', 'restoring', 'waiting_login'];
const UPDATE_STATUSES = ['running', 'waiting_human', 'opening', 'restoring', 'waiting_login', 'completed', 'failed'];
const STALE_ERROR_CODE = 'OPEN_REQUEST_LEASE_EXPIRED';
const STALE_ERROR_MESSAGE = '打开任务心跳已超时，请重新连接';

function publicError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

async function createOpenRequest({ companyId, workspaceId, employeeId, storeId, deviceId, withTransaction, now = new Date() }) {
  const normalizedStoreId = Number(storeId);
  if (!Number.isInteger(normalizedStoreId) || normalizedStoreId <= 0) throw publicError('店铺编号无效');

  return withTransaction(async (tx) => {
    await expireStaleOpenRequests({ companyId, execute: tx.execute, now });
    const [store] = await tx.query(
      `SELECT store.id, store.name, store.platform, managed.assigned_device_id
       FROM stores store
       JOIN session_managed_shops managed
         ON managed.store_id = store.id AND managed.company_id = store.company_id AND managed.workspace_id = ? AND managed.status = 'active'
       WHERE store.id = ? AND store.company_id = ? LIMIT 1 FOR UPDATE`,
      [workspaceId, normalizedStoreId, companyId]
    );
    if (!store) throw publicError('店铺尚未加入登录态管理或不属于当前企业', 404);
    if (!store.assigned_device_id) throw publicError('店铺尚未分配负责电脑，请先完成电脑分配', 409);
    const targetDeviceId = String(store.assigned_device_id);
    if (deviceId && String(deviceId) !== targetDeviceId) {
      throw publicError('任务目标电脑与店铺负责电脑不一致，请刷新后重试', 409);
    }
    const [device] = await tx.query(
      `SELECT id, agent_version, last_seen_at FROM session_devices
       WHERE id = ? AND company_id = ? AND workspace_id = ? AND status = 'active'
       LIMIT 1 FOR UPDATE`,
      [targetDeviceId, companyId, workspaceId]
    );
    if (!device) throw publicError('店铺负责电脑已撤销或不属于当前工作区，请重新分配', 409);
    const lastSeenAt = device.last_seen_at ? new Date(device.last_seen_at).getTime() : 0;
    const heartbeatAge = now.getTime() - lastSeenAt;
    if (!lastSeenAt || !Number.isFinite(heartbeatAge) || heartbeatAge < 0 || heartbeatAge > DEVICE_ONLINE_WINDOW_MS) {
      throw publicError('店铺负责电脑助手离线，无法打开店铺', 409);
    }
    const platformCode = normalizePlatform(store.platform);
    if (platformCode === 'unsupported_platform') throw publicError('该店铺平台暂未支持，不能打开店铺', 409);
    const [binding] = await tx.query(
      `SELECT local_profile_id, last_opened_at FROM session_device_shop_bindings
       WHERE company_id = ? AND workspace_id = ? AND device_id = ? AND store_id = ? LIMIT 1 FOR UPDATE`,
      [companyId, workspaceId, targetDeviceId, normalizedStoreId]
    );
    const [activeBrowser] = await tx.query(
      `SELECT id, shop_id, status FROM managed_browser_sessions
       WHERE company_id = ? AND workspace_id = ? AND device_id = ? AND status IN ('open','closing')
       ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`,
      [companyId, workspaceId, targetDeviceId]
    );
    if (activeBrowser && Number(activeBrowser.shop_id) !== normalizedStoreId) {
      throw publicError(
        activeBrowser.status === 'closing'
          ? '正在安全关闭当前店铺，请关闭完成后再打开其他店铺'
          : '当前电脑仍打开其他店铺，请先结束远程操作并安全关闭',
        409
      );
    }
    const action = binding?.last_opened_at ? 'immediate_login' : 'first_login';
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const [active] = await tx.query(
      `SELECT id FROM session_open_requests
       WHERE target_device_id = ? AND workspace_id = ? AND store_id = ? AND status IN (${placeholders})
       LIMIT 1 FOR UPDATE`,
      [targetDeviceId, workspaceId, normalizedStoreId, ...ACTIVE_STATUSES]
    );
    if (active) throw publicError('该店铺在当前电脑已有进行中的打开请求', 409);
    const id = crypto.randomUUID();
    await tx.execute(
      `INSERT INTO session_open_requests
        (id, company_id, workspace_id, requested_by_employee_id, store_id, target_device_id,
         action, dispatch_mode, status, progress, current_step)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'remote', 'queued', 0, 'queued')`,
      [id, companyId, workspaceId, employeeId, normalizedStoreId, targetDeviceId, action]
    );
    return {
      id, action, dispatchMode: 'remote', status: 'queued', progress: 0, currentStep: 'queued',
      platformCode, platformName: platformDefinition(platformCode).platformName, deviceId: targetDeviceId
    };
  });
}

async function expireStaleOpenRequests({ companyId, execute, now = new Date() }) {
  const expirableStatuses = ACTIVE_STATUSES.filter((status) => status !== 'queued');
  const placeholders = expirableStatuses.map(() => '?').join(', ');
  const result = await execute(
    `UPDATE session_open_requests
     SET status = 'failed', progress = 100, current_step = 'failed',
         error_code = ?, error_message = ?, lease_expires_at = NULL,
         completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE company_id = ? AND status IN (${placeholders})
       AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    [STALE_ERROR_CODE, STALE_ERROR_MESSAGE, companyId, ...expirableStatuses, now]
  );
  return Number(result.affectedRows || 0);
}

async function claimNextOpenRequest({ device, withTransaction, now = new Date() }) {
  return withTransaction(async (tx) => {
    const [request] = await tx.query(
      `SELECT request.*, store.name AS store_name, store.platform, managed.auto_login_enabled, workspace.workspace_key
       FROM session_open_requests request
       JOIN stores store ON store.id = request.store_id AND store.company_id = request.company_id
       JOIN session_managed_shops managed
         ON managed.company_id = request.company_id AND managed.workspace_id = request.workspace_id AND managed.store_id = request.store_id AND managed.status = 'active'
       JOIN session_workspaces workspace ON workspace.id = request.workspace_id AND workspace.company_id = request.company_id
       WHERE request.target_device_id = ? AND request.company_id = ? AND request.workspace_id = ?
         AND (request.status = 'queued' OR (request.status = 'claimed' AND request.lease_expires_at < ?))
       ORDER BY request.created_at LIMIT 1 FOR UPDATE`,
      [device.id, device.companyId, device.workspaceId, now]
    );
    if (!request) return null;
    const leaseExpiresAt = new Date(now.getTime() + REQUEST_LEASE_MS);
    await tx.execute(
      `UPDATE session_open_requests
       SET status = 'claimed', progress = GREATEST(progress, 10), current_step = 'claimed',
           lease_expires_at = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND target_device_id = ?`,
      [leaseExpiresAt, request.id, device.id]
    );
    const platformCode = normalizePlatform(request.platform);
    if (platformCode === 'unsupported_platform') throw publicError('该店铺平台暂未支持，不能打开店铺', 409);
    return {
      ...request,
      platform_code: platformCode,
      platform_name: platformDefinition(platformCode).platformName,
      status: 'claimed', progress: Math.max(Number(request.progress || 0), 10), current_step: 'claimed', lease_expires_at: leaseExpiresAt
    };
  });
}

async function updateOpenRequest({ device, requestId, update, withTransaction }) {
  return withTransaction(async (tx) => {
    const [request] = await tx.query(
      `SELECT id, store_id, status, progress, completed_at FROM session_open_requests
       WHERE id = ? AND target_device_id = ? AND company_id = ? AND workspace_id = ? LIMIT 1 FOR UPDATE`,
      [requestId, device.id, device.companyId, device.workspaceId]
    );
    if (!request) throw publicError('打开请求不存在或不属于当前电脑', 404);
    if (request.status === 'cancelled') throw publicError('打开请求已取消', 409);
    const status = String(update?.status || '').trim();
    const progress = Math.max(0, Math.min(100, Math.floor(Number(update?.progress || 0))));
    if (!UPDATE_STATUSES.includes(status)) throw publicError('打开请求状态无效');
    if (progress < Number(request.progress || 0)) throw publicError('打开进度不能倒退');
    if (['completed', 'failed'].includes(request.status)) {
      if (request.status !== status) throw publicError('打开请求已经结束', 409);
      return {
        id: requestId,
        storeId: request.store_id,
        status,
        progress: Number(request.progress || 0),
        currentStep: status,
        completedAt: request.completed_at,
        unchanged: true
      };
    }
    const terminal = ['completed', 'failed'].includes(status);
    await tx.execute(
      `UPDATE session_open_requests
       SET status = ?, progress = ?, current_step = ?, error_code = ?, error_message = ?,
           lease_expires_at = ?, completed_at = IF(?, CURRENT_TIMESTAMP, completed_at),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND target_device_id = ? AND company_id = ? AND workspace_id = ? AND status <> 'cancelled'`,
      [
        status,
        progress,
        String(update?.currentStep || status).trim().slice(0, 60),
        String(update?.errorCode || '').trim().slice(0, 60) || null,
        String(update?.errorMessage || '').trim().slice(0, 1000) || null,
        terminal ? null : new Date(Date.now() + REQUEST_LEASE_MS),
        terminal ? 1 : 0,
        requestId,
        device.id,
        device.companyId,
        device.workspaceId
      ]
    );
    let completedAt = null;
    if (terminal) {
      const [terminalRequest] = await tx.query(
        'SELECT completed_at FROM session_open_requests WHERE id = ? AND company_id = ? AND workspace_id = ? LIMIT 1',
        [requestId, device.companyId, device.workspaceId]
      );
      completedAt = terminalRequest?.completed_at || null;
      if (status === 'completed') {
        const bindingResult = await tx.execute(
          `UPDATE session_device_shop_bindings
           SET last_opened_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE company_id = ? AND workspace_id = ? AND device_id = ? AND store_id = ?`,
          [completedAt, device.companyId, device.workspaceId, device.id, request.store_id]
        );
        if (Number(bindingResult.affectedRows) !== 1) {
          throw publicError('店铺在当前电脑尚未建立独立 Profile，无法记录打开时间', 409);
        }
      }
      await tx.execute(
        `INSERT INTO session_audit_logs
          (company_id, workspace_id, device_id, store_id, open_request_id, event_type, outcome, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          device.companyId,
          device.workspaceId,
          device.id,
          request.store_id,
          requestId,
          status === 'completed' ? 'shop_open_completed' : 'shop_open_failed',
          status === 'completed' ? 'success' : 'failed',
          status === 'completed'
            ? '助手已打开店铺独立浏览器'
            : `助手打开店铺失败（${String(update?.errorCode || 'AGENT_ERROR').slice(0, 60)}）`,
          completedAt
        ]
      );
    }
    return {
      id: requestId,
      storeId: request.store_id,
      status,
      progress,
      currentStep: update?.currentStep || status,
      completedAt
    };
  });
}

async function cancelOpenRequest({ companyId, workspaceId, requestId, execute }) {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  const result = await execute(
    `UPDATE session_open_requests
     SET status = 'cancelled', current_step = 'cancelled', lease_expires_at = NULL,
         completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ? AND workspace_id = ? AND status IN (${placeholders})`,
    [requestId, companyId, workspaceId, ...ACTIVE_STATUSES]
  );
  return Number(result.affectedRows) === 1;
}

module.exports = {
  ACTIVE_STATUSES,
  DEVICE_ONLINE_WINDOW_MS,
  REQUEST_LEASE_MS,
  cancelOpenRequest,
  claimNextOpenRequest,
  createOpenRequest,
  expireStaleOpenRequests,
  updateOpenRequest
};
