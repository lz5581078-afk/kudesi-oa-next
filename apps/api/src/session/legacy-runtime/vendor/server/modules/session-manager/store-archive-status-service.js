const COMPANY_STORE_MAINTENANCE_WORKSPACE = 'company_store_maintenance';

const STORE_STATUS_LABELS = Object.freeze({
  normal: '正常',
  abnormal: '异常',
  cancelled: '注销',
  inactive: '停用'
});

function httpError(statusCode, errorCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  error.publicMessage = message;
  return error;
}

function workspaceCanManageStoreArchiveStatus(workspace) {
  return String(workspace?.key || '') === COMPANY_STORE_MAINTENANCE_WORKSPACE;
}

async function listStoreAbnormalReasons({ companyId, query }) {
  return query(
    `SELECT id, reason
     FROM store_abnormal_reasons
     WHERE company_id = ? AND status = 'active'
     ORDER BY updated_at DESC, id DESC`,
    [companyId]
  );
}

async function updateManagedStoreArchiveStatus({
  companyId,
  workspaceId,
  storeId,
  employeeId,
  status,
  abnormalReason,
  withTransaction
}) {
  const normalizedStatus = String(status || '').trim();
  if (!Object.prototype.hasOwnProperty.call(STORE_STATUS_LABELS, normalizedStatus)) {
    throw httpError(400, 'invalid_store_status', '店铺状态无效。');
  }
  const normalizedReason = normalizedStatus === 'abnormal' ? String(abnormalReason || '').trim() : '';
  if (normalizedStatus === 'abnormal' && !normalizedReason) {
    throw httpError(400, 'abnormal_reason_required', '店铺状态选择异常时，必须选择异常原因。');
  }

  return withTransaction(async (tx) => {
    const [before] = await tx.query(
      `SELECT store.id, store.name, store.status, store.abnormal_reason
       FROM session_managed_shops managed
       JOIN stores store ON store.id = managed.store_id AND store.company_id = managed.company_id
       WHERE managed.company_id = ? AND managed.workspace_id = ? AND managed.store_id = ?
         AND managed.status = 'active'
       LIMIT 1 FOR UPDATE`,
      [companyId, workspaceId, storeId]
    );
    if (!before) {
      throw httpError(404, 'shop_not_found', '店铺不存在或未加入公司店铺维护。');
    }

    if (normalizedStatus === 'abnormal') {
      const [reason] = await tx.query(
        `SELECT id FROM store_abnormal_reasons
         WHERE company_id = ? AND status = 'active' AND reason = ?
         LIMIT 1`,
        [companyId, normalizedReason]
      );
      if (!reason) {
        throw httpError(400, 'invalid_abnormal_reason', '请选择店铺档案中已有的异常原因。');
      }
    }

    await tx.execute(
      'UPDATE stores SET status = ?, abnormal_reason = ? WHERE id = ? AND company_id = ?',
      [normalizedStatus, normalizedReason, before.id, companyId]
    );
    const after = {
      ...before,
      status: normalizedStatus,
      abnormal_reason: normalizedReason
    };
    await tx.execute(
      `INSERT INTO resource_change_logs
       (resource_type, resource_id, action, actor_id, before_json, after_json, note)
       VALUES ('store', ?, 'updated', ?, CAST(? AS JSON), CAST(? AS JSON), ?)`,
      [
        before.id,
        employeeId || null,
        JSON.stringify(before),
        JSON.stringify(after),
        '公司店铺维护更新店铺状态'
      ]
    );
    return {
      id: Number(before.id),
      name: before.name || '',
      status: normalizedStatus,
      statusLabel: STORE_STATUS_LABELS[normalizedStatus],
      abnormalReason: normalizedReason
    };
  });
}

module.exports = {
  COMPANY_STORE_MAINTENANCE_WORKSPACE,
  STORE_STATUS_LABELS,
  listStoreAbnormalReasons,
  updateManagedStoreArchiveStatus,
  workspaceCanManageStoreArchiveStatus
};
