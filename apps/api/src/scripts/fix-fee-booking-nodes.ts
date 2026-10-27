import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions, alignSessionTimeZone } from '../database/data-source';
import { loadEnv } from '../config/env';
import { CryptoService } from '../common/crypto.service';
import { FilesService, defaultStorageFactory } from '../integrations/files.service';
import { IntegrationSettingsService } from '../integrations/integration-settings.service';
import { IntegrationSetting, ResourceChangeLog, User } from '../entities';
import { ResourcesService } from '../resources/resources.service';
import { applyFeeBookingFix, planFeeBookingFix } from '../resources/fee-booking-fix';

/** 用法：node dist/scripts/fix-fee-booking-nodes.js --company <ID> [--actor <管理员ID> --apply --confirm <库名:公司ID>]  默认只出计划，不改数据。执行前先备份数据库。 */
async function main() {
  const args = process.argv.slice(2);
  const arg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const companyId = Number(arg('--company'));
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error('缺少 --company');
  const env = loadEnv();
  const ds = await alignSessionTimeZone(await new DataSource(buildDataSourceOptions()).initialize());
  try {
    const plan = await planFeeBookingFix(ds.manager, companyId);
    console.log(`默认挂账节点被丢成“不固定”的费用项：${plan.length} 个`);
    for (const p of plan) console.log(`  ${p.code} ${p.name}：${p.from} → ${p.to}`);
    if (!args.includes('--apply')) { console.log('\n以上只是计划，未改任何数据。确认后加 --apply --actor <管理员ID> --confirm <库名:公司ID> 执行。'); return; }
    if (arg('--confirm') !== `${env.db.name}:${companyId}`) throw new Error('--confirm 与目标库/公司不一致');
    const actor = await ds.manager.findOneByOrFail(User, { id: Number(arg('--actor')), companyId, isCompanyAdmin: true, status: 'active' });
    const crypto = new CryptoService(env.encryptionKeys, env.encryptionActiveKeyId);
    const settings = new IntegrationSettingsService(ds.getRepository(IntegrationSetting), ds.getRepository(ResourceChangeLog), crypto);
    const files = new FilesService(ds, settings, defaultStorageFactory);
    const done = await applyFeeBookingFix(ds, new ResourcesService(ds, crypto, files), { id: actor.id, companyId, name: actor.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } }, plan);
    console.log('已执行：', JSON.stringify(done));
  } finally { await ds.destroy(); }
}
main().catch((e) => { console.error('已停止：', e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
