import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions, alignSessionTimeZone } from '../database/data-source';
import { loadEnv } from '../config/env';
import { CryptoService } from '../common/crypto.service';
import { migrationSoftwareFingerprint } from '../migration/software-fingerprint';
import { backfillWithdrawal, WithdrawalBackfillError, type WithdrawalSource } from '../migration/withdrawal-backfill';
const hashFile = async (file: string) => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => { const i = args.indexOf(name); if (i < 0 || !args[i+1]) throw new WithdrawalBackfillError('缺少必填参数'); return args[i+1]; };
  const sourceCompanyId = Number(arg('--source-company')), companyId = Number(arg('--company')), actorId = Number(arg('--actor'));
  if (![sourceCompanyId, companyId, actorId].every(n => Number.isSafeInteger(n) && n > 0)) throw new WithdrawalBackfillError('公司/执行人ID无效');
  const apply = args.includes('--apply'), report = resolve(arg('--report')), expectedName = arg('--expected-name');
  const sourceBackup = await hashFile(resolve(arg('--source-backup')));
  if (sourceBackup !== arg('--source-backup-sha256')) throw new WithdrawalBackfillError('来源备份校验失败');
  const env = loadEnv();
  const expected = apply ? JSON.parse(readFileSync(resolve(arg('--expected-report')), 'utf8')) : null;
  const targetBackup = apply ? await hashFile(resolve(arg('--target-backup'))) : undefined;
  if (apply && (arg('--confirm') !== `${env.db.name}:${companyId}:${sourceCompanyId}:finance_withdrawal` || targetBackup !== arg('--target-backup-sha256'))) throw new WithdrawalBackfillError('目标备份或库/公司确认失败');
  writeFileSync(report, JSON.stringify({ phase: 'started; not committed' }), { mode: 0o600, flag: 'wx' });
  const path = resolve(arg('--adapter')), adapterHash = await hashFile(path), softwareHash = migrationSoftwareFingerprint(path);
  const adapter = createRequire(path)(path) as { read(options: { sourceCompanyId: number }): Promise<WithdrawalSource> };
  const source = await adapter.read({ sourceCompanyId });
  if (source.company.id !== sourceCompanyId || source.backupDigest !== sourceBackup || adapterHash !== await hashFile(path) || softwareHash !== migrationSoftwareFingerprint(path)) throw new WithdrawalBackfillError('来源或适配器核对失败');
  if (apply && (!expected || expected.applied || expected.adapterHash !== adapterHash || expected.softwareHash !== softwareHash || expected.sourceHash == null)) throw new WithdrawalBackfillError('缺少本适配器生成的空跑报告');
  const ds = await alignSessionTimeZone(await new DataSource(buildDataSourceOptions()).initialize());
  try {
    if (await ds.showMigrations()) throw new WithdrawalBackfillError('目标库有待执行结构迁移，补迁程序不自动执行');
    const result = await backfillWithdrawal(ds, new CryptoService(env.encryptionKeys, env.encryptionActiveKeyId), source,
      { companyId, actorId, expectedName, apply, expectedFingerprint: expected?.fingerprint, targetBackupDigest: targetBackup });
    try { writeFileSync(report, JSON.stringify({ ...result, adapterHash, softwareHash }, null, 2), { mode: 0o600 }); }
    catch { console.error(result.applied ? '事务已提交，报告写入失败，请核对数据库审计，勿直接重跑' : '空跑已回滚，报告写入失败'); process.exitCode = 1; return; }
    console.log(JSON.stringify(result));
  } finally { await ds.destroy(); }
}
main().catch((error) => { console.error(error instanceof WithdrawalBackfillError ? error.message : '补迁已停止，请在服务器内排查；不输出数据库参数或明文'); process.exitCode = 1; });
