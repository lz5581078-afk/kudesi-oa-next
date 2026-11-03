import { MigrationInterface, QueryRunner } from 'typeorm';

/** Structure only. Final old session DDL validated in the isolated local MySQL
 * sample, from original migrations 0079-0089,0091,0092,0101 at source commit
 * 0fb7fdad2f3805e3579bd4f870199c880668aaa1. No seed, data adoption, device auth,
 * credential migration, task replay, or default encryption key is performed.
 * Only external company/user/store FKs were omitted because those are VIEWs;
 * original internal session FKs, unique indexes and field contracts are retained.
 * Legacy SQL is mapped to this namespace by the runtime adapter, not rewritten JS.
 */
const CORE_TABLES = [
  "sm_legacy_session_workspaces",
  "sm_legacy_session_devices",
  "sm_legacy_session_device_pairings",
  "sm_legacy_session_managed_shops",
  "sm_legacy_session_device_shop_bindings",
  "sm_legacy_session_versions",
  "sm_legacy_session_device_keys",
  "sm_legacy_session_open_requests",
  "sm_legacy_session_audit_logs",
  "sm_legacy_managed_browser_sessions",
  "sm_legacy_session_remote_sessions",
  "sm_legacy_session_remote_commands",
  "sm_legacy_session_agent_update_jobs"
];
export const LEGACY_SESSION_TABLES = [...CORE_TABLES, 'sm_legacy_store_ids', 'sm_legacy_company_adoptions', 'sm_legacy_remote_policies', 'sm_legacy_captures'] as const;
const CORE_DDL = [
`CREATE TABLE \`sm_legacy_session_workspaces\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`company_id\` bigint unsigned NOT NULL,
  \`workspace_key\` varchar(64) NOT NULL,
  \`name\` varchar(80) NOT NULL,
  \`permission_key\` varchar(120) NOT NULL,
  \`status\` enum('active','disabled') NOT NULL DEFAULT 'active',
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_session_workspace_company_key\` (\`company_id\`,\`workspace_key\`),
  KEY \`idx_session_workspace_company_status\` (\`company_id\`,\`status\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE \`sm_legacy_session_devices\` (
  \`id\` char(36) NOT NULL,
  \`company_id\` bigint unsigned NOT NULL,
  \`workspace_id\` bigint unsigned NOT NULL,
  \`registered_by_employee_id\` bigint unsigned NOT NULL,
  \`device_code\` varchar(24) NOT NULL,
  \`name\` varchar(80) NOT NULL,
  \`remark\` varchar(80) DEFAULT NULL,
  \`hostname\` varchar(190) NOT NULL,
  \`platform\` varchar(40) NOT NULL,
  \`arch\` varchar(40) NOT NULL,
  \`agent_version\` varchar(40) NOT NULL,
  \`public_key_pem\` text NOT NULL,
  \`token_hash\` char(64) NOT NULL,
  \`status\` varchar(20) NOT NULL DEFAULT 'active',
  \`last_seen_at\` timestamp NULL DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_session_device_company_code\` (\`company_id\`,\`device_code\`),
  KEY \`idx_session_device_company_seen\` (\`company_id\`,\`status\`,\`last_seen_at\`),
  KEY \`idx_sess_devices_workspace\` (\`workspace_id\`),
  CONSTRAINT \`sml_73d85145c4d02252a32a4c9e\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`sm_legacy_session_workspaces\` (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE \`sm_legacy_session_device_pairings\` (
  \`id\` char(36) NOT NULL,
  \`company_id\` bigint unsigned NOT NULL,
  \`workspace_id\` bigint unsigned NOT NULL,
  \`employee_id\` bigint unsigned NOT NULL,
  \`code_hash\` char(64) NOT NULL,
  \`expires_at\` timestamp NOT NULL,
  \`used_at\` timestamp NULL DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_session_pairing_code_hash\` (\`code_hash\`),
  KEY \`idx_session_pairing_company_expiry\` (\`company_id\`,\`expires_at\`,\`used_at\`),
  KEY \`idx_sess_device_pairings_workspace\` (\`workspace_id\`),
  CONSTRAINT \`sml_ee9df11d2a423c693a4d18ff\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`sm_legacy_session_workspaces\` (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE \`sm_legacy_session_managed_shops\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`company_id\` bigint unsigned NOT NULL,
  \`workspace_id\` bigint unsigned NOT NULL,
  \`store_id\` bigint unsigned NOT NULL,
  \`assigned_device_id\` char(36) DEFAULT NULL,
  \`assigned_by_employee_id\` bigint unsigned DEFAULT NULL,
  \`assigned_at\` timestamp NULL DEFAULT NULL,
  \`added_by_employee_id\` bigint unsigned NOT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`status\` varchar(20) NOT NULL DEFAULT 'active',
  \`withdrawal_login_account\` varchar(190) DEFAULT NULL,
  \`withdrawal_login_password\` text,
  \`auto_login_enabled\` tinyint(1) NOT NULL DEFAULT '0',
  \`removed_at\` timestamp NULL DEFAULT NULL,
  \`removed_by_employee_id\` bigint unsigned DEFAULT NULL,
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_session_managed_shop_workspace_store\` (\`workspace_id\`,\`store_id\`),
  KEY \`idx_session_managed_shop_company_created\` (\`company_id\`,\`created_at\`),
  KEY \`idx_sess_managed_shops_workspace\` (\`workspace_id\`),
  KEY \`idx_session_managed_shop_assignment\` (\`workspace_id\`,\`assigned_device_id\`,\`status\`),
  KEY \`fk_session_managed_shop_assigned_device\` (\`assigned_device_id\`),
  CONSTRAINT \`sml_91e7d3a5350c680068afe1e3\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`sm_legacy_session_workspaces\` (\`id\`),
  CONSTRAINT \`sml_02b0e3af7aa67423e470ccf6\` FOREIGN KEY (\`assigned_device_id\`) REFERENCES \`sm_legacy_session_devices\` (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE \`sm_legacy_session_device_shop_bindings\` (
  \`id\` char(36) NOT NULL,
  \`company_id\` bigint unsigned NOT NULL,
  \`workspace_id\` bigint unsigned NOT NULL,
  \`device_id\` char(36) NOT NULL,
  \`store_id\` bigint unsigned NOT NULL,
  \`local_profile_id\` char(36) NOT NULL,
  \`login_status\` varchar(20) NOT NULL DEFAULT 'pending',
  \`session_version\` int unsigned NOT NULL DEFAULT '0',
  \`applied_session_version\` int unsigned NOT NULL DEFAULT '0',
  \`local_state_hash\` char(64) DEFAULT NULL,
  \`authentication_evidence\` json DEFAULT NULL,
  \`last_verified_at\` timestamp NULL DEFAULT NULL,
  \`last_session_saved_at\` timestamp NULL DEFAULT NULL,
  \`last_opened_at\` timestamp NULL DEFAULT NULL,
  \`last_error\` varchar(1000) DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_session_binding_device_store\` (\`device_id\`,\`store_id\`),
  UNIQUE KEY \`uk_session_binding_device_profile\` (\`device_id\`,\`local_profile_id\`),
  KEY \`idx_session_binding_company_store\` (\`company_id\`,\`store_id\`,\`login_status\`),
  KEY \`idx_sess_device_shop_bindings_workspace\` (\`workspace_id\`),
  CONSTRAINT \`sml_4c2db85b26544939a5bc3b26\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`sm_legacy_session_workspaces\` (\`id\`),
  CONSTRAINT \`sml_990c825dbfd433386b5591e9\` FOREIGN KEY (\`device_id\`) REFERENCES \`sm_legacy_session_devices\` (\`id\`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE \`sm_legacy_session_versions\` (
  \`id\` char(36) NOT NULL,
  \`company_id\` bigint unsigned NOT NULL,
  \`workspace_id\` bigint unsigned NOT NULL,
  \`store_id\` bigint unsigned NOT NULL,
  \`version\` int unsigned NOT NULL,
  \`source_device_id\` char(36) NOT NULL,
  \`encrypted_state\` longtext NOT NULL,
  \`state_iv\` varchar(64) NOT NULL,
  \`state_tag\` varchar(64) NOT NULL,
  \`state_hash\` char(64) NOT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_session_version_workspace_store\` (\`workspace_id\`,\`store_id\`,\`version\`),
  KEY \`idx_session_version_company_store\` (\`company_id\`,\`store_id\`,\`created_at\`),
  KEY \`idx_session_version_source\` (\`source_device_id\`,\`created_at\`),
  KEY \`idx_sess_versions_workspace\` (\`workspace_id\`),
  KEY \`idx_session_version_store_fk\` (\`store_id\`),
  CONSTRAINT \`sml_71425c5c406fd4e745c0ed75\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`sm_legacy_session_workspaces\` (\`id\`),
  CONSTRAINT \`sml_9e6dbeaf080ebc30406b567f\` FOREIGN KEY (\`source_device_id\`) REFERENCES \`sm_legacy_session_devices\` (\`id\`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE \`sm_legacy_session_device_keys\` (
  \`session_version_id\` char(36) NOT NULL,
  \`company_id\` bigint unsigned NOT NULL,
  \`workspace_id\` bigint unsigned NOT NULL,
  \`device_id\` char(36) NOT NULL,
  \`wrapped_key\` longtext NOT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`session_version_id\`,\`device_id\`),
  KEY \`idx_session_key_company_device\` (\`company_id\`,\`device_id\`,\`created_at\`),
  KEY \`device_id\` (\`device_id\`),
  KEY \`idx_sess_device_keys_workspace\` (\`workspace_id\`),
  CONSTRAINT \`sml_53946176c443e43884d2ec9e\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`sm_legacy_session_workspaces\` (\`id\`),
  CONSTRAINT \`sml_0abeac313c58c94696fffd43\` FOREIGN KEY (\`session_version_id\`) REFERENCES \`sm_legacy_session_versions\` (\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`sml_0758aea5a4aa8e91d1e9020c\` FOREIGN KEY (\`device_id\`) REFERENCES \`sm_legacy_session_devices\` (\`id\`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE \`sm_legacy_session_open_requests\` (
  \`id\` char(36) NOT NULL,
  \`company_id\` bigint unsigned NOT NULL,
  \`workspace_id\` bigint unsigned NOT NULL,
  \`requested_by_employee_id\` bigint unsigned NOT NULL,
  \`store_id\` bigint unsigned NOT NULL,
  \`target_device_id\` char(36) NOT NULL,
  \`action\` varchar(40) NOT NULL DEFAULT 'open_shop',
  \`dispatch_mode\` enum('local','remote') NOT NULL DEFAULT 'local',
  \`status\` varchar(24) NOT NULL DEFAULT 'queued',
  \`progress\` tinyint unsigned NOT NULL DEFAULT '0',
  \`current_step\` varchar(60) DEFAULT NULL,
  \`error_code\` varchar(60) DEFAULT NULL,
  \`error_message\` varchar(1000) DEFAULT NULL,
  \`local_challenge_hash\` char(64) DEFAULT NULL,
  \`challenge_expires_at\` timestamp NULL DEFAULT NULL,
  \`lease_expires_at\` timestamp NULL DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`started_at\` timestamp NULL DEFAULT NULL,
  \`completed_at\` timestamp NULL DEFAULT NULL,
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_session_request_device_status\` (\`target_device_id\`,\`status\`,\`created_at\`),
  KEY \`idx_session_request_store_status\` (\`store_id\`,\`status\`,\`created_at\`),
  KEY \`idx_session_request_company_created\` (\`company_id\`,\`created_at\`),
  KEY \`idx_session_request_remote_dispatch\` (\`target_device_id\`,\`dispatch_mode\`,\`status\`,\`created_at\`),
  KEY \`idx_sess_open_requests_workspace\` (\`workspace_id\`),
  CONSTRAINT \`sml_cabda350c3c743b94875a16c\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`sm_legacy_session_workspaces\` (\`id\`),
  CONSTRAINT \`sml_9d708e6b5b8195114786ee86\` FOREIGN KEY (\`target_device_id\`) REFERENCES \`sm_legacy_session_devices\` (\`id\`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE \`sm_legacy_session_audit_logs\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`company_id\` bigint unsigned NOT NULL,
  \`workspace_id\` bigint unsigned NOT NULL,
  \`employee_id\` bigint unsigned DEFAULT NULL,
  \`device_id\` char(36) DEFAULT NULL,
  \`store_id\` bigint unsigned DEFAULT NULL,
  \`open_request_id\` char(36) DEFAULT NULL,
  \`event_type\` varchar(80) NOT NULL,
  \`outcome\` varchar(24) NOT NULL,
  \`summary\` varchar(500) NOT NULL,
  \`metadata_json\` json DEFAULT NULL,
  \`request_id\` varchar(100) DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_session_audit_company_created\` (\`company_id\`,\`created_at\`),
  KEY \`idx_session_audit_store_created\` (\`store_id\`,\`created_at\`),
  KEY \`idx_session_audit_device_created\` (\`device_id\`,\`created_at\`),
  KEY \`open_request_id\` (\`open_request_id\`),
  KEY \`idx_sess_audit_logs_workspace\` (\`workspace_id\`),
  CONSTRAINT \`sml_31e8ca8154d156b667ba415a\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`sm_legacy_session_workspaces\` (\`id\`),
  CONSTRAINT \`sml_7a0dccaaf9396796c2ff7ad5\` FOREIGN KEY (\`device_id\`) REFERENCES \`sm_legacy_session_devices\` (\`id\`) ON DELETE RESTRICT,
  CONSTRAINT \`sml_fb969259d0c1c7aaad77ea11\` FOREIGN KEY (\`open_request_id\`) REFERENCES \`sm_legacy_session_open_requests\` (\`id\`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE \`sm_legacy_managed_browser_sessions\` (
  \`id\` char(36) NOT NULL,
  \`company_id\` bigint unsigned NOT NULL,
  \`workspace_id\` bigint unsigned NOT NULL,
  \`user_id\` bigint unsigned NOT NULL,
  \`shop_id\` bigint unsigned NOT NULL,
  \`device_id\` char(36) NOT NULL,
  \`local_profile_id\` char(36) NOT NULL,
  \`opened_from_request_id\` char(36) DEFAULT NULL,
  \`status\` enum('open','closing','closed','error') NOT NULL DEFAULT 'open',
  \`page_url\` varchar(1000) DEFAULT NULL,
  \`opened_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`last_agent_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`closed_at\` timestamp NULL DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_managed_browser_device_profile_opened\` (\`device_id\`,\`local_profile_id\`,\`opened_at\`),
  KEY \`idx_managed_browser_company_shop\` (\`company_id\`,\`shop_id\`,\`status\`,\`last_agent_at\`),
  KEY \`idx_managed_browser_device_status\` (\`device_id\`,\`status\`,\`last_agent_at\`),
  KEY \`idx_managed_browser_user_status\` (\`user_id\`,\`status\`,\`opened_at\`),
  KEY \`opened_from_request_id\` (\`opened_from_request_id\`),
  KEY \`idx_managed_browser_sessions_workspace\` (\`workspace_id\`),
  CONSTRAINT \`sml_aabf5330e05fe6d45d3343c8\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`sm_legacy_session_workspaces\` (\`id\`),
  CONSTRAINT \`sml_e3aeaa3bb6994be7560b9857\` FOREIGN KEY (\`device_id\`) REFERENCES \`sm_legacy_session_devices\` (\`id\`) ON DELETE RESTRICT,
  CONSTRAINT \`sml_72284001c9435406ed4292b3\` FOREIGN KEY (\`opened_from_request_id\`) REFERENCES \`sm_legacy_session_open_requests\` (\`id\`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE \`sm_legacy_session_remote_sessions\` (
  \`id\` char(36) NOT NULL,
  \`company_id\` bigint unsigned NOT NULL,
  \`workspace_id\` bigint unsigned NOT NULL,
  \`user_id\` bigint unsigned NOT NULL,
  \`shop_id\` bigint unsigned NOT NULL,
  \`device_id\` char(36) NOT NULL,
  \`browser_session_id\` char(36) NOT NULL,
  \`status\` enum('requested','connected','closing','ended','closed','expired','error') NOT NULL DEFAULT 'requested',
  \`transport_mode\` enum('webrtc','jpeg_fallback') NOT NULL DEFAULT 'webrtc',
  \`expires_at\` timestamp NOT NULL,
  \`last_agent_at\` timestamp NULL DEFAULT NULL,
  \`connected_at\` timestamp NULL DEFAULT NULL,
  \`close_stage\` varchar(40) DEFAULT NULL,
  \`close_requested_at\` timestamp NULL DEFAULT NULL,
  \`closed_at\` timestamp NULL DEFAULT NULL,
  \`close_completed_at\` timestamp NULL DEFAULT NULL,
  \`frame_sequence\` int unsigned NOT NULL DEFAULT '0',
  \`frame_mime\` varchar(40) DEFAULT NULL,
  \`frame_width\` smallint unsigned DEFAULT NULL,
  \`frame_height\` smallint unsigned DEFAULT NULL,
  \`frame_url\` varchar(1000) DEFAULT NULL,
  \`frame_data\` mediumblob,
  \`error_message\` varchar(1000) DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_remote_session_user_created\` (\`user_id\`,\`created_at\`),
  KEY \`idx_remote_session_device_status\` (\`device_id\`,\`status\`,\`expires_at\`),
  KEY \`idx_remote_session_browser_created\` (\`browser_session_id\`,\`created_at\`),
  KEY \`idx_session_remote_transport\` (\`device_id\`,\`transport_mode\`,\`status\`,\`expires_at\`),
  KEY \`idx_sess_remote_sessions_workspace\` (\`workspace_id\`),
  CONSTRAINT \`sml_0401e948c0fdba6cd73c6f8c\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`sm_legacy_session_workspaces\` (\`id\`),
  CONSTRAINT \`sml_e8a7eaa1200e3fdf065a37a0\` FOREIGN KEY (\`device_id\`) REFERENCES \`sm_legacy_session_devices\` (\`id\`) ON DELETE RESTRICT,
  CONSTRAINT \`sml_e44513e65101d1ff28d4d507\` FOREIGN KEY (\`browser_session_id\`) REFERENCES \`sm_legacy_managed_browser_sessions\` (\`id\`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE \`sm_legacy_session_remote_commands\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`session_id\` char(36) NOT NULL,
  \`kind\` enum('click','drag','scroll') NOT NULL,
  \`payload\` json NOT NULL,
  \`status\` enum('queued','running','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
  \`error_message\` varchar(1000) DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`claimed_at\` timestamp NULL DEFAULT NULL,
  \`completed_at\` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`idx_remote_command_session_status\` (\`session_id\`,\`status\`,\`id\`),
  CONSTRAINT \`sml_7d7a6e0eb4adf40eb577f952\` FOREIGN KEY (\`session_id\`) REFERENCES \`sm_legacy_session_remote_sessions\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE \`sm_legacy_session_agent_update_jobs\` (
  \`id\` char(36) NOT NULL,
  \`company_id\` bigint unsigned NOT NULL,
  \`workspace_id\` bigint unsigned NOT NULL,
  \`device_id\` char(36) NOT NULL,
  \`requested_by_employee_id\` bigint unsigned DEFAULT NULL,
  \`target_version\` varchar(40) NOT NULL,
  \`package_type\` enum('patch','component','full','repair_required') DEFAULT NULL,
  \`status\` enum('queued','claimed','downloading','verifying','staged','applying','restarting','succeeded','failed','deferred','repair_required') NOT NULL DEFAULT 'queued',
  \`phase\` varchar(40) DEFAULT NULL,
  \`progress\` tinyint unsigned NOT NULL DEFAULT '0',
  \`downloaded_bytes\` bigint unsigned NOT NULL DEFAULT '0',
  \`total_bytes\` bigint unsigned NOT NULL DEFAULT '0',
  \`error_message\` varchar(500) DEFAULT NULL,
  \`failure_code\` varchar(80) DEFAULT NULL,
  \`requested_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`started_at\` timestamp NULL DEFAULT NULL,
  \`last_progress_at\` timestamp NULL DEFAULT NULL,
  \`claimed_at\` timestamp NULL DEFAULT NULL,
  \`applying_at\` timestamp NULL DEFAULT NULL,
  \`completed_at\` timestamp NULL DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_session_agent_update_company\` (\`company_id\`,\`status\`,\`requested_at\`),
  KEY \`idx_session_agent_update_device\` (\`device_id\`,\`status\`,\`requested_at\`),
  KEY \`idx_sess_agent_update_jobs_workspace\` (\`workspace_id\`),
  CONSTRAINT \`sml_58443ee4ec1a7b9f2a603598\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`sm_legacy_session_workspaces\` (\`id\`),
  CONSTRAINT \`sml_94c0ac32e7c0eb02064dc755\` FOREIGN KEY (\`device_id\`) REFERENCES \`sm_legacy_session_devices\` (\`id\`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];

export class SessionLegacyRuntime1777000000000 implements MigrationInterface {
  name = 'SessionLegacyRuntime1777000000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE sm_legacy_store_ids (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      record_id INT UNSIGNED NOT NULL, company_id INT UNSIGNED NOT NULL,
      UNIQUE KEY uq_sml_store_record (company_id, record_id),
      KEY idx_sml_store_company_id (company_id, id),
      CONSTRAINT fk_sml_map_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
      CONSTRAINT fk_sml_map_record FOREIGN KEY (record_id) REFERENCES resource_records(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    // MERGE is intentional: no temporary materialization hiding the lock semantics.
    // The runtime must still lock/check the underlying mapping and source rows.
    await q.query(`CREATE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW sm_legacy_companies AS
      SELECT id, name, status FROM companies`);
    await q.query(`CREATE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW sm_legacy_employees AS
      SELECT id, company_id, name, status FROM users`);
    await q.query(`CREATE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW sm_legacy_stores AS
      SELECT m.id, r.company_id, r.title AS name, r.status,
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.storeNo')), '') AS store_no,
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.platformStoreId')), '') AS platform_store_id,
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.platform')), '') AS platform,
        operator.id AS current_claimer_id, COALESCE(reason.title, '') AS abnormal_reason
      FROM sm_legacy_store_ids m JOIN resource_records r
        ON r.id=m.record_id AND r.company_id=m.company_id AND r.type='stores' AND r.archived_at IS NULL
      LEFT JOIN users operator ON operator.company_id=r.company_id AND operator.status='active'
        AND operator.id=CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.operatorUserId')), 'null') AS UNSIGNED)
      LEFT JOIN resource_records reason ON reason.company_id=r.company_id AND reason.type='store-abnormal-reasons'
        AND reason.archived_at IS NULL
        AND reason.id=CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.abnormalReason')), 'null') AS UNSIGNED)`);
    await q.query(`CREATE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW sm_legacy_store_abnormal_reasons AS
      SELECT id, company_id, title AS reason,
        CASE WHEN status='normal' THEN 'active' ELSE 'inactive' END AS status, updated_at
      FROM resource_records WHERE type='store-abnormal-reasons' AND archived_at IS NULL`);
    for (const ddl of CORE_DDL) await q.query(ddl);
    // New bridge state only; ownership must be locked and checked by company at use.
    await q.query(`CREATE TABLE sm_legacy_company_adoptions (
      company_id INT UNSIGNED NOT NULL PRIMARY KEY, actor_id INT UNSIGNED NOT NULL,
      applied_at DATETIME(3) NOT NULL, source_hash CHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await q.query(`CREATE TABLE sm_legacy_remote_policies (
      company_id INT UNSIGNED NOT NULL, workspace_id BIGINT UNSIGNED NOT NULL, device_id CHAR(36) NOT NULL,
      enabled TINYINT NOT NULL DEFAULT 0, allow_control TINYINT NOT NULL DEFAULT 0,
      max_minutes INT NOT NULL DEFAULT 10, PRIMARY KEY(company_id, workspace_id, device_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await q.query(`CREATE TABLE sm_legacy_captures (
      id CHAR(36) NOT NULL PRIMARY KEY, company_id INT UNSIGNED NOT NULL,
      workspace_id BIGINT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, store_id BIGINT UNSIGNED NOT NULL,
      remote_session_id CHAR(36) NOT NULL, owns_remote TINYINT NOT NULL,
      baseline_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0, status VARCHAR(16) NOT NULL DEFAULT 'pending',
      file_id INT UNSIGNED NULL, error_text VARCHAR(300) NULL, created_at DATETIME(3) NOT NULL,
      finished_at DATETIME(3) NULL,
      KEY idx_sml_capture_company_user_status (company_id,user_id,status),
      KEY idx_sml_capture_company_store (company_id,workspace_id,store_id,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }

  async down(q: QueryRunner): Promise<void> {
    const tables = [...CORE_TABLES, 'sm_legacy_store_ids', 'sm_legacy_company_adoptions',
      'sm_legacy_remote_policies', 'sm_legacy_captures'];
    // Never silently delete adopted devices, credentials, audit or mapping records.
    for (const table of tables) {
      const rows = await q.query('SELECT 1 FROM '+ table +' LIMIT 1');
      if (rows.length) throw new Error('Legacy session data exists; refusing schema rollback');
    }
    for (const view of ['sm_legacy_stores','sm_legacy_store_abnormal_reasons','sm_legacy_employees','sm_legacy_companies']) {
      await q.query('DROP VIEW '+ view);
    }
    for (const table of [...tables].reverse()) await q.query('DROP TABLE '+ table);
  }
}
