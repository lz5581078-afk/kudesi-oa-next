const MAX_PAGE_SIZE = 200;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
const DEVICE_ONLINE_WINDOW_MS = 15_000;
const { normalizePlatform, platformDefinition } = require('./platform-registry');

const SORT_SQL = Object.freeze({
  platform_asc: "CASE LOWER(TRIM(s.platform)) WHEN '拼多多' THEN 1 WHEN '淘宝' THEN 2 WHEN '天猫' THEN 2 WHEN '淘宝/天猫' THEN 2 WHEN '抖音' THEN 3 WHEN '抖店' THEN 3 WHEN '抖音电商' THEN 3 WHEN '快手' THEN 4 WHEN '快手电商' THEN 4 WHEN '京东' THEN 5 ELSE 99 END ASC, s.id ASC",
  platform_desc: "CASE LOWER(TRIM(s.platform)) WHEN '拼多多' THEN 1 WHEN '淘宝' THEN 2 WHEN '天猫' THEN 2 WHEN '淘宝/天猫' THEN 2 WHEN '抖音' THEN 3 WHEN '抖店' THEN 3 WHEN '抖音电商' THEN 3 WHEN '快手' THEN 4 WHEN '快手电商' THEN 4 WHEN '京东' THEN 5 ELSE 99 END DESC, s.id ASC",
  operator_asc: '(claimer.name IS NULL) ASC, claimer.name ASC, s.id ASC',
  operator_desc: '(claimer.name IS NULL) ASC, claimer.name DESC, s.id ASC',
  default: 's.name ASC, s.id ASC'
});

function isDeviceOnline(device, now = new Date()) {
  if (String(device?.status || '') !== 'active' || !device?.last_seen_at) return false;
  const lastSeenAt = new Date(device.last_seen_at).getTime();
  return Number.isFinite(lastSeenAt)
    && now.getTime() - lastSeenAt >= 0
    && now.getTime() - lastSeenAt <= DEVICE_ONLINE_WINDOW_MS;
}

