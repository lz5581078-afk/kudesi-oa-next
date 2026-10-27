import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions, alignSessionTimeZone } from '../database/data-source';
import { loadEnv } from '../config/env';
import { CryptoService } from '../common/crypto.service';
import { FilesService, defaultStorageFactory } from '../integrations/files.service';
import { IntegrationSettingsService } from '../integrations/integration-settings.service';
import { IntegrationSetting, ResourceChangeLog, User } from '../entities';
import { ResourcesService } from '../resources/resources.service';
import { applyStoreFundBackfill, planStoreFundBackfill } from '../resources/store-funds';

/**
 * 店铺资金口径改为“以最新资金快照为准”之后，把以前手填在店铺档案里的保证金/冻结/货款/推广余额补成一条“旧系统档案登记”快照并清掉手填值。
 * 用法：node dist/scripts/backfill-store-funds.js --company <ID> [--actor <管理员ID> --apply --confirm <库名:公司ID>]  默认只出计划。执行前先备份数据库。
 */
async function main() {
  const args = process.argv.slice(2);
  const arg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const companyId = Number(arg('--company'));
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error('缺少 --company');
  const env = loadEnv();
  const ds = await alignSessionTimeZone(await new DataSource(buildDataSourceOptions()).initialize());
  try {
    const plan = await planStoreFundBackfill(ds.manager, companyId);
    console.log(`店铺档案里还有手填资金的店铺：${plan.length} 个（其中要补快照 ${plan.filter((p) => p.date).length} 个，已有快照只清手填值）`);
    for (const p of plan) console.log(`  #${p.storeId} ${p.title}  ${p.date ? `补快照 ${p.date}` : '已有快照，只清手填值'}`);
    if (!args.includes('--apply')) { console.log('\n以上只是计划，未改任何数据。确认后加 --apply --actor <管理员ID> --confirm <库名:公司ID> 执行。'); return; }
    if (arg('--confirm') !== `${env.db.name}:${companyId}`) throw new Error('--confirm 与目标库/公司不一致');
    const actor = await ds.manager.findOneByOrFail(User, { id: Number(arg('--actor')), companyId, isCompanyAdmin: true, status: 'active' });
    const crypto = new CryptoService(env.encryptionKeys, env.encryptionActiveKeyId);
    const settings = new IntegrationSettingsService(ds.getRepository(IntegrationSetting), ds.getRepository(ResourceChangeLog), crypto);
    const files = new FilesService(ds, settings, defaultStorageFactory);
    const done = await ds.transaction((em) => applyStoreFundBackfill(em, new ResourcesService(ds, crypto, files), { id: actor.id, companyId, name: actor.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } }, plan));
    console.log('已执行：', JSON.stringify(done));
  } finally { await ds.destroy(); }
}
main().catch((e) => { console.error('已停止：', e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
