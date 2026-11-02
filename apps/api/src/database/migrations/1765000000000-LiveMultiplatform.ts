import { MigrationInterface, QueryRunner } from "typeorm";

export class LiveMultiplatform1765000000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    // Nullable snapshots keep all existing historical calculations unchanged.
    for (const table of ["live_schedules", "live_sessions"])
      await q.query(`ALTER TABLE ${table} ADD channels_json JSON NULL`);
    await q.query(
      "ALTER TABLE live_settlement_refunds ADD shop_id VARCHAR(64) NOT NULL DEFAULT '', ADD platform VARCHAR(32) NOT NULL DEFAULT ''",
    );
    await q.query(
      "ALTER TABLE live_session_reports ADD store_lines_json JSON NULL",
    );
    await q.query(
      "ALTER TABLE live_session_orders ADD platform VARCHAR(32) NOT NULL DEFAULT '', DROP INDEX uq_live_order_report, ADD UNIQUE KEY uq_live_order_report(report_id,shop_id,order_id)",
    );
    await q.query(
      "ALTER TABLE live_commission_records ADD platform VARCHAR(32) NOT NULL DEFAULT '', DROP INDEX uq_live_comm_role, ADD UNIQUE KEY uq_live_comm_role(company_id,session_id,role,platform)",
    );
  }
  async down(q: QueryRunner) {
    const [used] = await q.query(
      "SELECT COUNT(*) n FROM live_sessions WHERE channels_json IS NOT NULL",
    );
    const [planned] = await q.query(
      "SELECT COUNT(*) n FROM live_schedules WHERE channels_json IS NOT NULL",
    );
    if (Number(used.n) || Number(planned.n))
      throw new Error("已有多平台直播数据，不能回退结构");
    await q.query(
      "ALTER TABLE live_commission_records DROP INDEX uq_live_comm_role, DROP COLUMN platform, ADD UNIQUE KEY uq_live_comm_role(company_id,session_id,role)",
    );
    await q.query(
      "ALTER TABLE live_session_orders DROP INDEX uq_live_order_report, DROP COLUMN platform, ADD UNIQUE KEY uq_live_order_report(report_id,order_id)",
    );
    await q.query(
      "ALTER TABLE live_settlement_refunds DROP COLUMN shop_id, DROP COLUMN platform",
    );
    await q.query(
      "ALTER TABLE live_session_reports DROP COLUMN store_lines_json",
    );
    for (const table of ["live_sessions", "live_schedules"])
      await q.query(`ALTER TABLE ${table} DROP COLUMN channels_json`);
  }
}
