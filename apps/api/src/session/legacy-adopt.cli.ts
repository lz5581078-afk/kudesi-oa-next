import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { DataSource } from 'typeorm';
import { CryptoService } from '../common/crypto.service';
import { loadEnv } from '../config/env';
import { Company } from '../entities';
import { migrationSoftwareFingerprint } from '../migration/software-fingerprint';
import { LegacyStore } from './legacy-store';
import { LegacyAdoptionService } from './legacy-adoption';
import { validOldStoreId } from './legacy-identity';
class LegacyAdoptionCliError extends Error {}

/** Explicit operational entry point. Default preview only; never runs at startup
 * or changes engine configuration, installs/rebinds devices, reads cookies or replays tasks. */
export async function prepareLegacyAdoption(args: string[]) {
  const value = (name: string) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`缺少 ${name}`); return args[index + 1]; };
  const companyId = Number(value('--company')), actorId = Number(value('--actor'));
  if (![companyId, actorId].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('公司或执行人编号无效');
  if (path.extname(__filename) !== '.js') throw new Error('请先构建API，使用同一份编译产物预览与执行');
  const reportPath = path.resolve(value('--report')), expectedName = value('--expected-name'), apply = args.includes('--apply');
  const env = loadEnv();
  const { buildDataSourceOptions, alignSessionTimeZone } = await import('../database/data-source');
  const ds = await alignSessionTimeZone(await new DataSource(buildDataSourceOptions()).initialize());
  try {
    if (await ds.showMigrations()) throw new Error('结构迁移尚未完成，本工具不会自动修改表结构');
    const company = await ds.manager.findOneBy(Company, { id: companyId, status: 'active' });
    if (!company || company.name !== expectedName) throw new Error('公司身份核对失败');
    const store = new LegacyStore(ds, new CryptoService(env.encryptionKeys, env.encryptionActiveKeyId));
    const user = await store.sessionOwner(companyId, actorId);
    if (!user) throw new Error('执行人当前不可用');
    const service = new LegacyAdoptionService(store), preview = await service.preview(user);
    if (preview.alreadyApplied && preview.currentSourceHash !== preview.sourceHash) throw new LegacyAdoptionCliError('原登录资料在迁入后发生变化，已停止；先核对差异，不覆盖任一侧');
    const softwareHash = migrationSoftwareFingerprint(__filename);
    let backupDigest: string | null = null;
    if (apply) {
      const expected = JSON.parse(readFileSync(path.resolve(value('--expected-report')), 'utf8'));
      const confirm = `${env.db.name}:${companyId}:both-session-workspaces`;
      if (value('--confirm') !== confirm || expected.applied || expected.database !== env.db.name || expected.companyId !== companyId || expected.actorId !== actorId || expected.softwareHash !== softwareHash || expected.preview.sourceHash !== preview.sourceHash) throw new Error('预览或库/公司/代码确认不匹配');
      // This is an explicit verified-source-domain assertion, not an assumption
      // that arbitrary old local Profile keys can never enter our reserved range.
      const verifiedMax = Number(value('--verified-old-max-store-id'));
      if (!validOldStoreId(verifiedMax)) throw new Error('需先核实旧来源最大店铺编号低于新编号保留段');
      const [known] = await ds.query("SELECT MAX(CAST(SUBSTRING_INDEX(source_key,':',-1) AS UNSIGNED)) AS maxId FROM legacy_import_links WHERE company_id=? AND source_system='legacy-oa' AND target_type='stores' AND source_key REGEXP '^stores:[0-9]+$'", [companyId]);
      if (Number(known.maxId ?? 0) > verifiedMax) throw new Error('旧来源编号核实值小于现有账本，已停止');
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(path.resolve(value('--target-backup')))) hash.update(bytes);
      backupDigest = hash.digest('hex');
      if (backupDigest !== value('--target-backup-sha256')) throw new Error('目标备份摘要不匹配');
    }
    // Reserve the report before any adoption commit; never overwrite evidence.
    writeFileSync(reportPath, JSON.stringify({ phase: 'started; outcome unknown until finalized', apply, database: env.db.name, companyId, actorId, softwareHash, sourceHash: preview.sourceHash }), { flag: 'wx', mode: 0o600 });
    let result;
    try { result = apply ? await service.adopt(user, preview.sourceHash, `company:${companyId}:both-session-workspaces`) : preview; }
    catch { throw new LegacyAdoptionCliError('迁入执行结果未确认，请先核对公司adoption记录和审计；不要直接重试或开启引擎'); }
    const report = { version: 1, database: env.db.name, companyId, actorId, softwareHash, backupDigest, applied: apply, preview: result };
    try { writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 }); }
    catch { throw new LegacyAdoptionCliError(apply ? '事务已提交但报告写入失败，请先核对迁入审计，勿直接重试或开启引擎' : '预览报告写入失败'); }
    // Only counts/digests, never credentials or device tokens.
    console.log(JSON.stringify(report));
  } finally { await ds.destroy(); }
}

if (require.main === module) void prepareLegacyAdoption(process.argv.slice(2)).catch(error => {
  console.error(error instanceof LegacyAdoptionCliError ? error.message : '店铺登录兼容准备已停止；请核对参数、预览/备份和服务器审计，不输出数据库参数或明文。');
  process.exitCode = 1;
});