function parsePageParams(input = {}) {
  const page = Math.max(1, Number.parseInt(input.page, 10) || 1);
  const pageSize = Math.max(10, Math.min(MAX_PAGE_SIZE, Number.parseInt(input.pageSize, 10) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function buildSessionOverviewSql({ includeStoreCredentials = false } = {}) {
  const credentialColumns = includeStoreCredentials
    ? `,
         managed.withdrawal_login_account,
         CASE WHEN managed.withdrawal_login_password IS NOT NULL AND managed.withdrawal_login_password <> '' THEN 1 ELSE 0 END AS has_withdrawal_login_password`
    : '';
  return `
  SELECT s.id, s.name, s.store_no, s.platform_store_id, s.platform,
         s.status AS store_status, s.abnormal_reason AS store_abnormal_reason,
         managed.auto_login_enabled,
         claimer.name AS operator_name,
         b.login_status, b.local_profile_id, b.last_verified_at, b.last_opened_at, b.last_error,
         b.session_version, b.applied_session_version,
         d.id AS assigned_device_id, d.name AS assigned_device_name, d.remark AS assigned_device_remark,
         d.device_code AS assigned_device_code,
         d.status AS assigned_device_status, d.agent_version AS assigned_device_agent_version,
         d.last_seen_at AS assigned_device_last_seen_at,
         r.id AS request_id, r.status AS request_status, r.progress AS request_progress,
         r.current_step AS request_step, r.error_code AS request_error_code, r.error_message AS request_error${credentialColumns}
  FROM stores s
  JOIN session_managed_shops managed
    ON managed.company_id = s.company_id AND managed.workspace_id = ? AND managed.store_id = s.id AND managed.status = 'active'
  LEFT JOIN employees claimer ON claimer.id = s.current_claimer_id AND claimer.status = 'active'
  LEFT JOIN session_devices d
    ON d.id = managed.assigned_device_id
   AND d.company_id = managed.company_id AND d.workspace_id = managed.workspace_id
  LEFT JOIN session_device_shop_bindings b
    ON b.company_id = managed.company_id AND b.workspace_id = managed.workspace_id
   AND b.device_id = managed.assigned_device_id AND b.store_id = managed.store_id
  LEFT JOIN session_open_requests r ON r.id = (
    SELECT rx.id FROM session_open_requests rx
    WHERE rx.company_id = managed.company_id AND rx.workspace_id = managed.workspace_id
      AND rx.store_id = managed.store_id AND rx.target_device_id = managed.assigned_device_id
    ORDER BY rx.created_at DESC LIMIT 1
  )
  WHERE s.company_id = ?
`;
}

const sessionOverviewSql = buildSessionOverviewSql();

function normalizeShop(row, { includeStoreCredentials = false } = {}) {
  const platformCode = normalizePlatform(row.platform);
  const platform = platformDefinition(platformCode);
  const operatorName = row.operator_name || '';
  const shop = {
    id: row.id,
    name: row.name,
    storeCode: row.store_no || '',
    platformStoreId: row.platform_store_id || '',
    platform: row.platform,
    platformCode,
    platformName: platform.platformName,
    platformSupported: platform.supported,
    operatorName,
    operatorNames: operatorName ? [operatorName] : [],
    storeStatus: row.store_status,
    abnormalReason: row.store_abnormal_reason || '',
    loginStatus: row.login_status || 'pending',
    localProfileId: row.local_profile_id || '',
    lastVerifiedAt: row.last_verified_at,
    lastOpenedAt: row.last_opened_at,
    lastError: row.last_error || row.request_error || '',
    sessionVersion: Number(row.session_version || 0),
    appliedSessionVersion: Number(row.applied_session_version || 0),
    remoteVersion: 0,
    recoverableVersion: 0,
    hasRemote: false,
    autoLoginEnabled: Boolean(Number(row.auto_login_enabled || 0)),
    assignedDeviceId: row.assigned_device_id || null,
    assignedDeviceName: row.assigned_device_name || '',
    assignedDeviceRemark: row.assigned_device_remark || '',
    assignedDeviceCode: row.assigned_device_code || '',
    assignedDeviceStatus: row.assigned_device_status || '',
    assignedDeviceAgentVersion: row.assigned_device_agent_version || '',
    assignedDeviceLastSeenAt: row.assigned_device_last_seen_at,
    assignedDeviceOnline: isDeviceOnline({
      status: row.assigned_device_status,
      last_seen_at: row.assigned_device_last_seen_at
    }),
    // Compatibility aliases for remote-dialog and older API consumers.
    savedDeviceId: row.assigned_device_id || null,
    savedDeviceName: row.assigned_device_name || '',
    savedDeviceCode: row.assigned_device_code || '',
    savedDeviceLastSeenAt: row.assigned_device_last_seen_at,
    request: row.request_id ? {
      id: row.request_id,
      status: row.request_status,
      progress: Number(row.request_progress || 0),
      currentStep: row.request_step || '',
      errorCode: row.request_error_code || '',
      errorMessage: row.request_error || ''
    } : null
  };
  if (includeStoreCredentials) {
    shop.withdrawalLoginAccount = row.withdrawal_login_account || '';
    shop.hasWithdrawalLoginPassword = Boolean(Number(row.has_withdrawal_login_password || 0));
  }
  return shop;
}

function sanitizeHistoryError(value) {
  return String(value || '')
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/gi, '[敏感内容已隐藏]')
    .replace(/(cookie|token|authorization|password|storageState|private[-_ ]?key|验证码|二维码)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/[A-Za-z0-9+/_=-]{80,}/g, '[长值已隐藏]')
    .slice(0, 240);
}

function normalizeOpenHistoryRow(row) {
  const status = row.history_status || row.status;
  const actionType = ['first_login', 'immediate_login'].includes(row.action) ? row.action : 'unrecorded';
  return {
    id: row.id,
    actionType,
    status,
    sessionSource: 'unrecorded',
    completedAt: row.event_at,
    deviceId: row.device_id,
    deviceName: row.device_name || '',
    deviceCode: row.device_code || '',
    errorCode: String(row.error_code || '').slice(0, 60),
    errorMessage: status === 'expired'
      ? '助手未在有效时间内领取请求'
      : sanitizeHistoryError(row.error_message || '')
  };
}

async function getShopOpenHistory({ companyId, workspaceId, storeId, limit = DEFAULT_HISTORY_LIMIT, query, now = new Date() }) {
  const safeLimit = Math.max(DEFAULT_HISTORY_LIMIT, Math.min(MAX_HISTORY_LIMIT, Number.parseInt(limit, 10) || DEFAULT_HISTORY_LIMIT));
  const rows = await query(
    `SELECT r.id, r.action, r.status, r.error_code, r.error_message,
            CASE WHEN r.status = 'queued' THEN 'expired' ELSE r.status END AS history_status,
            CASE
              WHEN r.status = 'queued' THEN r.challenge_expires_at
              WHEN r.status = 'expired' THEN COALESCE(r.completed_at, r.updated_at)
              ELSE r.completed_at
            END AS event_at,
            d.id AS device_id, COALESCE(NULLIF(d.remark, ''), d.name) AS device_name, d.device_code
     FROM session_open_requests r
     JOIN session_devices d ON d.id = r.target_device_id AND d.company_id = r.company_id AND d.workspace_id = r.workspace_id
     WHERE r.company_id = ? AND r.workspace_id = ? AND r.store_id = ?
       AND (
         (r.status IN ('completed', 'failed', 'cancelled', 'expired')
           AND (r.status = 'expired' OR r.completed_at IS NOT NULL))
         OR (r.status = 'queued' AND r.challenge_expires_at IS NOT NULL
           AND r.challenge_expires_at <= ?)
       )
     ORDER BY event_at DESC, r.created_at DESC
     LIMIT ${safeLimit + 1}`,
    [companyId, workspaceId, storeId, now]
  );
  return {
    items: rows.slice(0, safeLimit).map(normalizeOpenHistoryRow),
    hasMore: rows.length > safeLimit,
    limit: safeLimit
  };
}

async function getOverview({ companyId, workspaceId, includeStoreCredentials = false, assignedDeviceId = 'all', keyword = '', status = 'all', loginStatus = '', storeStatus = 'all', sort = 'default', page, pageSize, query }) {
  const paging = parsePageParams({ page, pageSize });
  const overviewSql = buildSessionOverviewSql({ includeStoreCredentials });
  const values = [workspaceId, companyId];
  const clauses = [];
  const assignmentFilter = String(assignedDeviceId || 'all').trim();
  if (assignmentFilter === 'unassigned') {
    clauses.push('managed.assigned_device_id IS NULL');
  } else if (assignmentFilter !== 'all') {
    if (!/^[0-9a-f-]{36}$/i.test(assignmentFilter)) {
      const error = new Error('负责电脑筛选值无效');
      error.statusCode = 400;
      error.publicMessage = error.message;
      throw error;
    }
    clauses.push('managed.assigned_device_id = ?');
    values.push(assignmentFilter);
  }
  if (keyword) {
    clauses.push('(s.platform LIKE ? OR claimer.name LIKE ? OR s.name LIKE ? OR s.store_no LIKE ? OR s.platform_store_id LIKE ?)');
    const like = `%${String(keyword).slice(0, 100)}%`;
    values.push(like, like, like, like, like);
  }
  const normalizedLoginStatus = String(loginStatus || status || 'all');
  if (normalizedLoginStatus !== 'all' && ['pending', 'synced', 'valid', 'expired', 'error'].includes(normalizedLoginStatus)) {
    clauses.push("COALESCE(b.login_status, 'pending') = ?");
    values.push(normalizedLoginStatus);
  }
  if (storeStatus !== 'all' && ['normal', 'abnormal', 'cancelled', 'inactive'].includes(storeStatus)) {
    clauses.push('s.status = ?');
    values.push(storeStatus);
  }
  const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
  const countRows = await query(`SELECT COUNT(*) AS total FROM (${overviewSql}${where}) overview_rows`, values);
  const orderBy = SORT_SQL[String(sort || '')] || SORT_SQL.default;
  const rows = await query(`${overviewSql}${where} ORDER BY ${orderBy} LIMIT ${paging.pageSize} OFFSET ${paging.offset}`, values);
  const total = Number(countRows[0]?.total || 0);
  return { shops: rows.map((row) => normalizeShop(row, { includeStoreCredentials })), total, ...paging, pageCount: Math.max(1, Math.ceil(total / paging.pageSize)) };
}

async function getDevices({ companyId, workspaceId, query, now = new Date() }) {
  const rows = await query(
    `SELECT d.id, d.device_code, d.name, d.remark, d.hostname, d.platform, d.arch, d.agent_version,
            d.status, d.last_seen_at, d.created_at, COUNT(managed.id) AS shop_count
     FROM session_devices d
     LEFT JOIN session_managed_shops managed
       ON managed.company_id = d.company_id AND managed.workspace_id = d.workspace_id
      AND managed.assigned_device_id = d.id AND managed.status = 'active'
     WHERE d.company_id = ? AND d.workspace_id = ? AND d.status <> 'deleted'
     GROUP BY d.id ORDER BY d.status = 'active' DESC, d.last_seen_at DESC, d.created_at DESC`,
    [companyId, workspaceId]
  );
  const jobs = await query(
    `SELECT j.id, j.device_id, j.target_version, j.package_type, j.status, j.phase, j.progress,
            j.downloaded_bytes, j.total_bytes, j.failure_code, j.last_progress_at,
            j.error_message, j.requested_at, j.updated_at
     FROM session_agent_update_jobs j
     WHERE j.company_id = ? AND j.workspace_id = ? AND j.id = (
       SELECT j2.id FROM session_agent_update_jobs j2
       WHERE j2.company_id = j.company_id AND j2.workspace_id = j.workspace_id AND j2.device_id = j.device_id
       ORDER BY j2.requested_at DESC, j2.id DESC LIMIT 1
     )`,
    [companyId, workspaceId]
  );
  const jobsByDevice = new Map(jobs.map((job) => [job.device_id, {
    id: job.id, targetVersion: job.target_version, packageType: job.package_type || 'full',
    status: job.status, phase: job.phase || job.status, progress: Number(job.progress || 0),
    downloadedBytes: Number(job.downloaded_bytes || 0), totalBytes: Number(job.total_bytes || 0),
    failureCode: job.failure_code || '', lastProgressAt: job.last_progress_at,
    errorMessage: job.error_message || '', requestedAt: job.requested_at, updatedAt: job.updated_at
  }]));
  return rows.map((row) => ({
    id: row.id, deviceCode: row.device_code, name: row.name, remark: row.remark || '', hostname: row.hostname,
    platform: row.platform, arch: row.arch, agentVersion: row.agent_version, status: row.status,
    lastSeenAt: row.last_seen_at, online: isDeviceOnline(row, now), shopCount: Number(row.shop_count || 0),
    updateJob: jobsByDevice.get(row.id) || null
  }));
}

async function getShopDetail({ companyId, workspaceId, storeId, historyLimit = DEFAULT_HISTORY_LIMIT, query }) {
  const rows = await query(`${sessionOverviewSql} AND s.id = ? LIMIT 1`, [workspaceId, companyId, storeId]);
  if (!rows[0]) return null;
  const bindings = await query(
    `SELECT b.login_status, b.local_profile_id, b.session_version, b.applied_session_version, b.last_verified_at,
            b.last_session_saved_at, b.last_opened_at, b.last_error,
            d.id AS device_id, d.device_code, d.name AS device_name, d.remark AS device_remark,
            d.status AS device_status, d.last_seen_at
     FROM session_device_shop_bindings b
     JOIN session_devices d ON d.id = b.device_id AND d.workspace_id = b.workspace_id
     WHERE b.company_id = ? AND b.workspace_id = ? AND b.store_id = ? ORDER BY b.updated_at DESC`,
    [companyId, workspaceId, storeId]
  );
  const history = await getShopOpenHistory({ companyId, workspaceId, storeId, limit: historyLimit, query });
  return {
    ...normalizeShop(rows[0]),
    bindings,
    openHistory: history.items,
    historyHasMore: history.hasMore,
    historyLimit: history.limit
  };
}

async function getAuditLogs({ companyId, workspaceId, storeId, deviceId, limit = 100, query }) {
  const clauses = ['l.company_id = ?', 'l.workspace_id = ?'];
  const values = [companyId, workspaceId];
  if (storeId) { clauses.push('l.store_id = ?'); values.push(storeId); }
  if (deviceId) { clauses.push('l.device_id = ?'); values.push(deviceId); }
  const safeLimit = Math.max(10, Math.min(200, Number(limit) || 100));
  return query(
    `SELECT l.id, l.event_type, l.outcome, l.summary, l.store_id, l.device_id, l.open_request_id,
            l.created_at, s.name AS store_name, COALESCE(NULLIF(d.remark, ''), d.name) AS device_name
     FROM session_audit_logs l
     LEFT JOIN stores s ON s.id = l.store_id AND s.company_id = l.company_id
     LEFT JOIN session_devices d ON d.id = l.device_id AND d.company_id = l.company_id AND d.workspace_id = l.workspace_id
     WHERE ${clauses.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC LIMIT ${safeLimit}`,
    values
  );
}

module.exports = {
  DEVICE_ONLINE_WINDOW_MS,
  buildSessionOverviewSql,
  getAuditLogs,
  getDevices,
  getOverview,
  getShopDetail,
  getShopOpenHistory,
  isDeviceOnline,
  parsePageParams,
  sanitizeHistoryError,
  sessionOverviewSql
};
