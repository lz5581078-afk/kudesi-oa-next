import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Connection, RowDataPacket } from 'mysql2/promise';

/** Local experiment only. Never registered as an application migration/provider.
 * Reads static DDL from the existing legacy checkout; never executes its up(),
 * seeds, schema initializer or server. External FKs cannot reference our read-only
 * views and are omitted here; internal session FKs/unique indexes remain intact.
 * This deliberately does NOT establish production referential integrity or prove
 * locking semantics across the projected resource views.
 */
const BASE_FILES = [
  '0079_session_manager.js', '0080_session_managed_shops.js',
  '0082_session_remote_assistance.js', '0086_session_agent_update_jobs.js',
  '0088_session_workspaces.js',
];
const STATIC_ALTER_FILES = [
  '0083_session_remote_open_dispatch.js', '0084_session_safe_browser_close.js',
  '0085_session_remote_transport_mode.js', '0087_session_agent_update_progress.js',
];
const SCOPED_TABLES = [
  'session_device_pairings', 'session_devices', 'session_managed_shops',
  'session_device_shop_bindings', 'session_versions', 'session_device_keys',
  'session_open_requests', 'managed_browser_sessions', 'session_remote_sessions',
  'session_agent_update_jobs', 'session_audit_logs',
];

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new Error('Invalid lab SQL identifier');
  return `\`${value}\``;
}

