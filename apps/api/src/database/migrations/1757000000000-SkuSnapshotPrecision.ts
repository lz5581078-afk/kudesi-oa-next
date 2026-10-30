import { MigrationInterface, QueryRunner } from 'typeorm';

/** Preserve computed freight and subgram weights; final selling prices remain integer cents. */
export class SkuSnapshotPrecision1757000000000 implements MigrationInterface {
  name='SkuSnapshotPrecision1757000000000';
  async up(q:QueryRunner){
    await q.query('ALTER TABLE finance_cost_snapshots MODIFY weight_g decimal(20,6) NULL, MODIFY freight_cents decimal(24,4) NULL');
  }
  async down(q:QueryRunner){
    const [r]=await q.query('SELECT COUNT(*) n FROM finance_cost_snapshots WHERE weight_g<>ROUND(weight_g,2) OR ABS(weight_g)>=1000000000000 OR freight_cents<>ROUND(freight_cents) OR ABS(freight_cents)>9223372036854775807');
    if(Number(r.n))throw new Error('已有精细重量或运费，禁止截断精度；请恢复迁移前备份');
    await q.query('ALTER TABLE finance_cost_snapshots MODIFY weight_g decimal(14,2) NULL, MODIFY freight_cents bigint NULL');
  }
}
