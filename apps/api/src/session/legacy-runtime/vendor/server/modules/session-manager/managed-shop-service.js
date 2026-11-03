function publicError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function normalizeCandidate(row) {
  const platformCode = normalizePlatform(row.platform);
  const platform = platformDefinition(platformCode);
  const operatorName = row.operator_name || '';
  return {
    id: Number(row.id),
    name: row.name,
    storeCode: row.store_no || '',
    platformStoreId: row.platform_store_id || '',
    platform: row.platform || '',
    platformCode,
    platformName: platform.platformName,
    platformSupported: platform.supported,
    operatorName,
    operatorNames: operatorName ? [operatorName] : [],
    status: row.status || ''
  };
}

async function searchAvailableShops({ companyId, workspaceId, keyword = '', query }) {
  const safeKeyword = String(keyword || '').trim().slice(0, 100);
  const values = [companyId, workspaceId];
  let keywordWhere = '';
  if (safeKeyword) {
    const like = `%${safeKeyword}%`;
    keywordWhere = ' AND (s.platform LIKE ? OR claimer.name LIKE ? OR s.name LIKE ? OR s.store_no LIKE ? OR s.platform_store_id LIKE ?)';
    values.push(like, like, like, like, like);
  }
  const rows = await query(
    `SELECT s.id, s.name, s.store_no, s.platform_store_id, s.platform, s.status,
            claimer.name AS operator_name
     FROM stores s
     LEFT JOIN employees claimer ON claimer.id = s.current_claimer_id AND claimer.status = 'active'
     WHERE s.company_id = ?
       AND s.status = 'normal'
       AND NOT EXISTS (
         SELECT 1 FROM session_managed_shops managed
         WHERE managed.company_id = s.company_id AND managed.workspace_id = ? AND managed.store_id = s.id
           AND managed.status = 'active'
       )${keywordWhere}
     ORDER BY s.name, s.id`,
    values
  );
  return rows.map(normalizeCandidate);
}

function normalizeStoreIds(storeIds) {
  return [...new Set((Array.isArray(storeIds) ? storeIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))].slice(0, 100);
}

function normalizeDeviceId(value, { allowEmpty = false } = {}) {
  const normalized = String(value || '').trim();
  if (!normalized && allowEmpty) return null;
  if (!/^[0-9a-f-]{36}$/i.test(normalized)) throw publicError('负责电脑编号无效');
  return normalized;
}

async function getAssignableDevice({ companyId, workspaceId, deviceId, tx }) {
  const [device] = await tx.query(
    `SELECT id, name, device_code, status
     FROM session_devices
     WHERE id = ? AND company_id = ? AND workspace_id = ? AND status = 'active'
     LIMIT 1 FOR UPDATE`,
    [deviceId, companyId, workspaceId]
  );
  if (!device) throw publicError('负责电脑不存在、已撤销或不属于当前工作区', 404);
  return device;
}

