const WORKSPACE_DEFINITIONS = Object.freeze({
  finance_withdrawal: Object.freeze({
    key: 'finance_withdrawal',
    name: '店铺提现',
    permissionKey: 'finance.session-manager.manage',
    forbiddenMessage: '当前账号没有店铺提现登录管理权限。'
  }),
  company_store_maintenance: Object.freeze({
    key: 'company_store_maintenance',
    name: '公司店铺维护',
    permissionKey: 'resources.company-store-maintenance.manage',
    forbiddenMessage: '当前账号没有公司店铺维护权限。'
  })
});

const DEFAULT_WORKSPACE_KEY = 'finance_withdrawal';

function normalizeWorkspaceKey(value, { allowDefault = true } = {}) {
  const key = String(value || '').trim();
  if (!key && allowDefault) return DEFAULT_WORKSPACE_KEY;
  return WORKSPACE_DEFINITIONS[key] ? key : null;
}

function workspaceDefinition(value, options) {
  const key = normalizeWorkspaceKey(value, options);
  return key ? WORKSPACE_DEFINITIONS[key] : null;
}

async function resolveWorkspace({ companyId, workspaceKey, query }) {
  const definition = workspaceDefinition(workspaceKey);
  if (!definition) return null;
  const [row] = await query(
    `SELECT id, company_id, workspace_key, name, permission_key
     FROM session_workspaces
     WHERE company_id = ? AND workspace_key = ? AND status = 'active'
     LIMIT 1`,
    [companyId, definition.key]
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    key: row.workspace_key,
    name: row.name,
    permissionKey: row.permission_key,
    forbiddenMessage: definition.forbiddenMessage
  };
}

module.exports = {
  DEFAULT_WORKSPACE_KEY,
  WORKSPACE_DEFINITIONS,
  normalizeWorkspaceKey,
  resolveWorkspace,
  workspaceDefinition
};