async function sourceSql(sourceRoot: string, file: string, kind: 'CREATE TABLE' | 'ALTER TABLE'): Promise<string[]> {
  const source = await readFile(path.join(sourceRoot, 'server/migrations', file), 'utf8');
  const statements = [...source.matchAll(/connection\.execute\(\s*`([^`]+)`\s*\)/g)]
    .map(match => match[1].trim()).filter(sql => sql.startsWith(kind));
  if (!statements.length || statements.some(sql => sql.includes('${'))) {
    throw new Error(`Legacy fixture DDL source changed: ${file}`);
  }
  return statements;
}

function omitViewForeignKeys(sql: string): string {
  // Only remove full, single-line constraints to our three external VIEWs.
  // Fail closed on unexpected multi-line external FKs instead of broad rewriting.
  const result = sql.split('\n').filter(line => !/FOREIGN KEY\s*\([^)]*\)\s+REFERENCES (?:companies|employees|stores)\(/.test(line)).join('\n')
    .replace(/,\s*\) ENGINE=/g, '\n  ) ENGINE=');
  if (/REFERENCES (?:companies|employees|stores)\(/.test(result)) {
    throw new Error('Unexpected external legacy FK syntax');
  }
  return result;
}

export interface LegacyLabFixture {
  legacyDatabase: string;
  nextDatabase: string;
  /** Insert explicit synthetic (legacy_store_id, record_id, company_id) mappings.
   * No title matching, implicit fallback, business data copies, or ID guessing. */
  storeMappingTable: 'legacy_lab_store_ids';
  ddlSources: string[];
}

/** Initialize an EMPTY, already-created loopback lab schema. Does not create/drop
 * databases, start services, load credentials, connect remotely or seed real data.
 * Caller must create nextDatabase with the real new-OA migrations and synthetic
 * company/user/resource rows. Both schemas must be disposable lab namespaces.
 */
export async function setupLegacyLab(connection: Connection, nextDatabase: string, sourceRoot: string): Promise<LegacyLabFixture> {
  if (!/^session_reuse_next_[a-z0-9_]+$/.test(nextDatabase)) throw new Error('Expected isolated next lab database');
  // mysql2 exposes its resolved transport; reject sockets/defaults and any remote host.
  const config = (connection as unknown as { config: { host?: string; socketPath?: string } }).config;
  if (!config || config.socketPath || !['127.0.0.1', '::1', 'localhost'].includes(config.host ?? '')) {
    throw new Error('Legacy lab only accepts explicit loopback TCP connections');
  }
  const [identity] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS db');
  const legacyDatabase = String(identity[0]?.db ?? '');
  if (!/^session_reuse_lab_[a-z0-9_]+$/.test(legacyDatabase)) throw new Error('Expected isolated legacy lab database');
  const [existing] = await connection.query<RowDataPacket[]>(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [legacyDatabase]);
  if (existing.length) throw new Error('Legacy lab fixture requires an empty schema');
  const next = quotedIdentifier(nextDatabase);
  // Projections intentionally exclude all passwords, user hashes and secrets.
  await connection.query(`CREATE ALGORITHM=TEMPTABLE SQL SECURITY INVOKER VIEW companies AS
    SELECT id, name, status FROM ${next}.companies`);
  await connection.query(`CREATE ALGORITHM=TEMPTABLE SQL SECURITY INVOKER VIEW employees AS
    SELECT id, company_id, name, status FROM ${next}.users`);
  await connection.query(`CREATE TABLE legacy_lab_store_ids (
    legacy_store_id BIGINT UNSIGNED PRIMARY KEY,
    record_id INT UNSIGNED NOT NULL,
    company_id INT UNSIGNED NOT NULL,
    UNIQUE KEY uq_lab_store_record (company_id, record_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  await connection.query(`CREATE ALGORITHM=TEMPTABLE SQL SECURITY INVOKER VIEW stores AS
    SELECT m.legacy_store_id AS id, r.company_id, r.title AS name, r.status,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.storeNo')), '') AS store_no,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.platformStoreId')), '') AS platform_store_id,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.platform')), '') AS platform,
      CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.operatorUserId')), 'null') AS UNSIGNED) AS current_claimer_id,
      COALESCE(reason.title, '') AS abnormal_reason
    FROM legacy_lab_store_ids m JOIN ${next}.resource_records r
      ON r.id = m.record_id AND r.company_id = m.company_id AND r.type = 'stores' AND r.archived_at IS NULL
    LEFT JOIN ${next}.resource_records reason ON reason.company_id = r.company_id
      AND reason.type = 'store-abnormal-reasons' AND reason.archived_at IS NULL
      AND reason.id = CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.abnormalReason')), 'null') AS UNSIGNED)`);
  await connection.query(`CREATE ALGORITHM=TEMPTABLE SQL SECURITY INVOKER VIEW store_abnormal_reasons AS
    SELECT id, company_id, title AS reason, CASE WHEN status = 'normal' THEN 'active' ELSE 'inactive' END AS status,
      updated_at FROM ${next}.resource_records WHERE type = 'store-abnormal-reasons' AND archived_at IS NULL`);

  for (const file of BASE_FILES) {
    for (const sql of await sourceSql(sourceRoot, file, 'CREATE TABLE')) await connection.query(omitViewForeignKeys(sql));
  }
  // Explicit final columns from 0081 (removal); no legacy migration data updates.
  await connection.query(`ALTER TABLE session_managed_shops
    ADD status VARCHAR(20) NOT NULL DEFAULT 'active', ADD removed_at TIMESTAMP NULL,
    ADD removed_by_employee_id BIGINT UNSIGNED NULL,
    ADD updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
  for (const file of STATIC_ALTER_FILES) {
    for (const sql of await sourceSql(sourceRoot, file, 'ALTER TABLE')) await connection.query(sql);
  }
  // 0088 workspace partitioning, without running its existing-company seed/backfill.
  for (const table of SCOPED_TABLES) {
    const quoted = quotedIdentifier(table);
    const suffix = table.replace(/^session_/, 'sess_').slice(0, 38);
    await connection.query(`ALTER TABLE ${quoted} ADD workspace_id BIGINT UNSIGNED NOT NULL AFTER company_id,
      ADD INDEX ${quotedIdentifier(`idx_${suffix}_workspace`)} (workspace_id),
      ADD CONSTRAINT ${quotedIdentifier(`fk_${suffix}_workspace`)} FOREIGN KEY (workspace_id) REFERENCES session_workspaces(id)`);
  }
  await connection.query(`ALTER TABLE session_managed_shops
    DROP INDEX uk_session_managed_shop_company_store,
    ADD UNIQUE KEY uk_session_managed_shop_workspace_store (workspace_id, store_id)`);
  await connection.query(`ALTER TABLE session_versions ADD INDEX idx_session_version_store_fk (store_id),
    DROP INDEX uk_session_version_store,
    ADD UNIQUE KEY uk_session_version_workspace_store (workspace_id, store_id, version)`);
  // 0089 verification evidence; 0091 assignment; 0092 remark; 0101 credentials.
  await connection.query('ALTER TABLE session_device_shop_bindings ADD authentication_evidence JSON NULL AFTER local_state_hash');
  await connection.query(`ALTER TABLE session_managed_shops
    ADD assigned_device_id CHAR(36) NULL AFTER store_id,
    ADD assigned_by_employee_id BIGINT UNSIGNED NULL AFTER assigned_device_id,
    ADD assigned_at TIMESTAMP NULL AFTER assigned_by_employee_id,
    ADD INDEX idx_session_managed_shop_assignment (workspace_id, assigned_device_id, status),
    ADD CONSTRAINT fk_session_managed_shop_assigned_device FOREIGN KEY (assigned_device_id) REFERENCES session_devices(id),
    ADD withdrawal_login_account VARCHAR(190) NULL AFTER status,
    ADD withdrawal_login_password TEXT NULL AFTER withdrawal_login_account,
    ADD auto_login_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER withdrawal_login_password`);
  await connection.query('ALTER TABLE session_devices ADD remark VARCHAR(80) NULL AFTER name');
  return {
    legacyDatabase, nextDatabase, storeMappingTable: 'legacy_lab_store_ids',
    ddlSources: [...BASE_FILES, ...STATIC_ALTER_FILES, '0081_session_managed_shop_removal.js',
      '0089_session_login_verification_evidence.js', '0091_session_managed_shop_assignment.js',
      '0092_session_device_remark.js', '0101_session_withdrawal_auto_login.js'],
  };
}