async function addManagedShops({ companyId, workspaceId, employeeId, storeIds, assignedDeviceId, withTransaction }) {
  const normalizedIds = normalizeStoreIds(storeIds);
  if (normalizedIds.length === 0) throw publicError('至少选择一家店铺');
  const normalizedDeviceId = normalizeDeviceId(assignedDeviceId);
  return withTransaction(async (tx) => {
    const device = await getAssignableDevice({ companyId, workspaceId, deviceId: normalizedDeviceId, tx });
    const placeholders = normalizedIds.map(() => '?').join(', ');
    const eligible = await tx.query(
      `SELECT id, platform FROM stores
       WHERE company_id = ? AND status = 'normal' AND id IN (${placeholders})`,
      [companyId, ...normalizedIds]
    );
    if (new Set(eligible.map((row) => Number(row.id))).size !== normalizedIds.length
        || eligible.some((row) => normalizePlatform(row.platform) === 'unsupported_platform')) {
      throw publicError('所选店铺不属于当前企业或平台暂未支持');
    }
    let added = 0;
    let restored = 0;
    for (const storeId of normalizedIds) {
      const result = await tx.execute(
        `INSERT INTO session_managed_shops
          (company_id, workspace_id, store_id, assigned_device_id, assigned_by_employee_id,
           assigned_at, added_by_employee_id, status)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 'active')
         ON DUPLICATE KEY UPDATE
           status = 'active', added_by_employee_id = VALUES(added_by_employee_id),
           assigned_device_id = VALUES(assigned_device_id),
           assigned_by_employee_id = VALUES(assigned_by_employee_id), assigned_at = CURRENT_TIMESTAMP,
           removed_at = NULL, removed_by_employee_id = NULL, updated_at = CURRENT_TIMESTAMP`,
        [companyId, workspaceId, storeId, normalizedDeviceId, employeeId, employeeId]
      );
      if (Number(result.affectedRows) === 1) added += 1;
      if (Number(result.affectedRows) === 2) restored += 1;
    }
    return {
      selected: normalizedIds.length,
      added,
      ...(restored > 0 ? { restored } : {}),
      assignedDevice: { id: device.id, name: device.name, deviceCode: device.device_code }
    };
  });
}

const ASSIGNMENT_BLOCKING_REQUEST_STATUSES = [
  'queued', 'claimed', 'running', 'waiting_human', 'opening', 'restoring', 'waiting_login'
];

async function assignManagedShop({
  companyId,
  workspaceId,
  employeeId,
  storeId,
  deviceId,
  expectedDeviceId,
  withTransaction
}) {
  const normalizedStoreId = Number(storeId);
  if (!Number.isInteger(normalizedStoreId) || normalizedStoreId <= 0) throw publicError('店铺编号无效');
  const normalizedDeviceId = normalizeDeviceId(deviceId, { allowEmpty: true });
  const hasExpectedDevice = expectedDeviceId !== undefined;
  const normalizedExpectedDeviceId = hasExpectedDevice
    ? normalizeDeviceId(expectedDeviceId, { allowEmpty: true })
    : undefined;

  return withTransaction(async (tx) => {
    const [managed] = await tx.query(
      `SELECT managed.id, managed.store_id, managed.assigned_device_id, store.name
       FROM session_managed_shops managed
       JOIN stores store ON store.id = managed.store_id AND store.company_id = managed.company_id
       WHERE managed.company_id = ? AND managed.workspace_id = ? AND managed.store_id = ?
         AND managed.status = 'active'
       LIMIT 1 FOR UPDATE`,
      [companyId, workspaceId, normalizedStoreId]
    );
    if (!managed) throw publicError('店铺不存在或不属于当前工作区的登录态管理列表', 404);
    if (hasExpectedDevice && (managed.assigned_device_id || null) !== normalizedExpectedDeviceId) {
      throw publicError('店铺负责电脑已被其他人修改，请刷新后重试', 409);
    }
    if ((managed.assigned_device_id || null) === normalizedDeviceId) {
      return {
        changed: false,
        storeId: normalizedStoreId,
        storeName: managed.name,
        previousDeviceId: managed.assigned_device_id || null,
        assignedDevice: normalizedDeviceId ? { id: normalizedDeviceId } : null
      };
    }

    const assignedDevice = normalizedDeviceId
      ? await getAssignableDevice({ companyId, workspaceId, deviceId: normalizedDeviceId, tx })
      : null;
    const placeholders = ASSIGNMENT_BLOCKING_REQUEST_STATUSES.map(() => '?').join(', ');
    const [activeRequest] = await tx.query(
      `SELECT id FROM session_open_requests
       WHERE company_id = ? AND workspace_id = ? AND store_id = ?
         AND status IN (${placeholders})
       LIMIT 1 FOR UPDATE`,
      [companyId, workspaceId, normalizedStoreId, ...ASSIGNMENT_BLOCKING_REQUEST_STATUSES]
    );
    if (activeRequest) throw publicError('店铺存在进行中的登录任务，请结束任务后再更换电脑', 409);

    const [activeBrowser] = await tx.query(
      `SELECT id FROM managed_browser_sessions
       WHERE company_id = ? AND workspace_id = ? AND shop_id = ? AND status IN ('open','closing')
       LIMIT 1 FOR UPDATE`,
      [companyId, workspaceId, normalizedStoreId]
    );
    if (activeBrowser) throw publicError('店铺浏览器仍在运行，请结束远程操作并安全关闭后再更换电脑', 409);

    const [activeRemote] = await tx.query(
      `SELECT id FROM session_remote_sessions
       WHERE company_id = ? AND workspace_id = ? AND shop_id = ?
         AND status IN ('requested','connected','closing')
       LIMIT 1 FOR UPDATE`,
      [companyId, workspaceId, normalizedStoreId]
    );
    if (activeRemote) throw publicError('店铺远程会话尚未结束，请关闭远程操作后再更换电脑', 409);

    await tx.execute(
      `UPDATE session_managed_shops
       SET assigned_device_id = ?, assigned_by_employee_id = ?, assigned_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ? AND workspace_id = ? AND status = 'active'`,
      [normalizedDeviceId, employeeId, managed.id, companyId, workspaceId]
    );
    return {
      changed: true,
      storeId: normalizedStoreId,
      storeName: managed.name,
      previousDeviceId: managed.assigned_device_id || null,
      assignedDevice: assignedDevice ? {
        id: assignedDevice.id,
        name: assignedDevice.name,
        deviceCode: assignedDevice.device_code
      } : null
    };
  });
}

