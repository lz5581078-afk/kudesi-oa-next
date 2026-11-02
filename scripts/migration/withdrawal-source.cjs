'use strict';
/** Server-only reader for a restored frozen backup. Connection/password callbacks stay in memory. */
exports.createWithdrawalReader = ({ connect, decryptPassword, backupDigest }) => ({
  async read({ sourceCompanyId }) {
    if (!Number.isSafeInteger(sourceCompanyId) || sourceCompanyId < 1 || !/^[a-f0-9]{64}$/.test(backupDigest)) throw Error('Invalid frozen source identity');
    const c = await connect();
    try {
      const [[database]] = await c.query('SELECT DATABASE() AS name');
      if (!/^withdrawal_restore_[a-z0-9_]+$/.test(database.name)) throw Error('Source must be a separate restored backup database');
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const [[company]] = await c.query('SELECT id,name FROM companies WHERE id=?', [sourceCompanyId]);
      const [[workspace]] = await c.query('SELECT * FROM session_workspaces WHERE company_id=? AND workspace_key=?', [sourceCompanyId, 'finance_withdrawal']);
      if (!company || !workspace) throw Error('Source company or withdrawal workspace missing');
      const [shops] = await c.query('SELECT * FROM session_managed_shops WHERE company_id=? AND workspace_id=? ORDER BY id', [sourceCompanyId, workspace.id]);
      // Deliberately exclude old authentication tokens/public keys; new agent authorization must be issued separately.
      const [devices] = await c.query('SELECT id,company_id,workspace_id,device_code,name,hostname,platform,arch,agent_version,status,last_seen_at,created_at,updated_at FROM session_devices WHERE company_id=? AND workspace_id=? ORDER BY id', [sourceCompanyId, workspace.id]);
      return { company: { id: Number(company.id), name: company.name }, workspace, shops, devices, backupDigest, decryptPassword };
    } finally { await c.rollback().catch(() => undefined); await c.end(); }
  },
});
