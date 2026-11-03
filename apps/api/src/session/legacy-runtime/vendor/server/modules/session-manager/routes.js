const express = require('express');
const {
  authenticateAgent,
  createPairing,
  deleteDevice,
  registerDevice,
  restoreDevice,
  revokeDevice,
  updateDeviceRemark
} = require('./device-auth');
const { reportBinding } = require('./session-service');
const { canManageSessionDevices } = require('./permissions');
const { normalizeWorkspaceKey, resolveWorkspace } = require('./workspaces');
const {
  cancelOpenRequest,
  claimNextOpenRequest,
  createOpenRequest,
  expireStaleOpenRequests,
  updateOpenRequest
} = require('./open-request-service');
const { getAuditLogs, getDevices, getOverview, getShopDetail } = require('./overview-service');
const { addManagedShops, assignManagedShop, removeManagedShop, searchAvailableShops } = require('./managed-shop-service');
const { getManagedStoreCredentials, workspaceCanRevealStoreCredentials } = require('./store-credential-service');
const {
  listStoreAbnormalReasons,
  updateManagedStoreArchiveStatus,
  workspaceCanManageStoreArchiveStatus
} = require('./store-archive-status-service');
const { defaultAgentReleaseService } = require('./agent-release-service');
const {
  claimDeviceUpdate,
  compareVersions,
  confirmDeviceUpdatesFromHeartbeat,
  expireStaleDeviceUpdates,
  queueAllDeviceUpdates,
  queueDeviceUpdate,
  reportDeviceUpdate
} = require('./agent-update-service');
const {
  closeManagedBrowserSession,
  createManagedBrowserSession,
  heartbeatManagedBrowserSession
} = require('./managed-browser-session-service');
const {
  claimRemoteWork,
  claimWebRtcWork,
  closeRemoteSession,
  completeRemoteBrowserClose,
  createRemoteSession,
  requestJpegFallback,
  requestWebRtcRecovery,
  failRemoteBrowserClose,
  findActiveManagedBrowserSession,
  getRemoteFrame,
  getRemoteCommand,
  getRemoteSession,
  getWebRtcTicketBinding,
  queueRemoteCommand,
  reportRemoteBrowserCloseProgress,
  reportRemoteCommand,
  reportRemoteError,
  requestRemoteBrowserClose,
  renewRemoteSession,
  terminateRemoteSessionsForBrowser,
  terminateRemoteSessionsForDevice,
  uploadRemoteFrame
} = require('./remote-assistance-service');
const {
  createIceServerCredentials,
  defaultWebRtcTicketStore
} = require('./webrtc-ticket-service');

function releasePayload(release, downloadUrl) {
  return {
    product: release.product,
    version: release.version,
    platform: release.platform,
    fileName: release.fileName,
    size: release.size,
    sha256: release.sha256,
    downloadUrl,
    ...(typeof release.signed === 'boolean' ? { signed: release.signed } : {})
  };
}

