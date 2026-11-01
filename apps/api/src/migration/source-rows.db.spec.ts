import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { CryptoService } from '../common/crypto.service';
import { Company } from '../entities';
import { preserveSourceRow, readSourceRow } from './source-rows';
import { LegacySourceRows1759000000000 } from '../database/migrations/1759000000000-LegacySourceRows';

const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('全量迁移原始记录加密保留（数据库）', () => {
  let ds: DataSource, companyId: number;
  const crypto = new CryptoService({ test: randomBytes(32) }, 'test');
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never).initialize();
    companyId = (await ds.manager.save(Company, ds.manager.create(Company, { code: `source-${randomBytes(4).toString('hex')}`, name: '原始记录测试', status: 'active' }))).id;
  });
  afterAll(async () => { await ds?.destroy(); });
  const identity = (key: string, sourceCompanyId = 3) => ({ companyId, sourceCompanyId, table: 'workflow_node_records', key });
  it('保留原状态、原时间、小数文本、嵌套审批内容；库里只有密文，复跑不改证据', async () => {
    const row = { id: 'A', status: 'returned', created_at: '2026-10-01 23:59:59', amount: '0.000001', payload: { reason: '原审批意见', list: [null, '原单价'] } };
    await ds.transaction(async em => {
      const first = await preserveSourceRow(em, crypto, identity('A'), row);
      const second = await preserveSourceRow(em, crypto, identity('A'), { ...row });
      expect(second).toMatchObject({ id: first.id, hash: first.hash, reused: true });
      const [stored] = await em.query('SELECT raw_encrypted FROM legacy_source_rows WHERE id=?', [first.id]);
      expect(stored.raw_encrypted).toMatch(/^v1:test:/);
      expect(stored.raw_encrypted).not.toContain('原审批意见');
      expect(await readSourceRow(em, crypto, identity('A'))).toEqual(row);
      await expect(preserveSourceRow(em, crypto, identity('A'), { ...row, status: 'completed' })).rejects.toThrow('禁止覆盖');
    });
  });
  it('来源表、旧公司、新公司和大小写共同限定身份，不跨公司读取或合并', async () => {
    await ds.transaction(async em => {
      const a = await preserveSourceRow(em, crypto, identity('a'), { id: 'a' });
      const A = await preserveSourceRow(em, crypto, identity('A'), { id: 'A', status: 'returned', created_at: '2026-10-01 23:59:59', amount: '0.000001', payload: { reason: '原审批意见', list: [null, '原单价'] } });
      expect(a.id).not.toBe(A.id);
      expect(await readSourceRow(em, crypto, { ...identity('A'), sourceCompanyId: 1 })).toBeNull();
      expect(await readSourceRow(em, crypto, { ...identity('A'), companyId: companyId + 999999 })).toBeNull();
      expect(await readSourceRow(em, crypto, { ...identity('A'), table: 'task_instances' })).toBeNull();
      await expect(preserveSourceRow(em, crypto, identity('foreign'), { company_id: 1 })).rejects.toThrow('不属于');
    });
  });
  it('迁移事务回滚同时撤销原始记录，不产生业务表、消息或出站任务', async () => {
    const before = (await ds.query('SELECT COUNT(*) n FROM outbox_jobs'))[0].n;
    await expect(ds.transaction(async em => { await preserveSourceRow(em, crypto, identity('rollback'), { id: 9 }); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(await readSourceRow(ds.manager, crypto, identity('rollback'))).toBeNull();
    expect((await ds.query('SELECT COUNT(*) n FROM outbox_jobs'))[0].n).toBe(before);
    await expect(preserveSourceRow(ds.manager, crypto, identity('no-tx'), {})).rejects.toThrow('迁移事务');
  });
  it('拒绝无损性无法保证的值，防止损失精度或静默改日期类型', async () => {
    await ds.transaction(async em => {
      for (const value of [NaN, Number.MAX_SAFE_INTEGER + 1, new Date(), Buffer.from('binary'), undefined]) {
        await expect(preserveSourceRow(em, crypto, identity('unsafe'), { value })).rejects.toThrow();
      }
    });
  });
  it('已有来源证据时拒绝回退删表，读取检测哈希篡改', async () => {
    await ds.transaction(em => preserveSourceRow(em, crypto, identity('down-guard'), { id: 'down-guard' }));
    const q = ds.createQueryRunner(); await q.connect();
    try { await expect(new LegacySourceRows1759000000000().down(q)).rejects.toThrow('禁止'); } finally { await q.release(); }
    await ds.transaction(async em => {
      const result = await preserveSourceRow(em, crypto, identity('tamper'), { id: 'tamper' });
      await em.query('UPDATE legacy_source_rows SET source_hash=? WHERE id=?', ['0'.repeat(64), result.id]);
      await expect(readSourceRow(em, crypto, identity('tamper'))).rejects.toThrow('完整性');
      throw new Error('revert tamper');
    }).catch(e => { expect(e.message).toBe('revert tamper'); });
  });
});
