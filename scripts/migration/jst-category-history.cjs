const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function readJstCategoryHistory(connection, columns, companyId, codec) {
  const read = async table => columns.some(column => column.t === table && column.c === 'company_id')
    ? (await connection.query('SELECT t.* FROM `' + table + '` t WHERE t.company_id=?', [companyId]))[0]
    : [];
  const links = await read('jst_category_sync_links');
  const runs = await read('jst_category_outbound_runs');
  if (!links.length && !runs.length) return undefined;
  const targets = {};
  if (['integration_accounts', 'integration_app_configs', 'integrations'].every(table => columns.some(column => column.t === table))) {
    const [accounts] = await connection.query(`
      SELECT a.id,a.coid,COALESCE(NULLIF(a.base_url,''),NULLIF(p.base_url,''),'https://openapi.jushuitan.com') AS baseUrl,p.app_key_encrypted
      FROM integration_accounts a JOIN integrations i ON i.id=a.integration_id
      JOIN integration_app_configs p ON p.integration_id=i.id AND p.environment='production'
      WHERE a.company_id=? AND i.integration_key='jushuitan'`, [companyId]);
    for (const row of accounts) {
      let appKey;
      try { appKey = codec.decrypt(row.app_key_encrypted); } catch { continue; }
      if (!appKey || !row.coid) continue;
      const identity = [String(row.coid), appKey, String(row.baseUrl).replace(/\/$/, '')];
      targets[digest([row.id, ...identity])] = digest(identity);
    }
  }
  return { links, runs, targets };
}

module.exports = { readJstCategoryHistory };
