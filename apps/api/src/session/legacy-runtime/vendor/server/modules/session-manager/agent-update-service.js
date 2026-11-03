const crypto = require('crypto');

const ACTIVE_STATUSES = ['queued', 'claimed', 'downloading', 'verifying', 'staged', 'deferred', 'applying', 'restarting'];
const REPORT_STATUSES = new Set(['downloading', 'verifying', 'staged', 'deferred', 'applying', 'restarting', 'succeeded', 'failed', 'repair_required']);

function serviceError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || '').trim());
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function normalizeJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    deviceId: row.device_id,
    targetVersion: row.target_version,
    packageType: row.package_type || 'full',
    status: row.status,
    phase: row.phase || row.status,
    progress: Number(row.progress || 0),
    downloadedBytes: Number(row.downloaded_bytes || 0),
    totalBytes: Number(row.total_bytes || 0),
    failureCode: row.failure_code || '',
    startedAt: row.started_at,
    lastProgressAt: row.last_progress_at,
    errorMessage: row.error_message || '',
    requestedAt: row.requested_at,
    updatedAt: row.updated_at
  };
}

async function queueDeviceUpdate({ companyId, workspaceId, employeeId, deviceId, targetVersion, query, execute }) {
  if (!parseVersion(targetVersion)) throw serviceError(400, '目标助手版本无效。');
  const [device] = await query(
    `SELECT id, agent_version FROM session_devices
     WHERE id = ? AND company_id = ? AND workspace_id = ? AND status = 'active' LIMIT 1`,
    [deviceId, companyId, workspaceId]
  );
  if (!device) throw serviceError(404, '授权电脑不存在或已撤销。');
  if (compareVersions(device.agent_version, targetVersion) >= 0) {
    return { queued: false, alreadyCurrent: true, deviceId, targetVersion };
  }
  const [active] = await query(
    `SELECT id, device_id, target_version, package_type, status, phase, progress, downloaded_bytes,
            total_bytes, failure_code, started_at, last_progress_at, error_message, requested_at, updated_at
     FROM session_agent_update_jobs
     WHERE company_id = ? AND workspace_id = ? AND device_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
     ORDER BY requested_at DESC LIMIT 1`,
    [companyId, workspaceId, deviceId, ...ACTIVE_STATUSES]
  );
  if (active) return { queued: false, alreadyCurrent: false, job: normalizeJob(active) };
  const id = crypto.randomUUID();
  await execute(
    `INSERT INTO session_agent_update_jobs
      (id, company_id, workspace_id, device_id, requested_by_employee_id, target_version, package_type, status, phase, progress)
     VALUES (?, ?, ?, ?, ?, ?, 'full', 'queued', 'queued', 0)`,
    [id, companyId, workspaceId, deviceId, employeeId || null, targetVersion]
  );
  return { queued: true, alreadyCurrent: false, job: { id, deviceId, targetVersion, status: 'queued', errorMessage: '' } };
}

async function queueAllDeviceUpdates({ companyId, workspaceId, employeeId, targetVersion, query, execute }) {
  const devices = await query(
    `SELECT id, agent_version FROM session_devices WHERE company_id = ? AND workspace_id = ? AND status = 'active' ORDER BY created_at`,
    [companyId, workspaceId]
  );
  const results = [];
  for (const device of devices) {
    if (compareVersions(device.agent_version, targetVersion) < 0) {
      results.push(await queueDeviceUpdate({ companyId, workspaceId, employeeId, deviceId: device.id, targetVersion, query, execute }));
    }
  }
  return { targetVersion, total: devices.length, queued: results.filter((item) => item.queued).length, pending: results.length };
}

async function claimDeviceUpdate({ device, query, execute }) {
  const [row] = await query(
    `SELECT id, device_id, target_version, package_type, status, phase, progress, downloaded_bytes,
            total_bytes, failure_code, started_at, last_progress_at, error_message, requested_at, updated_at
     FROM session_agent_update_jobs
     WHERE company_id = ? AND workspace_id = ? AND device_id = ? AND status IN ('queued','deferred')
     ORDER BY requested_at LIMIT 1`,
    [device.companyId, device.workspaceId, device.id]
  );
  if (!row) return null;
  const result = await execute(
    `UPDATE session_agent_update_jobs SET status = 'claimed', phase = 'claimed', progress = 0,
       claimed_at = CURRENT_TIMESTAMP, started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
       last_progress_at = CURRENT_TIMESTAMP, error_message = NULL, failure_code = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ? AND workspace_id = ? AND device_id = ? AND status IN ('queued','deferred')`,
    [row.id, device.companyId, device.workspaceId, device.id]
  );
  if (!result.affectedRows) return null;
  return normalizeJob({ ...row, status: 'claimed', error_message: null });
}

