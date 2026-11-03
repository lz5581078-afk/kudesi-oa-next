const STORE_CREDENTIAL_WORKSPACES = new Set(['finance_withdrawal', 'company_store_maintenance']);

function workspaceCanRevealStoreCredentials(workspace) {
  return STORE_CREDENTIAL_WORKSPACES.has(String(workspace?.key || ''));
}

async function getManagedStoreCredentials({ companyId, workspaceId, storeId, decryptBusinessSecret, query }) {
  const [row] = await query(
    `SELECT managed.store_id, managed.withdrawal_login_account, managed.withdrawal_login_password
     FROM session_managed_shops managed
     WHERE managed.company_id = ? AND managed.workspace_id = ? AND managed.store_id = ?
       AND managed.status = 'active'
     LIMIT 1`,
    [companyId, workspaceId, storeId]
  );
  if (!row) return null;
  if (typeof decryptBusinessSecret !== 'function') {
    throw new Error('Store credential decryption is not configured.');
  }
  return {
    storeId: Number(row.store_id),
    account: row.withdrawal_login_account || '',
    password: decryptBusinessSecret(row.withdrawal_login_password || '')
  };
}

module.exports = {
  STORE_CREDENTIAL_WORKSPACES,
  getManagedStoreCredentials,
  workspaceCanRevealStoreCredentials
};
