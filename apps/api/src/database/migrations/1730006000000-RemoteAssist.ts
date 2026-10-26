import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 远程协助（店铺提现里看/协助授权电脑上的店铺窗口）。
 * - session_remote_devices：电脑是否开启远程协助（默认没有这一行 = 关闭）、能否操作、单次时长上限。
 * - session_remote_sessions：每一次远程协助：谁申请、哪家店铺、哪台电脑、模式、事由、起止时间和结束原因（审计用，不删除）。
 * - session_remote_signals：WebRTC 信令信箱（SDP / ICE），会话结束即清空；画面和操作都不经过服务器，不落库。
 */
export class RemoteAssist1730006000000 implements MigrationInterface {
  name = 'RemoteAssist1730006000000';

  public async up(q: QueryRunner): Promise<void> {
    const tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await q.query(`CREATE TABLE session_remote_devices (
        device_id INT UNSIGNED NOT NULL,
        company_id INT UNSIGNED NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        allow_control TINYINT(1) NOT NULL DEFAULT 0,
        max_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 15,
        updated_by INT UNSIGNED NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (device_id),
        KEY idx_remote_device_company (company_id),
        CONSTRAINT fk_remote_device_device FOREIGN KEY (device_id) REFERENCES session_devices (id)
      ) ${tail}`);
    await q.query(`CREATE TABLE session_remote_sessions (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        company_id INT UNSIGNED NOT NULL,
        shop_id INT UNSIGNED NOT NULL,
        store_id INT UNSIGNED NOT NULL,
        device_id INT UNSIGNED NOT NULL,
        requested_by INT UNSIGNED NOT NULL,
        mode VARCHAR(8) NOT NULL,
        reason VARCHAR(100) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'requested',
        end_reason VARCHAR(20) NULL,
        end_note VARCHAR(300) NULL,
        ended_by INT UNSIGNED NULL,
        max_minutes SMALLINT UNSIGNED NOT NULL,
        extend_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
        input_count INT UNSIGNED NOT NULL DEFAULT 0,
        requested_at DATETIME NOT NULL,
        deadline_at DATETIME NOT NULL,
        accepted_at DATETIME NULL,
        expires_at DATETIME NULL,
        ended_at DATETIME NULL,
        viewer_seen_at DATETIME NULL,
        agent_seen_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_remote_session_live (company_id, status),
        KEY idx_remote_session_device (device_id, status),
        KEY idx_remote_session_shop (shop_id, status),
        KEY idx_remote_session_time (company_id, requested_at),
        CONSTRAINT fk_remote_session_company FOREIGN KEY (company_id) REFERENCES companies (id),
        CONSTRAINT fk_remote_session_device FOREIGN KEY (device_id) REFERENCES session_devices (id)
      ) ${tail}`);
    await q.query(`CREATE TABLE session_remote_signals (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        session_id INT UNSIGNED NOT NULL,
        to_agent TINYINT(1) NOT NULL,
        kind VARCHAR(10) NOT NULL,
        payload MEDIUMTEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_remote_signal_box (session_id, to_agent, id),
        CONSTRAINT fk_remote_signal_session FOREIGN KEY (session_id) REFERENCES session_remote_sessions (id) ON DELETE CASCADE
      ) ${tail}`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS session_remote_signals');
    await q.query('DROP TABLE IF EXISTS session_remote_sessions');
    await q.query('DROP TABLE IF EXISTS session_remote_devices');
  }
}