function createSessionManagerRouter(deps) {
  const {
    asyncRoute,
    authorizeDeviceManagement,
    agentReleaseService = defaultAgentReleaseService,
    webRtcTicketStore = defaultWebRtcTicketStore,
    webRtcIceProvider = (binding) => createIceServerCredentials({
      binding,
      stunUrls: process.env.WEBRTC_STUN_URLS,
      turnUrls: process.env.WEBRTC_TURN_URLS,
      turnSharedSecret: process.env.WEBRTC_TURN_SHARED_SECRET
    }),
    webRtcIceTransportPolicy = process.env.WEBRTC_FORCE_RELAY === 'true' ? 'relay' : 'all',
    execute,
    encryptBusinessSecret,
    decryptBusinessSecret,
    getRequestCompanyId,
    getRequestEmployeeId,
    query,
    withTransaction
  } = deps;
  const router = express.Router();

  router.use(asyncRoute(async (req, res, next) => {
    if (req.path.startsWith('/agent/')) return next();
    const requestedKey = req.headers['x-session-workspace'] || req.query.workspaceKey;
    const workspaceKey = normalizeWorkspaceKey(requestedKey);
    if (!workspaceKey) {
      return res.status(404).json({ error: 'workspace_not_found', message: '登录管理工作区不存在或未启用。' });
    }
    const workspace = await resolveWorkspace({
      companyId: getRequestCompanyId(req),
      workspaceKey,
      query
    });
    if (!workspace) {
      return res.status(404).json({ error: 'workspace_not_found', message: '登录管理工作区不存在或未启用。' });
    }
    req.sessionWorkspace = workspace;
    return next();
  }));

  async function writeAudit(entry) {
    await execute(
      `INSERT INTO session_audit_logs
        (company_id, workspace_id, employee_id, device_id, store_id, open_request_id, event_type, outcome, summary, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.companyId, entry.workspaceId, entry.employeeId || null, entry.deviceId || null, entry.storeId || null,
        entry.openRequestId || null, entry.eventType, entry.outcome, String(entry.summary || '').slice(0, 500), entry.requestId || null]
    );
  }

  async function requireDeviceManagement(req, res) {
    const companyId = getRequestCompanyId(req);
    const employeeId = getRequestEmployeeId(req);
    const workspace = req.sessionWorkspace;
    const allowed = authorizeDeviceManagement
      ? await authorizeDeviceManagement({ companyId, employeeId, workspace, req })
      : await canManageSessionDevices({ companyId, employeeId, permissionKey: workspace.permissionKey, query });
    if (!allowed) {
      res.status(403).json({ error: 'forbidden', message: workspace.forbiddenMessage });
      return false;
    }
    return true;
  }

  router.use(asyncRoute(async (req, res, next) => {
    if (req.path.startsWith('/agent/')) return next();
    if (!(await requireDeviceManagement(req, res))) return;
    return next();
  }));

  async function authenticatedDevice(req, res) {
    const device = await authenticateAgent({ authorization: req.headers.authorization, query });
    if (!device) {
      res.status(401).json({ error: 'agent_unauthorized', message: '助手认证失败或设备已撤销。' });
      return null;
    }
    return device;
  }

  router.post('/pairings', asyncRoute(async (req, res) => {
    if (!(await requireDeviceManagement(req, res))) return;
    const pairing = await createPairing({
      companyId: getRequestCompanyId(req),
      employeeId: getRequestEmployeeId(req),
      workspaceId: req.sessionWorkspace.id,
      execute
    });
    await writeAudit({ companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id, employeeId: getRequestEmployeeId(req), eventType: 'device_pairing_created', outcome: 'success', summary: '已创建一次性电脑绑定码', requestId: req.requestId });
    res.status(201).json(pairing);
  }));

  router.get('/overview', asyncRoute(async (req, res) => {
    await expireStaleOpenRequests({ companyId: getRequestCompanyId(req), execute });
    const result = await getOverview({
      companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id,
      includeStoreCredentials: workspaceCanRevealStoreCredentials(req.sessionWorkspace),
      assignedDeviceId: req.query.assignedDeviceId || req.query.deviceId,
      keyword: req.query.keyword,
      loginStatus: req.query.loginStatus || req.query.status,
      storeStatus: workspaceCanManageStoreArchiveStatus(req.sessionWorkspace) ? req.query.storeStatus : 'all',
      sort: req.query.sort, page: req.query.page, pageSize: req.query.pageSize, query
    });
    res.json(result);
  }));

  router.get('/shop-candidates', asyncRoute(async (req, res) => {
    const shops = await searchAvailableShops({
      companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id, keyword: req.query.keyword, query
    });
    res.json({ shops });
  }));

  router.get('/store-abnormal-reasons', asyncRoute(async (req, res) => {
    if (!workspaceCanManageStoreArchiveStatus(req.sessionWorkspace)) {
      return res.status(404).json({ error: 'store_status_management_not_available', message: '当前工作区不提供店铺档案状态管理。' });
    }
    const reasons = await listStoreAbnormalReasons({ companyId: getRequestCompanyId(req), query });
    res.json({ reasons });
  }));

  router.patch('/shops/:id/archive-status', asyncRoute(async (req, res) => {
    if (!workspaceCanManageStoreArchiveStatus(req.sessionWorkspace)) {
      return res.status(404).json({ error: 'store_status_management_not_available', message: '当前工作区不提供店铺档案状态管理。' });
    }
    const companyId = getRequestCompanyId(req);
    const employeeId = getRequestEmployeeId(req);
    const store = await updateManagedStoreArchiveStatus({
      companyId,
      workspaceId: req.sessionWorkspace.id,
      storeId: req.params.id,
      employeeId,
      status: req.body?.status,
      abnormalReason: req.body?.abnormalReason,
      withTransaction
    });
    await writeAudit({
      companyId,
      workspaceId: req.sessionWorkspace.id,
      employeeId,
      storeId: store.id,
      eventType: 'store_archive_status_updated',
      outcome: 'success',
      summary: `店铺档案状态已更新为${store.statusLabel}${store.abnormalReason ? `：${store.abnormalReason}` : ''}`,
      requestId: req.requestId
    });
    res.json({ ok: true, store });
  }));

  router.post('/managed-shops', asyncRoute(async (req, res) => {
    if (!(await requireDeviceManagement(req, res))) return;
    const companyId = getRequestCompanyId(req);
    const employeeId = getRequestEmployeeId(req);
    const result = await addManagedShops({
      companyId,
      workspaceId: req.sessionWorkspace.id,
      employeeId,
      storeIds: req.body?.storeIds,
      assignedDeviceId: req.body?.assignedDeviceId,
      withTransaction
    });
    await writeAudit({
      companyId, workspaceId: req.sessionWorkspace.id, employeeId, deviceId: result.assignedDevice.id,
      eventType: 'managed_shops_added', outcome: 'success',
      summary: `已将 ${result.selected} 家店铺加入登录态管理并分配给“${result.assignedDevice.name}”`, requestId: req.requestId
    });
    res.status(201).json(result);
  }));

  router.patch('/managed-shops/:storeId/assigned-device', asyncRoute(async (req, res) => {
    if (!(await requireDeviceManagement(req, res))) return;
    const companyId = getRequestCompanyId(req);
    const employeeId = getRequestEmployeeId(req);
    const result = await assignManagedShop({
      companyId,
      workspaceId: req.sessionWorkspace.id,
      employeeId,
      storeId: req.params.storeId,
      deviceId: req.body?.deviceId,
      expectedDeviceId: req.body?.expectedDeviceId,
      withTransaction
    });
    if (result.changed) {
      await writeAudit({
        companyId,
        workspaceId: req.sessionWorkspace.id,
        employeeId,
        deviceId: result.assignedDevice?.id || result.previousDeviceId,
        storeId: result.storeId,
        eventType: result.assignedDevice ? 'managed_shop_assigned' : 'managed_shop_unassigned',
        outcome: 'success',
        summary: result.assignedDevice
          ? `已将店铺“${result.storeName}”分配给“${result.assignedDevice.name}”`
          : `已取消店铺“${result.storeName}”的负责电脑`,
        requestId: req.requestId
      });
    }
    res.json(result);
  }));

  router.delete('/managed-shops/:storeId', asyncRoute(async (req, res) => {
    if (!(await requireDeviceManagement(req, res))) return;
    const companyId = getRequestCompanyId(req);
    const employeeId = getRequestEmployeeId(req);
    try {
      const result = await removeManagedShop({
        companyId,
        workspaceId: req.sessionWorkspace.id,
        employeeId,
        storeId: req.params.storeId,
        withTransaction
      });
      await writeAudit({
        companyId,
        workspaceId: req.sessionWorkspace.id,
        employeeId,
        storeId: result.storeId,
        eventType: 'managed_shop_removed',
        outcome: 'success',
        summary: `已将店铺“${result.storeName}”从登录态管理列表移除，保留授权电脑本机 Profile 和历史记录`,
        requestId: req.requestId
      });
      res.json(result);
    } catch (error) {
      if (Number(error.statusCode) === 409) {
        await writeAudit({
          companyId,
          workspaceId: req.sessionWorkspace.id,
          employeeId,
          eventType: 'managed_shop_remove_blocked',
          outcome: 'failed',
          summary: '店铺存在正在执行的打开任务，本次移除已阻止',
          requestId: req.requestId
        });
      }
      throw error;
    }
  }));

  router.patch('/managed-shops/:storeId/auto-login', asyncRoute(async (req, res) => {
    if (!workspaceCanRevealStoreCredentials(req.sessionWorkspace)) {
      return res.status(404).json({ error: 'auto_login_not_available', message: '当前工作区不提供店铺自动登录。' });
    }
    const companyId = getRequestCompanyId(req);
    const employeeId = getRequestEmployeeId(req);
    const storeId = Number(req.params.storeId);
    const enabled = req.body?.enabled === true;
    if (!Number.isInteger(storeId) || storeId <= 0) {
      return res.status(400).json({ error: 'invalid_store_id', message: '店铺编号无效。' });
    }
    const [managed] = await query(
      `SELECT managed.id, managed.withdrawal_login_account,
              CASE WHEN managed.withdrawal_login_password IS NOT NULL AND managed.withdrawal_login_password <> '' THEN 1 ELSE 0 END AS has_withdrawal_login_password
       FROM session_managed_shops managed
       WHERE managed.company_id = ? AND managed.workspace_id = ? AND managed.store_id = ? AND managed.status = 'active'
       LIMIT 1`,
      [companyId, req.sessionWorkspace.id, storeId]
    );
    if (!managed) return res.status(404).json({ error: 'shop_not_found', message: '店铺不存在或未加入登录管理。' });
    if (enabled && (!String(managed.withdrawal_login_account || '').trim() || !Number(managed.has_withdrawal_login_password))) {
      return res.status(409).json({ error: 'withdrawal_credentials_incomplete', message: '请先在当前店铺列表中完整填写登录账号和密码。' });
    }
    await execute(
      `UPDATE session_managed_shops SET auto_login_enabled = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ? AND workspace_id = ?`,
      [enabled ? 1 : 0, managed.id, companyId, req.sessionWorkspace.id]
    );
    await writeAudit({
      companyId,
      workspaceId: req.sessionWorkspace.id,
      employeeId,
      storeId,
      eventType: enabled ? 'store_auto_login_enabled' : 'store_auto_login_disabled',
      outcome: 'success',
      summary: enabled ? '已开启店铺账号密码自动登录' : '已关闭店铺账号密码自动登录',
      requestId: req.requestId
    });
    res.json({ storeId, autoLoginEnabled: enabled });
  }));

  router.patch('/managed-shops/:storeId/login-credentials', asyncRoute(async (req, res) => {
    if (!workspaceCanRevealStoreCredentials(req.sessionWorkspace)) {
      return res.status(404).json({ error: 'login_credentials_not_available', message: '当前工作区不提供登录账号管理。' });
    }
    if (typeof encryptBusinessSecret !== 'function') throw new Error('Business secret encryption is not configured.');
    const companyId = getRequestCompanyId(req);
    const employeeId = getRequestEmployeeId(req);
    const storeId = Number(req.params.storeId);
    const account = String(req.body?.account || '').trim();
    const password = String(req.body?.password || '');
    const clearPassword = req.body?.clearPassword === true;
    const credentialScope = req.sessionWorkspace.key === 'finance_withdrawal' ? '店铺提现专用运营' : '公司店铺维护登录';
    const auditPrefix = req.sessionWorkspace.key === 'finance_withdrawal' ? 'withdrawal_login' : 'maintenance_login';
    if (!Number.isInteger(storeId) || storeId <= 0) {
      return res.status(400).json({ error: 'invalid_store_id', message: '店铺编号无效。' });
    }
    if (account.length > 190) return res.status(400).json({ error: 'account_too_long', message: '登录账号不能超过 190 个字符。' });
    if (password.length > 512) return res.status(400).json({ error: 'password_too_long', message: '登录密码不能超过 512 个字符。' });
    const [managed] = await query(
      `SELECT id, withdrawal_login_account, withdrawal_login_password, auto_login_enabled FROM session_managed_shops
        WHERE company_id = ? AND workspace_id = ? AND store_id = ? AND status = 'active' LIMIT 1`,
      [companyId, req.sessionWorkspace.id, storeId]
    );
    if (!managed) return res.status(404).json({ error: 'shop_not_found', message: '店铺不存在或未加入登录管理。' });
    if (!account || clearPassword) {
      await execute(
        `UPDATE session_managed_shops
         SET withdrawal_login_account = ?, withdrawal_login_password = NULL,
             auto_login_enabled = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND company_id = ? AND workspace_id = ?`,
        [account, managed.id, companyId, req.sessionWorkspace.id]
      );
      await writeAudit({
        companyId, workspaceId: req.sessionWorkspace.id, employeeId, storeId,
        eventType: `${auditPrefix}_credentials_cleared`, outcome: 'success',
        summary: `已清除${credentialScope}凭据并关闭自动登录`, requestId: req.requestId
      });
      return res.json({
        storeId,
        withdrawalLoginAccount: account,
        hasWithdrawalLoginPassword: false,
        autoLoginEnabled: false,
        autoLoginEnabledByDefault: false
      });
    }
    if (!password && !managed.withdrawal_login_password) {
      return res.status(400).json({ error: 'password_required', message: '请填写登录密码。' });
    }
    const hadCompleteCredentials = Boolean(
      String(managed.withdrawal_login_account || '').trim() && managed.withdrawal_login_password
    );
    const autoLoginEnabled = Boolean(Number(managed.auto_login_enabled || 0)) || !hadCompleteCredentials;
    await execute(
      `UPDATE session_managed_shops
       SET withdrawal_login_account = ?, withdrawal_login_password = ?, auto_login_enabled = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND company_id = ? AND workspace_id = ?`,
      [
        account,
        password ? encryptBusinessSecret(password) : managed.withdrawal_login_password,
        autoLoginEnabled ? 1 : 0,
        managed.id,
        companyId,
        req.sessionWorkspace.id
      ]
    );
    await writeAudit({
      companyId, workspaceId: req.sessionWorkspace.id, employeeId, storeId,
      eventType: `${auditPrefix}_credentials_updated`, outcome: 'success',
      summary: hadCompleteCredentials
        ? `已更新${credentialScope}账号凭据`
        : `已更新${credentialScope}账号凭据并默认开启自动登录`,
      requestId: req.requestId
    });
    res.json({
      storeId,
      withdrawalLoginAccount: account,
      hasWithdrawalLoginPassword: true,
      autoLoginEnabled,
      autoLoginEnabledByDefault: !hadCompleteCredentials
    });
  }));

  router.get('/devices', asyncRoute(async (req, res) => {
    await expireStaleDeviceUpdates({ execute });
    res.json({ devices: await getDevices({ companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id, query }) });
  }));

  router.get('/shops/:id', asyncRoute(async (req, res) => {
    const shop = await getShopDetail({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      storeId: req.params.id,
      historyLimit: req.query.historyLimit,
      query
    });
    if (!shop) return res.status(404).json({ error: 'shop_not_found', message: '店铺不存在。' });
    res.json({ shop });
  }));

  router.post('/shops/:id/credentials/reveal', asyncRoute(async (req, res) => {
    if (!workspaceCanRevealStoreCredentials(req.sessionWorkspace)) {
      return res.status(404).json({ error: 'credential_access_not_available', message: '当前工作区不提供登录账号密码。' });
    }
    const purpose = String(req.body?.purpose || 'view');
    if (!['view', 'copy'].includes(purpose)) {
      return res.status(400).json({ error: 'invalid_credential_purpose', message: '密码查看用途无效。' });
    }
    const companyId = getRequestCompanyId(req);
    const employeeId = getRequestEmployeeId(req);
    const credentials = await getManagedStoreCredentials({
      companyId,
      workspaceId: req.sessionWorkspace.id,
      storeId: req.params.id,
      decryptBusinessSecret,
      query
    });
    if (!credentials) {
      return res.status(404).json({ error: 'shop_not_found', message: '店铺不存在或未加入当前工作区登录管理。' });
    }
    const auditPrefix = req.sessionWorkspace.key === 'finance_withdrawal' ? 'withdrawal_login' : 'maintenance_login';
    const passwordLabel = req.sessionWorkspace.key === 'finance_withdrawal' ? '提现运营密码' : '维护登录密码';
    await writeAudit({
      companyId,
      workspaceId: req.sessionWorkspace.id,
      employeeId,
      storeId: credentials.storeId,
      eventType: purpose === 'copy' ? `${auditPrefix}_password_copy_requested` : `${auditPrefix}_password_viewed`,
      outcome: 'success',
      summary: purpose === 'copy' ? `管理人员读取${passwordLabel}用于复制` : `管理人员查看${passwordLabel}`,
      requestId: req.requestId
    });
    res.set('Cache-Control', 'no-store');
    res.json({ credentials });
  }));

  router.get('/audit-logs', asyncRoute(async (req, res) => {
    const logs = await getAuditLogs({ companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id, storeId: req.query.storeId, deviceId: req.query.deviceId, limit: req.query.limit, query });
    res.json({ logs });
  }));

  router.get('/browser-sessions/active', asyncRoute(async (req, res) => {
    const browserSession = await findActiveManagedBrowserSession({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      userId: getRequestEmployeeId(req),
      shopId: req.query.shopId,
      deviceId: req.query.deviceId,
      query
    });
    res.json({ browserSession });
  }));

  router.post('/remote-sessions', asyncRoute(async (req, res) => {
    const session = await createRemoteSession({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      userId: getRequestEmployeeId(req),
      browserSessionId: req.body?.browserSessionId,
      deviceId: req.body?.deviceId,
      shopId: req.body?.shopId,
      withTransaction
    });
    res.status(201).json(session);
  }));

  router.post('/remote-sessions/:id/webrtc-ticket', asyncRoute(async (req, res) => {
    const binding = await getWebRtcTicketBinding({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      userId: getRequestEmployeeId(req),
      sessionId: req.params.id,
      query
    });
    const issued = webRtcTicketStore.issue({ role: 'viewer', binding });
    res.status(201).json({
      ...issued,
      role: 'viewer',
      signalingPath: '/api/session-manager/webrtc',
      iceServers: webRtcIceProvider(binding),
      iceTransportPolicy: webRtcIceTransportPolicy
    });
  }));

  router.get('/remote-sessions/:id', asyncRoute(async (req, res) => {
    res.json(await getRemoteSession({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      userId: getRequestEmployeeId(req),
      sessionId: req.params.id,
      query,
      execute
    }));
  }));

  router.post('/remote-sessions/:id/heartbeat', asyncRoute(async (req, res) => {
    res.json(await renewRemoteSession({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      userId: getRequestEmployeeId(req),
      sessionId: req.params.id,
      execute
    }));
  }));

  router.post('/remote-sessions/:id/jpeg-fallback', asyncRoute(async (req, res) => {
    res.json(await requestJpegFallback({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      userId: getRequestEmployeeId(req),
      sessionId: req.params.id,
      withTransaction
    }));
  }));

  router.post('/remote-sessions/:id/webrtc-recover', asyncRoute(async (req, res) => {
    res.json(await requestWebRtcRecovery({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      userId: getRequestEmployeeId(req),
      sessionId: req.params.id,
      withTransaction
    }));
  }));

  router.post('/remote-sessions/:id/end', asyncRoute(async (req, res) => {
    res.json(await closeRemoteSession({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      userId: getRequestEmployeeId(req),
      sessionId: req.params.id,
      withTransaction
    }));
  }));

  router.delete('/remote-sessions/:id', asyncRoute(async (req, res) => {
    const result = await requestRemoteBrowserClose({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      userId: getRequestEmployeeId(req),
      sessionId: req.params.id,
      withTransaction
    });
    await writeAudit({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      employeeId: getRequestEmployeeId(req),
      deviceId: result.deviceId,
      storeId: result.shopId,
      eventType: 'shop_browser_close_requested',
      outcome: result.status === 'ended' ? 'success' : 'pending',
      summary: result.status === 'ended' ? '店铺浏览器已经安全关闭' : '已请求 Windows 助手安全关闭店铺浏览器'
    });
    res.json(result);
  }));

  router.get('/remote-sessions/:id/frame', asyncRoute(async (req, res) => {
    const frame = await getRemoteFrame({
      companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id,
      userId: getRequestEmployeeId(req),
      sessionId: req.params.id,
      query
    });
    if (!frame.frame_data) return res.status(204).end();
    res.set({
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': frame.frame_mime || 'image/jpeg',
      'X-Frame-Sequence': String(frame.frame_sequence || 0),
      'X-Frame-Width': String(frame.frame_width || 0),
      'X-Frame-Height': String(frame.frame_height || 0)
    });
    res.send(frame.frame_data);
  }));

  router.post('/remote-sessions/:id/commands', asyncRoute(async (req, res) => {
    const command = await queueRemoteCommand({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      userId: getRequestEmployeeId(req),
      sessionId: req.params.id,
      body: req.body,
      query,
      execute
    });
    res.status(201).json(command);
  }));

  router.get('/remote-sessions/:id/commands/:commandId', asyncRoute(async (req, res) => {
    res.json(await getRemoteCommand({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      userId: getRequestEmployeeId(req),
      sessionId: req.params.id,
      commandId: req.params.commandId,
      query
    }));
  }));

  router.get('/releases/windows/latest', asyncRoute(async (req, res) => {
    if (!(await requireDeviceManagement(req, res))) return;
    const release = await agentReleaseService.getLatestInstaller();
    res.json(releasePayload(release, '/api/session-manager/releases/windows/download'));
  }));

  router.get('/releases/windows/download', asyncRoute(async (req, res) => {
    if (!(await requireDeviceManagement(req, res))) return;
    await agentReleaseService.sendLatestInstaller(res);
  }));

  router.post('/devices/update-all', asyncRoute(async (req, res) => {
    if (!(await requireDeviceManagement(req, res))) return;
    const release = await agentReleaseService.getLatestUpdate();
    const result = await queueAllDeviceUpdates({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      employeeId: getRequestEmployeeId(req),
      targetVersion: release.version,
      query,
      execute
    });
    await writeAudit({ companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id, employeeId: getRequestEmployeeId(req), eventType: 'agent_update_all_queued', outcome: 'success', summary: `已为 ${result.pending} 台电脑安排升级到 v${release.version}`, requestId: req.requestId });
    res.status(202).json(result);
  }));

  router.post('/devices/:id/update', asyncRoute(async (req, res) => {
    if (!(await requireDeviceManagement(req, res))) return;
    const release = await agentReleaseService.getLatestUpdate();
    const result = await queueDeviceUpdate({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      employeeId: getRequestEmployeeId(req),
      deviceId: req.params.id,
      targetVersion: release.version,
      query,
      execute
    });
    await writeAudit({ companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id, employeeId: getRequestEmployeeId(req), deviceId: req.params.id, eventType: 'agent_update_queued', outcome: 'success', summary: `已安排升级到 Windows 助手 v${release.version}`, requestId: req.requestId });
    res.status(202).json(result);
  }));

  router.post('/agent/register', asyncRoute(async (req, res) => {
    const registration = await registerDevice({
      pairingCode: req.body?.pairingCode,
      device: req.body,
      withTransaction
    });
    const [registeredDevice] = await query('SELECT company_id, workspace_id FROM session_devices WHERE id = ? LIMIT 1', [registration.deviceId]);
    if (registeredDevice) {
      await writeAudit({ companyId: registeredDevice.company_id, workspaceId: registeredDevice.workspace_id, deviceId: registration.deviceId, eventType: 'device_registered', outcome: 'success', summary: 'Windows 助手已使用一次性绑定码完成电脑绑定' });
    }
    res.status(201).json(registration);
  }));

  router.post('/agent/heartbeat', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    const agentVersion = String(req.body?.agentVersion || device.agentVersion || '').trim().slice(0, 40);
    await execute(
      `UPDATE session_devices
       SET agent_version = ?, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'active'`,
      [agentVersion, device.id]
    );
    await confirmDeviceUpdatesFromHeartbeat({ deviceId: device.id, agentVersion, execute });
    const currentRequestId = /^[0-9a-f-]{36}$/i.test(String(req.body?.currentRequestId || ''))
      ? String(req.body.currentRequestId)
      : null;
    const activeBrowserSessionIds = Array.isArray(req.body?.activeBrowserSessionIds)
      ? req.body.activeBrowserSessionIds.filter((id) => /^[0-9a-f-]{36}$/i.test(String(id))).slice(0, 100)
      : [];
    for (const browserSessionId of activeBrowserSessionIds) {
      await execute(
        `UPDATE managed_browser_sessions
         SET last_agent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND company_id = ? AND workspace_id = ? AND device_id = ? AND status = 'open'`,
        [browserSessionId, device.companyId, device.workspaceId, device.id]
      );
    }
    let stopCurrentJob = false;
    if (currentRequestId) {
      const [request] = await query(
        `SELECT status FROM session_open_requests
         WHERE id = ? AND company_id = ? AND workspace_id = ? AND target_device_id = ? LIMIT 1`,
        [currentRequestId, device.companyId, device.workspaceId, device.id]
      );
      stopCurrentJob = request?.status === 'cancelled';
    }
    res.json({
      ok: true,
      authorized: true,
      deviceId: device.id,
      serverTime: new Date().toISOString(),
      stopCurrentJob,
      currentRequestId
    });
  }));

  router.post('/agent/browser-sessions', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    const browserSession = await createManagedBrowserSession({
      device,
      openRequestId: req.body?.openRequestId,
      storeId: req.body?.storeId,
      localProfileId: req.body?.localProfileId,
      platformCode: req.body?.platformCode,
      pageUrl: req.body?.pageUrl,
      withTransaction
    });
    res.status(201).json(browserSession);
  }));

  router.patch('/agent/browser-sessions/:id', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    const action = String(req.body?.action || 'heartbeat');
    if (action === 'heartbeat') {
      return res.json(await heartbeatManagedBrowserSession({
        device,
        browserSessionId: req.params.id,
        pageUrl: req.body?.pageUrl,
        execute
      }));
    }
    if (!['closed', 'error'].includes(action)) {
      return res.status(400).json({ error: 'invalid_browser_session_action', message: '浏览器会话操作无效。' });
    }
    const result = await closeManagedBrowserSession({
      device,
      browserSessionId: req.params.id,
      status: action,
      execute
    });
    await terminateRemoteSessionsForBrowser({ device, browserSessionId: req.params.id, withTransaction });
    res.json(result);
  }));

  router.get('/agent/remote', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    res.json(req.query.transport === 'webrtc'
      ? await claimWebRtcWork({ device, withTransaction })
      : await claimRemoteWork({ device, withTransaction }));
  }));

  router.post('/agent/remote-sessions/:id/webrtc-ticket', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    const binding = await getWebRtcTicketBinding({
      companyId: device.companyId,
      workspaceId: device.workspaceId,
      deviceId: device.id,
      sessionId: req.params.id,
      query
    });
    const issued = webRtcTicketStore.issue({ role: 'agent', binding });
    res.status(201).json({
      ...issued,
      role: 'agent',
      signalingPath: '/api/session-manager/webrtc',
      iceServers: webRtcIceProvider(binding),
      iceTransportPolicy: webRtcIceTransportPolicy
    });
  }));

  router.post('/agent/remote', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    const action = String(req.body?.action || '');
    if (action === 'browser_close_progress') {
      return res.json(await reportRemoteBrowserCloseProgress({
        device,
        sessionId: req.body?.sessionId,
        stage: req.body?.stage,
        execute
      }));
    }
    if (action === 'browser_closed') {
      const result = await completeRemoteBrowserClose({
        device,
        sessionId: req.body?.sessionId,
        browserSessionId: req.body?.browserSessionId,
        shopId: req.body?.shopId,
        localProfileId: req.body?.localProfileId,
        withTransaction
      });
      await writeAudit({
        companyId: device.companyId,
        workspaceId: device.workspaceId,
        deviceId: device.id,
        storeId: req.body?.shopId,
        eventType: 'shop_browser_closed',
        outcome: 'success',
        summary: 'Windows 助手已安全关闭店铺浏览器并保留独立 Profile'
      });
      return res.json(result);
    }
    if (action === 'browser_close_failed') {
      const result = await failRemoteBrowserClose({
        device,
        sessionId: req.body?.sessionId,
        error: req.body?.error,
        execute
      });
      await writeAudit({
        companyId: device.companyId,
        workspaceId: device.workspaceId,
        deviceId: device.id,
        storeId: req.body?.shopId,
        eventType: 'shop_browser_close_failed',
        outcome: 'failed',
        summary: 'Windows 助手回报店铺浏览器安全关闭失败'
      });
      return res.json(result);
    }
    if (action === 'error') {
      return res.json(await reportRemoteError({
        device,
        sessionId: req.body?.sessionId,
        error: req.body?.error,
        execute
      }));
    }
    if (action !== 'frame') {
      return res.status(400).json({ error: 'invalid_remote_report', message: '远程协助回报无效。' });
    }
    res.json(await uploadRemoteFrame({
      device,
      sessionId: req.body?.sessionId,
      pageUrl: req.body?.pageUrl,
      width: req.body?.width,
      height: req.body?.height,
      frameBase64: req.body?.frame,
      query,
      execute
    }));
  }));

  router.patch('/agent/remote', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    res.json(await reportRemoteCommand({
      device,
      commandId: req.body?.commandId,
      ok: req.body?.ok === true,
      error: req.body?.error,
      execute
    }));
  }));

  router.get('/agent/releases/windows/latest', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    const release = await agentReleaseService.getLatestUpdate(device.agentVersion);
    res.json(releasePayload(release, '/api/session-manager/agent/releases/windows/download'));
  }));

  router.get('/agent/releases/windows/download', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    await agentReleaseService.sendLatestUpdate(res, device.agentVersion);
  }));

  router.get('/agent/update-jobs', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    await expireStaleDeviceUpdates({ execute });
    const job = await claimDeviceUpdate({ device, query, execute });
    if (!job) return res.json({ job: null });
    const release = await agentReleaseService.getLatestUpdate(device.agentVersion);
    if (compareVersions(device.agentVersion, release.minimumUpdaterVersion) < 0) {
      await reportDeviceUpdate({
        device,
        jobId: job.id,
        status: 'repair_required',
        phase: 'repair_required',
        failureCode: 'updater_protocol_incompatible',
        errorMessage: `当前助手 v${device.agentVersion} 的更新启动器不兼容，需要在该电脑手动运行一次修复工具。`,
        execute
      });
      return res.json({ job: null, repairRequired: true });
    }
    if (release.version !== job.targetVersion) {
      await reportDeviceUpdate({ device, jobId: job.id, status: 'failed', errorMessage: '目标版本已不再是当前发布版本，请重新下发升级。', execute });
      return res.json({ job: null });
    }
    await execute(
      `UPDATE session_agent_update_jobs SET package_type = ?, phase = 'claimed', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ? AND workspace_id = ? AND device_id = ? AND status = 'claimed'`,
      [release.packageType || 'full', job.id, device.companyId, device.workspaceId, device.id]
    );
    res.json({ job: { ...job, packageType: release.packageType || 'full', fileName: release.fileName, size: release.size, sha256: release.sha256, downloadUrl: '/api/session-manager/agent/releases/windows/download' } });
  }));

  router.post('/agent/update-jobs/request', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    const release = await agentReleaseService.getLatestUpdate();
    res.json(await queueDeviceUpdate({
      companyId: device.companyId,
      workspaceId: device.workspaceId,
      employeeId: null,
      deviceId: device.id,
      targetVersion: release.version,
      query,
      execute
    }));
  }));

  router.patch('/agent/update-jobs/:id', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    res.json(await reportDeviceUpdate({
      device,
      jobId: req.params.id,
      status: String(req.body?.status || ''),
      errorMessage: req.body?.errorMessage,
      phase: req.body?.phase,
      progress: req.body?.progress,
      downloadedBytes: req.body?.downloadedBytes,
      totalBytes: req.body?.totalBytes,
      failureCode: req.body?.failureCode,
      execute
    }));
  }));

  router.get('/agent/sessions', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    res.json({ mode: 'local_only', disabled: true, sessions: [] });
  }));

  router.post('/agent/sessions', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    res.status(410).json({
      error: 'cloud_session_disabled',
      message: '登录态仅保存在授权电脑本机。',
      mode: 'local_only',
      disabled: true,
      accepted: false
    });
  }));

  router.get('/agent/device-keys', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    res.json({
      mode: 'local_only',
      disabled: true,
      devices: [],
      latestSession: null
    });
  }));

  router.post('/agent/bindings', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    const result = await reportBinding({ device, binding: req.body, query, execute });
    res.json(result);
  }));

  router.post('/open-requests', asyncRoute(async (req, res) => {
    const result = await createOpenRequest({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      employeeId: getRequestEmployeeId(req),
      storeId: req.body?.storeId,
      deviceId: req.body?.deviceId,
      query,
      withTransaction
    });
    await writeAudit({ companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id, employeeId: getRequestEmployeeId(req), deviceId: result.deviceId, storeId: req.body?.storeId, openRequestId: result.id, eventType: 'shop_open_requested', outcome: 'success', summary: '网页已通过 OA 服务器向 Windows 助手派发打开店铺请求', requestId: req.requestId });
    res.status(201).json(result);
  }));

  router.get('/open-requests/:id', asyncRoute(async (req, res) => {
    await expireStaleOpenRequests({ companyId: getRequestCompanyId(req), execute });
    const [request] = await query(
      `SELECT id, store_id, target_device_id, status, progress, current_step, error_code, error_message,
              created_at, started_at, completed_at, updated_at
       FROM session_open_requests WHERE id = ? AND company_id = ? AND workspace_id = ? LIMIT 1`,
      [req.params.id, getRequestCompanyId(req), req.sessionWorkspace.id]
    );
    if (!request) return res.status(404).json({ error: 'request_not_found', message: '打开请求不存在。' });
    res.json({ request: {
      id: request.id, storeId: request.store_id, deviceId: request.target_device_id,
      status: request.status, progress: Number(request.progress || 0), currentStep: request.current_step || '',
      errorCode: request.error_code || '', errorMessage: request.error_message || '',
      createdAt: request.created_at, startedAt: request.started_at, completedAt: request.completed_at, updatedAt: request.updated_at
    } });
  }));

  router.delete('/open-requests/:id', asyncRoute(async (req, res) => {
    const cancelled = await cancelOpenRequest({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      requestId: req.params.id,
      execute
    });
    if (!cancelled) return res.status(404).json({ error: 'request_not_found', message: '打开请求不存在或已经结束。' });
    await writeAudit({ companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id, employeeId: getRequestEmployeeId(req), openRequestId: req.params.id, eventType: 'shop_open_cancelled', outcome: 'success', summary: '用户取消了打开店铺请求', requestId: req.requestId });
    res.json({ ok: true });
  }));

  router.get('/agent/open-requests', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    const request = await claimNextOpenRequest({ device, withTransaction });
    if (request && workspaceCanRevealStoreCredentials({ key: request.workspace_key }) && Number(request.auto_login_enabled) === 1) {
      try {
        const credentials = await getManagedStoreCredentials({
          companyId: device.companyId,
          workspaceId: device.workspaceId,
          storeId: request.store_id,
          decryptBusinessSecret,
          query
        });
        request.login_credentials = credentials ? { account: credentials.account, password: credentials.password } : null;
        if (request.login_credentials?.account && request.login_credentials?.password) {
          await writeAudit({
            companyId: device.companyId,
            workspaceId: device.workspaceId,
            deviceId: device.id,
            storeId: request.store_id,
            openRequestId: request.id,
            eventType: 'store_auto_login_credentials_delivered',
            outcome: 'success',
            summary: '已向受授权电脑一次性下发店铺登录凭据',
            requestId: req.requestId
          });
        }
      } catch (_error) {
        // Credential problems must not prevent the browser from opening for manual login.
        request.login_credentials = null;
      }
    } else if (request) request.login_credentials = null;
    res.set('Cache-Control', 'no-store');
    res.json({ request });
  }));

  router.patch('/agent/open-requests/:id', asyncRoute(async (req, res) => {
    const device = await authenticatedDevice(req, res);
    if (!device) return;
    const result = await updateOpenRequest({
      device,
      requestId: req.params.id,
      update: req.body,
      withTransaction
    });
    res.json(result);
  }));

  router.patch('/devices/:id/revoke', asyncRoute(async (req, res) => {
    if (!(await requireDeviceManagement(req, res))) return;
    const revoked = await revokeDevice({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      deviceId: req.params.id,
      execute
    });
    if (!revoked) return res.status(404).json({ error: 'device_not_found', message: '设备不存在、已撤销或不属于当前企业。' });
    await terminateRemoteSessionsForDevice({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      deviceId: req.params.id,
      withTransaction
    });
    await writeAudit({ companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id, employeeId: getRequestEmployeeId(req), deviceId: req.params.id, eventType: 'device_revoked', outcome: 'success', summary: '已撤销电脑授权', requestId: req.requestId });
    res.json({ ok: true });
  }));

  router.patch('/devices/:id/restore', asyncRoute(async (req, res) => {
    if (!(await requireDeviceManagement(req, res))) return;
    const restored = await restoreDevice({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      deviceId: req.params.id,
      execute
    });
    if (!restored) return res.status(404).json({ error: 'device_not_found', message: '设备不存在、未撤销或不属于当前企业。' });
    await writeAudit({ companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id, employeeId: getRequestEmployeeId(req), deviceId: req.params.id, eventType: 'device_restored', outcome: 'success', summary: '已恢复电脑授权，等待助手重新连接', requestId: req.requestId });
    res.json({ ok: true });
  }));

  router.patch('/devices/:id/remark', asyncRoute(async (req, res) => {
    if (!(await requireDeviceManagement(req, res))) return;
    const companyId = getRequestCompanyId(req);
    const workspaceId = req.sessionWorkspace.id;
    const device = await updateDeviceRemark({
      companyId,
      workspaceId,
      deviceId: req.params.id,
      remark: req.body?.remark,
      query,
      execute
    });
    if (!device) return res.status(404).json({ error: 'device_not_found', message: '设备不存在、已删除或不属于当前工作区。' });
    await writeAudit({
      companyId,
      workspaceId,
      employeeId: getRequestEmployeeId(req),
      deviceId: device.id,
      eventType: 'device_remark_updated',
      outcome: 'success',
      summary: device.remark ? `已将电脑备注更新为“${device.remark}”` : '已清除电脑备注',
      requestId: req.requestId
    });
    res.json({ device });
  }));

  router.delete('/devices/:id', asyncRoute(async (req, res) => {
    if (!(await requireDeviceManagement(req, res))) return;
    const [assignment] = await query(
      `SELECT COUNT(*) AS count FROM session_managed_shops
       WHERE company_id = ? AND workspace_id = ? AND assigned_device_id = ? AND status = 'active'`,
      [getRequestCompanyId(req), req.sessionWorkspace.id, req.params.id]
    );
    if (Number(assignment?.count || 0) > 0) {
      return res.status(409).json({
        error: 'device_has_assignments',
        message: `该电脑仍负责 ${Number(assignment.count)} 家店铺，请先完成改绑或取消分配。`
      });
    }
    const deleted = await deleteDevice({
      companyId: getRequestCompanyId(req),
      workspaceId: req.sessionWorkspace.id,
      deviceId: req.params.id,
      execute
    });
    if (!deleted) return res.status(404).json({ error: 'device_not_found', message: '设备不存在、未撤销或不属于当前企业。' });
    await writeAudit({ companyId: getRequestCompanyId(req), workspaceId: req.sessionWorkspace.id, employeeId: getRequestEmployeeId(req), deviceId: req.params.id, eventType: 'device_deleted', outcome: 'success', summary: '已从授权电脑列表隐藏撤销设备，历史记录继续保留', requestId: req.requestId });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createSessionManagerRouter };
