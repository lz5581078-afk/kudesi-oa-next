import 'reflect-metadata';
import { parseWeightScope } from '../integrations/express-recognition';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions, alignSessionTimeZone } from '../database/data-source';
import { loadEnv } from '../config/env';
import { CryptoService } from '../common/crypto.service';
import { FilesService, defaultStorageFactory } from '../integrations/files.service';
import { IntegrationSettingsService } from '../integrations/integration-settings.service';
import { IntegrationSetting, ResourceChangeLog } from '../entities';
import { ResourcesService } from '../resources/resources.service';
import { MigrationError, runLegacyImport, safeFailure } from '../migration/runner';
import { LegacyArchive } from '../migration/protocol';
import { RESOURCE_DEFS } from '@kudesi/shared';

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => { const i = args.indexOf(name); if (i < 0 || !args[i+1]) throw new MigrationError('缺少必填参数'); return args[i+1]; };
  const sourceCompanyId = Number(arg('--source-company'));
  const companyId = Number(arg('--company'));
  const actorId = Number(arg('--actor'));
  const expectedName = arg('--expected-name');
  const apply = args.includes('--apply');
  const report=resolve(arg('--report'));
  const expectedReport=args.includes('--expected-report')?JSON.parse(readFileSync(resolve(arg('--expected-report')),'utf8')):undefined;
  if(apply&&!expectedReport)throw new MigrationError('正式/隔离试迁apply必须指定已核对报告');
  writeFileSync(report,JSON.stringify({phase:'started; not committed'}),{mode:0o600,flag:'wx'});
  if (![sourceCompanyId, companyId, actorId].every((n) => Number.isInteger(n) && n > 0)) throw new MigrationError('公司或操作人ID无效');
  const env = loadEnv();
  if (apply && arg('--confirm') !== `${env.db.name}:${companyId}:${sourceCompanyId}`) throw new MigrationError('导入确认与目标库/公司不一致');
  const adapterPath = resolve(arg('--adapter'));
  const adapter = createRequire(adapterPath)(adapterPath) as { read: (opts: { sourceCompanyId: number; definitions: typeof RESOURCE_DEFS; parseWeightScope: typeof parseWeightScope }) => Promise<LegacyArchive> };
  const source = await adapter.read({ sourceCompanyId, definitions: RESOURCE_DEFS, parseWeightScope });
  if (source.company.id !== sourceCompanyId) throw new MigrationError('来源公司不一致');
  const ds = await alignSessionTimeZone(await new DataSource(buildDataSourceOptions()).initialize());
  try {
    if (await ds.showMigrations()) throw new MigrationError('目标库有未执行的结构迁移；CLI不自动迁移');
    const crypto = new CryptoService(env.encryptionKeys, env.encryptionActiveKeyId);
    const settings = new IntegrationSettingsService(ds.getRepository(IntegrationSetting), ds.getRepository(ResourceChangeLog), crypto);
    const files = new FilesService(ds, settings, defaultStorageFactory);
    const result = await runLegacyImport(ds, new ResourcesService(ds, crypto, files), files, source, { companyId, actorId, expectedName, apply, expectedReport, prepareReport:(r)=>writeFileSync(report,JSON.stringify({...r,phase:'prepared; not committed'},null,2),{mode:0o600}) });
    try { writeFileSync(report, JSON.stringify(result, null, 2), { mode: 0o600 }); }
    catch { console.error(apply?'数据事务已提交，但最终报告写入失败；请保留prepared报告并核对迁移审计':'试跑已回滚，最终报告写入失败');process.exitCode=1;return; }
    console.log(JSON.stringify({ phase: result.phase, created: result.created, reused: result.reused, failed: result.failures.length, excluded: result.excluded.length }));
  } finally { await ds.destroy(); }
}
main().catch((e) => { console.error('迁移批次已停止：', safeFailure(e)); process.exitCode = 1; });