async function removeManagedShop({ companyId, workspaceId, employeeId, storeId, withTransaction }) {
  const normalizedStoreId = Number(storeId);
  if (!Number.isInteger(normalizedStoreId) || normalizedStoreId <= 0) throw publicError('店铺编号无效');
  return withTransaction(async (tx) => {
    const [managed] = await tx.query(
      `SELECT managed.id, managed.store_id, store.name
       FROM session_managed_shops managed
       JOIN stores store ON store.id = managed.store_id AND store.company_id = managed.company_id
       WHERE managed.company_id = ? AND managed.workspace_id = ? AND managed.store_id = ? AND managed.status = 'active'
       LIMIT 1 FOR UPDATE`,
      [companyId, workspaceId, normalizedStoreId]
    );
    if (!managed) throw publicError('店铺不存在或不属于当前企业的登录态管理列表', 404);

    const [inProgress] = await tx.query(
      `SELECT id, status FROM session_open_requests
       WHERE company_id = ? AND workspace_id = ? AND store_id = ?
         AND status IN ('claimed', 'running', 'waiting_human', 'opening', 'restoring', 'waiting_login')
       LIMIT 1 FOR UPDATE`,
      [companyId, workspaceId, normalizedStoreId]
    );
    if (inProgress) throw publicError('当前电脑正在打开店铺，请等待任务结束后再移除', 409);

    const cancelled = await tx.execute(
      `UPDATE session_open_requests
       SET status = 'cancelled', current_step = 'cancelled', lease_expires_at = NULL,
           completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE company_id = ? AND workspace_id = ? AND store_id = ? AND status = 'queued'`,
      [companyId, workspaceId, normalizedStoreId]
    );
    await tx.execute(
      `UPDATE session_managed_shops
       SET status = 'removed', removed_at = CURRENT_TIMESTAMP,
           removed_by_employee_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ? AND workspace_id = ? AND status = 'active'`,
      [employeeId, managed.id, companyId, workspaceId]
    );
    return {
      storeId: normalizedStoreId,
      storeName: managed.name,
      cancelledQueuedRequests: Number(cancelled.affectedRows || 0)
    };
  });
}

module.exports = {
  addManagedShops,
  assignManagedShop,
  normalizeDeviceId,
  normalizeStoreIds,
  removeManagedShop,
  searchAvailableShops
};
const { normalizePlatform, platformDefinition } = require('./platform-registry');