async function reportDeviceUpdate({ device, jobId, status, errorMessage, phase, progress, downloadedBytes, totalBytes, failureCode, execute }) {
  if (!REPORT_STATUSES.has(status)) throw serviceError(400, '助手更新状态无效。');
  const terminal = ['succeeded', 'failed', 'repair_required'].includes(status);
  const completed = terminal ? ', completed_at = CURRENT_TIMESTAMP' : '';
  const applying = status === 'applying' ? ', applying_at = CURRENT_TIMESTAMP' : '';
  const safeProgress = Math.max(0, Math.min(100, Number.parseInt(progress, 10) || 0));
  const safeDownloaded = Math.max(0, Number.parseInt(downloadedBytes, 10) || 0);
  const safeTotal = Math.max(0, Number.parseInt(totalBytes, 10) || 0);
  const normalizedPhase = status === 'succeeded' ? 'succeeded' : String(phase || status).slice(0, 40);
  const reportableCurrentStatuses = ACTIVE_STATUSES.filter((item) => item !== 'queued');
  if (status === 'succeeded') reportableCurrentStatuses.push('succeeded');
  const result = await execute(
    `UPDATE session_agent_update_jobs SET status = ?, phase = ?, progress = ?, downloaded_bytes = ?, total_bytes = ?,
       error_message = ?, failure_code = ?, last_progress_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP${completed}${applying}
     WHERE id = ? AND company_id = ? AND workspace_id = ? AND device_id = ? AND status IN (${reportableCurrentStatuses.map(() => '?').join(',')})`,
    [status, normalizedPhase, safeProgress, safeDownloaded, safeTotal,
      ['failed', 'repair_required'].includes(status) ? String(errorMessage || '助手更新失败').slice(0, 500) : null,
      failureCode ? String(failureCode).slice(0, 80) : null,
      jobId, device.companyId, device.workspaceId, device.id, ...reportableCurrentStatuses]
  );
  if (!result.affectedRows) throw serviceError(404, '助手更新任务不存在或状态已结束。');
  return { ok: true, status };
}

async function confirmDeviceUpdatesFromHeartbeat({ deviceId, agentVersion, execute }) {
  if (!parseVersion(agentVersion)) return;
  await execute(
    `UPDATE session_agent_update_jobs
     SET status = 'succeeded', phase = 'succeeded', progress = 100, completed_at = CURRENT_TIMESTAMP,
         error_message = NULL, failure_code = NULL, last_progress_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE device_id = ? AND target_version = ?
        AND status IN ('claimed','downloading','verifying','staged','applying','restarting','failed')`,
    [deviceId, agentVersion]
  );
}

async function expireStaleDeviceUpdates({ execute }) {
  const result = await execute(
    `UPDATE session_agent_update_jobs
     SET status = 'failed', phase = 'failed', completed_at = CURRENT_TIMESTAMP,
         failure_code = CASE
           WHEN status = 'downloading' THEN 'download_stalled'
           WHEN status = 'verifying' THEN 'verify_timeout'
           ELSE 'apply_timeout'
         END,
         error_message = CASE
           WHEN status = 'downloading' THEN '更新包下载超过10分钟没有进度。'
           WHEN status = 'verifying' THEN '更新包校验超过2分钟。'
           ELSE '更新安装或重启超过3分钟。'
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE (status = 'downloading' AND COALESCE(last_progress_at, updated_at, claimed_at, requested_at) < CURRENT_TIMESTAMP - INTERVAL 10 MINUTE)
        OR (status = 'verifying' AND COALESCE(last_progress_at, updated_at, claimed_at, requested_at) < CURRENT_TIMESTAMP - INTERVAL 2 MINUTE)
        OR (status IN ('applying','restarting')
          AND COALESCE(last_progress_at, applying_at, updated_at, claimed_at, requested_at) < CURRENT_TIMESTAMP - INTERVAL 3 MINUTE)`,
    []
  );
  return Number(result.affectedRows || 0);
}

module.exports = {
  ACTIVE_STATUSES,
  claimDeviceUpdate,
  compareVersions,
  confirmDeviceUpdatesFromHeartbeat,
  expireStaleDeviceUpdates,
  queueAllDeviceUpdates,
  queueDeviceUpdate,
  reportDeviceUpdate
};
