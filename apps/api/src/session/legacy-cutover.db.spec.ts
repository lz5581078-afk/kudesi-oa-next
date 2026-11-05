import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Company } from '../entities';
import { buildServices } from '../test-support';
import { cutoverTables, runCutover } from '../migration/cutover';
import { LEGACY_SESSION_TABLES } from '../database/migrations/1777000000000-SessionLegacyRuntime';

jest.setTimeout(30_000);
const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('店铺登录模块与整库切换清单保护（新建隔离MySQL库）', () => {
  let admin: DataSource, ds: DataSource, database: string, services: ReturnType<typeof buildServices>;
  const companyId = 991;
  const options = () => ({ apply: false, plans: [], softwareFingerprint: 'a'.repeat(64), backupDigest: 'b'.repeat(64) });
  const run = () => runCutover(ds, services.resources, services.files, services.crypto, [], options());
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '') || !/^(?:session_reuse_next_|kudesi_oa_test)/.test(process.env.TEST_DB_NAME ?? process.env.DB_NAME ?? '')) throw new Error('Requires an isolated loopback test database');
    const { buildDataSourceOptions } = await import('../database/data-source');
    admin = await new DataSource(buildDataSourceOptions()).initialize();
    database = `kudesi_legacy_cutover_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: database }), migrationsRun: true }).initialize();
    services = buildServices(ds);
  });
  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (admin?.isInitialized) {
      if (!/^kudesi_legacy_cutover_[a-f0-9]{12}$/.test(database)) throw new Error('Unexpected isolated test database cleanup');
      await admin.query(`DROP DATABASE \`${database}\``); await admin.destroy();
    }
  });

  it('全迁移后的17张空兼容表是明确已知表，切换预检可继续', async () => {
    const tables = await cutoverTables(ds);
    expect(LEGACY_SESSION_TABLES).toHaveLength(17);
    expect(tables).toEqual(expect.arrayContaining([...LEGACY_SESSION_TABLES]));
    for (const table of LEGACY_SESSION_TABLES) expect(Number((await ds.query(`SELECT COUNT(*) n FROM \`${table}\``))[0].n)).toBe(0);
  });

  it('产品话术非空时拒绝整库清理并保留原目录', async () => {
    const {insertId}=await ds.query('INSERT INTO live_script_folders(company_id,name) VALUES(?,?)',[companyId,'测试话术']);
    try {
      await expect(run()).rejects.toThrow(/话术中心已有资料/);
      expect(await ds.query('SELECT name FROM live_script_folders WHERE id=?',[insertId])).toEqual([{name:'测试话术'}]);
    } finally {await ds.query('DELETE FROM live_script_folders WHERE id=?',[insertId]);}
  });

  const occupiedCases = [
    { table: 'sm_legacy_session_workspaces', sql: "INSERT INTO sm_legacy_session_workspaces (company_id,workspace_key,name,permission_key) VALUES (?,'finance_withdrawal','合成登录工作区','finance.session-manager.manage')", params: () => [companyId] },
    { table: 'sm_legacy_company_adoptions', sql: 'INSERT INTO sm_legacy_company_adoptions (company_id,actor_id,applied_at,source_hash) VALUES (?,1,CURRENT_TIMESTAMP(3),?)', params: () => [companyId, 'c'.repeat(64)] },
    { table: 'sm_legacy_remote_policies', sql: 'INSERT INTO sm_legacy_remote_policies (company_id,workspace_id,device_id,enabled,allow_control) VALUES (?,1,?,0,0)', params: () => [companyId, randomUUID()] },
    { table: 'sm_legacy_captures', sql: "INSERT INTO sm_legacy_captures (id,company_id,workspace_id,user_id,store_id,remote_session_id,owns_remote,created_at) VALUES (?,?,1,1,1,?,1,CURRENT_TIMESTAMP(3))", params: () => [randomUUID(), companyId, randomUUID()] },
  ];
  it.each(occupiedCases)('$table非空时拒绝清理，原行保持不变', async ({ table, sql, params }) => {
    expect([...LEGACY_SESSION_TABLES]).toContain(table);
    await ds.query(sql, params());
    const before = await ds.query(`SELECT * FROM \`${table}\` WHERE company_id=?`, [companyId]);
    try {
      await expect(cutoverTables(ds)).rejects.toThrow(/兼容模块已有数据/);
      await expect(run()).rejects.toThrow(/兼容模块已有数据/);
      expect(await ds.query(`SELECT * FROM \`${table}\` WHERE company_id=?`, [companyId])).toEqual(before);
    } finally { await ds.query(`DELETE FROM \`${table}\` WHERE company_id=?`, [companyId]); }
  });

  it('runCutover在任何DELETE之前以真实RR间隙锁阻止并发迁入，回滚后可写', async () => {
    const second = ds.createQueryRunner(); await second.connect();
    const [previous] = await second.query('SELECT @@session.innodb_lock_wait_timeout AS seconds');
    await second.query('SET SESSION innodb_lock_wait_timeout=1');
    let reached!: () => void, release!: () => void, paused = false, deleted = false, holderConnection = 0, isolation = '';
    const reachedGuard = new Promise<void>(resolve => { reached = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const lockedTables = new Set<string>();
    const createRunner = ds.createQueryRunner.bind(ds);
    const runnerSpy = jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
      const q = createRunner(...args), query = q.query.bind(q), find = q.manager.find.bind(q.manager);
      jest.spyOn(q, 'query').mockImplementation((async (sql: string, params?: any[], structured?: boolean) => {
        if (/^\s*DELETE\s/i.test(sql)) deleted = true;
        const result = await (query as any)(sql, params, structured);
        const match = /^SELECT 1 occupied FROM `(sm_legacy_[a-z_]+)` LIMIT 1 FOR UPDATE$/.exec(sql);
        if (match && q.isTransactionActive) lockedTables.add(match[1]);
        return result;
      }) as any);
      jest.spyOn(q.manager, 'find').mockImplementation((async (...findArgs: any[]) => {
        // This is the first real operation after runCutover's 17 empty-table
        // current reads. Pause here, before technical snapshots or any deletion.
        if (!paused && q.isTransactionActive && findArgs[0] === Company) {
          paused = true;
          const [identity] = await q.query('SELECT CONNECTION_ID() id, @@transaction_isolation isolation_level');
          holderConnection = Number(identity.id); isolation = identity.isolation_level;
          reached(); await resume;
          throw new Error('synthetic-rollback-after-empty-table-guards');
        }
        return (find as any)(...findArgs);
      }) as any);
      return q;
    });
    const outcome = run().then(() => new Error('Expected deliberate cutover rollback'), error => error as Error);
    try {
      await Promise.race([reachedGuard, outcome.then(error => { throw error; })]);
      expect([...lockedTables].sort()).toEqual([...LEGACY_SESSION_TABLES].sort());
      expect(deleted).toBe(false); expect(isolation).toBe('REPEATABLE-READ');
      const [other] = await second.query('SELECT CONNECTION_ID() id');
      expect(Number(other.id)).not.toBe(holderConnection);
      const insert = 'INSERT INTO sm_legacy_company_adoptions (company_id,actor_id,applied_at,source_hash) VALUES (?,1,CURRENT_TIMESTAMP(3),?)';
      await expect(second.query(insert, [companyId, 'd'.repeat(64)])).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' });
      release();
      expect((await outcome).message).toBe('synthetic-rollback-after-empty-table-guards');
      await second.query(insert, [companyId, 'd'.repeat(64)]);
      expect(Number((await second.query('SELECT COUNT(*) n FROM sm_legacy_company_adoptions WHERE company_id=?', [companyId]))[0].n)).toBe(1);
      await second.query('DELETE FROM sm_legacy_company_adoptions WHERE company_id=?', [companyId]);
    } finally {
      release(); await outcome; runnerSpy.mockRestore();
      await second.query('SET SESSION innodb_lock_wait_timeout=?', [Number(previous.seconds)]);
      await second.release();
    }
  });
});
