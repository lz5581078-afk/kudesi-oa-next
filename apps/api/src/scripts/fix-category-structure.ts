import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions, alignSessionTimeZone } from '../database/data-source';
import { loadEnv } from '../config/env';
import { CryptoService } from '../common/crypto.service';
import { FilesService, defaultStorageFactory } from '../integrations/files.service';
import { IntegrationSettingsService } from '../integrations/integration-settings.service';
import { IntegrationSetting, ResourceChangeLog, User } from '../entities';
import { ResourcesService } from '../resources/resources.service';
import { applyCategoryFix, planCategoryFix } from '../resources/category-structure-fix';

/** 用法：node dist/scripts/fix-category-structure.js --company <ID> [--actor <管理员ID> --apply --confirm <库名:公司ID>]  默认只出计划，不改数据。执行前先备份数据库。 */
async function main() {
  const args = process.argv.slice(2);
  const arg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const companyId = Number(arg('--company'));
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error('缺少 --company');
  const env = loadEnv();
  const ds = await alignSessionTimeZone(await new DataSource(buildDataSourceOptions()).initialize());
  try {
    const plan = await planCategoryFix(ds.manager, companyId);
    console.log('OEM 包装分类树：');
    for (const m of plan.oem) console.log(`  ${m.decision === 'move' ? '改为独立' : m.decision === 'keep' ? '保留在产品包装' : '【需人工确认】'}  ${m.rootTitle}（共 ${m.ids.length} 个分类，OEM 商品 ${m.oemProducts}，产品包装商品 ${m.packageProducts}）`);
    console.log(`被压成一个名字的供应商/客户分类：${plan.split.length} 个`);
    for (const s of plan.split) console.log(`  ${s.type} #${s.id}  “${s.title}” → ${s.parts.join(' ▸ ')}`);
    if (!args.includes('--apply')) { console.log('\n以上只是计划，未改任何数据。确认后加 --apply --actor <管理员ID> --confirm <库名:公司ID> 执行。'); return; }
    if (arg('--confirm') !== `${env.db.name}:${companyId}`) throw new Error('--confirm 与目标库/公司不一致');
    const actor = await ds.manager.findOneByOrFail(User, { id: Number(arg('--actor')), companyId, isCompanyAdmin: true, status: 'active' });
    const crypto = new CryptoService(env.encryptionKeys, env.encryptionActiveKeyId);
    const settings = new IntegrationSettingsService(ds.getRepository(IntegrationSetting), ds.getRepository(ResourceChangeLog), crypto);
    const files = new FilesService(ds, settings, defaultStorageFactory);
    const done = await applyCategoryFix(ds, new ResourcesService(ds, crypto, files), { id: actor.id, companyId, name: actor.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } }, plan);
    console.log('已执行：', JSON.stringify(done));
  } finally { await ds.destroy(); }
}
main().catch((e) => { console.error('已停止：', e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
