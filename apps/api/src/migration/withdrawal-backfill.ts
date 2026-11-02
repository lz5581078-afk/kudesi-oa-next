import { createHash, randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Company, User, ResourceRecord, SessionDevice, SessionShop, AuditLog } from '../entities';
import { CryptoService } from '../common/crypto.service';
import { preserveSourceRow, sourceRowHash } from './source-rows';

type Row = Record<string, unknown>;
export interface WithdrawalSource {
  company: { id: number; name: string };
  workspace: Row;
  devices: Row[];
  shops: Row[];
  backupDigest: string;
  decryptPassword(value: string): string;
}
export interface WithdrawalOptions { companyId: number; actorId: number; expectedName: string; apply?: boolean; expectedFingerprint?: string; targetBackupDigest?: string }
export class WithdrawalBackfillError extends Error {}
function fail(message: string): never { throw new WithdrawalBackfillError(message); }
const id = (value: unknown) => { const s = String(value ?? ''); if (!/^[A-Za-z0-9-]{1,100}$/.test(s)) fail('来源ID无效'); return s; };
const text = (value: unknown, max: number) => { if (value == null || value === '') return null; if (typeof value !== 'string' || [...value].length > max || value.includes('\0')) fail('来源字段长度或类型超出目标范围，禁止截断'); return value; };
const WS = 'finance_withdrawal';

/** Offline migration only. No server hooks, requests, device credentials or remote sessions are replayed. */
export async function backfillWithdrawal(ds: DataSource, crypto: CryptoService, source: WithdrawalSource, options: WithdrawalOptions) {
  if (!/^[a-f0-9]{64}$/.test(source.backupDigest)) fail('缺少来源冻结备份摘要');
  if (source.company.name !== options.expectedName || !Number.isSafeInteger(source.company.id) || source.company.id < 1) fail('来源公司核对失败');
  if (String(source.workspace.company_id) !== String(source.company.id) || source.workspace.workspace_key !== WS) fail('来源工作区不属于指定公司或店铺提现');
  const deviceIds = new Set<string>(), shopIds = new Set<string>(), storeIds = new Set<string>();
  for (const row of [...source.devices, ...source.shops]) {
    if (String(row.company_id) !== String(source.company.id) || String(row.workspace_id) !== String(source.workspace.id)) fail('来源混有其他公司或工作区');
  }
  for (const row of source.devices) { const key = id(row.id); if (deviceIds.has(key)) fail('来源电脑ID重复'); deviceIds.add(key); }
  for (const row of source.shops) {
    const key = id(row.id), store = id(row.store_id);
    if (shopIds.has(key) || storeIds.has(store)) fail('来源店铺ID或店铺引用重复');
    shopIds.add(key); storeIds.add(store);
    if (!['active', 'removed'].includes(String(row.status))) fail('来源店铺状态无法映射');
    if (row.assigned_device_id != null && !deviceIds.has(id(row.assigned_device_id))) fail('来源负责电脑不在同公司提现工作区');
  }
  const sourceHash = sourceRowHash({ company: source.company, workspace: source.workspace, backup: source.backupDigest,
    devices: [...source.devices].sort((a,b) => id(a.id).localeCompare(id(b.id))), shops: [...source.shops].sort((a,b) => id(a.id).localeCompare(id(b.id))) });
  const q = ds.createQueryRunner(); await q.connect(); await q.startTransaction('SERIALIZABLE');
  try {
    const em = q.manager;
    const company = await em.findOne(Company, { where: { id: options.companyId }, lock: { mode: 'pessimistic_write' } });
    if (!company || company.name !== options.expectedName || company.status !== 'active') fail('目标公司核对失败');
    if (!await em.findOneBy(User, { id: options.actorId, companyId: options.companyId, status: 'active', isCompanyAdmin: true })) fail('执行人不是目标公司在职管理员');
    const links: Array<{ source_key: string; target_type: string; target_id: number; source_hash: string }> = await em.query(
      'SELECT source_key,target_type,target_id,source_hash FROM legacy_import_links WHERE source_system=? AND source_company_id=? AND company_id=? ORDER BY source_key', ['legacy-oa', source.company.id, company.id]);
    const old = new Map(links.map(r => [r.source_key, r]));
    const shops = await em.find(SessionShop, { where: { companyId: company.id }, order: { id: 'ASC' } });
    const devices = await em.find(SessionDevice, { where: { companyId: company.id }, order: { id: 'ASC' } });
    const resources = await em.find(ResourceRecord, { where: { companyId: company.id, type: 'stores' }, order: { id: 'ASC' } });
    const fingerprint = createHash('sha256').update(sourceRowHash(JSON.parse(JSON.stringify({ sourceHash, company: company.id, links, shops, devices,
      stores: resources.map(r => [r.id, r.status]) })))).digest('hex');
    if (options.apply && (!/^[a-f0-9]{64}$/.test(options.targetBackupDigest ?? '') || options.expectedFingerprint !== fingerprint)) fail('缺少目标备份或预览后数据已变化，请重新预览');
    const report = { companyId: company.id, sourceCompanyId: source.company.id, workspace: WS, sourceHash, fingerprint,
      sourceDevices: source.devices.length, sourceShops: source.shops.length, createdDevices: 0, createdShops: 0, reusedDevices: 0, reusedShops: 0, activeShops: 0, removedShops: 0, applied: false };
    const register = async (key: string, type: string, targetId: number, hash: string) => {
      await em.query('INSERT INTO legacy_import_links (source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES (?,?,?,?,?,?,?)', ['legacy-oa', source.company.id, company.id, key, type, targetId, hash]);
    };
    const preserve = async (table: string, row: Row) => preserveSourceRow(em, crypto, { companyId: company.id, sourceCompanyId: source.company.id, table, key: id(row.id) }, row);
    await preserve('session_workspaces', source.workspace);
    const mappedDevices = new Map<string, number>();
    for (const row of source.devices) {
      await preserve('session_devices', row);
      const key = `withdrawal-device:${id(row.id)}`, hash = sourceRowHash(row), previous = old.get(key);
      if (previous) {
        if (previous.target_type !== 'withdrawal-device' || previous.source_hash !== hash || !devices.some(d => d.id === Number(previous.target_id))) fail(`旧电脑 ${id(row.id)} 来源或目标账本冲突`);
        mappedDevices.set(id(row.id), Number(previous.target_id)); report.reusedDevices++; continue;
      }
      if (!['active', 'revoked', 'deleted'].includes(String(row.status))) fail('来源电脑状态无法映射');
      const name = text(row.name, 80); if (!name) fail('来源电脑名称为空');
      const device = await em.save(SessionDevice, em.create(SessionDevice, { companyId: company.id, name, remark: '旧系统迁入；需要重新绑定助手',
        os: text(row.platform, 60), agentVersion: text(row.agent_version, 30), deviceNo: randomBytes(6).toString('hex').toUpperCase(),
        tokenHash: randomBytes(32).toString('hex'), status: row.status === 'deleted' ? 'deleted' : 'revoked', lastSeenAt: null }));
      await register(key, 'withdrawal-device', device.id, hash);
      mappedDevices.set(id(row.id), device.id); report.createdDevices++;
    }
    for (const row of source.shops) {
      await preserve('session_managed_shops', row);
      const key = `withdrawal-shop:${id(row.id)}`, hash = sourceRowHash(row), previous = old.get(key);
      const store = old.get(`stores:${id(row.store_id)}`);
      if (!store || store.target_type !== 'stores' || !resources.some(r => r.id === Number(store.target_id))) fail(`旧店铺 ${id(row.store_id)} 缺少同公司店铺档案映射`);
      if (previous) {
        if (previous.target_type !== 'withdrawal-shop' || previous.source_hash !== hash || !shops.some(s => s.id === Number(previous.target_id) && s.workspace === WS && s.storeId === Number(store.target_id))) fail(`旧提现记录 ${id(row.id)} 来源或目标账本冲突`);
        report.reusedShops++; continue; // User edits after migration remain authoritative.
      }
      if (shops.some(s => s.storeId === Number(store.target_id) && s.workspace === WS)) fail(`旧店铺 ${id(row.store_id)} 在新版已有提现资料，停止补迁以保留现有修改`);
      const account = text(row.withdrawal_login_account, 100), encoded = text(row.withdrawal_login_password, 100000);
      let password: string | null = null;
      if (encoded) { try { password = source.decryptPassword(encoded); } catch { fail(`旧店铺 ${id(row.store_id)} 密码无法解密`); } }
      if (encoded && (typeof password !== 'string' || password.length > 10000)) fail('旧密码内容无效');
      if (![0,1,false,true].includes(row.auto_login_enabled as never)) fail('旧自动登录标记无效');
      const shop = await em.save(SessionShop, em.create(SessionShop, { companyId: company.id, workspace: WS, storeId: Number(store.target_id),
        deviceId: row.assigned_device_id == null ? null : mappedDevices.get(id(row.assigned_device_id))!, loginAccount: account,
        loginPasswordEnc: password ? crypto.encrypt(password) : null, autoLogin: row.auto_login_enabled === 1 || row.auto_login_enabled === true,
        loginState: 'none', lastVerifiedAt: null, status: row.status as 'active' | 'removed' }));
      const verified = await em.findOneByOrFail(SessionShop, { id: shop.id, companyId: company.id });
      if (verified.storeId !== Number(store.target_id) || verified.deviceId !== shop.deviceId || verified.loginAccount !== account
        || verified.autoLogin !== shop.autoLogin || verified.status !== row.status || verified.loginState !== 'none'
        || (verified.loginPasswordEnc ? crypto.decrypt(verified.loginPasswordEnc) : '') !== (password ?? '')) fail(`旧提现记录 ${id(row.id)} 落库回读不一致`);
      password = null;
      await register(key, 'withdrawal-shop', shop.id, hash);
      report.createdShops++; row.status === 'active' ? report.activeShops++ : report.removedShops++;
    }
    if (options.apply) {
      await em.save(AuditLog, em.create(AuditLog, { companyId: company.id, actorId: options.actorId, action: 'migration.withdrawal-backfill', resourceType: 'company', resourceId: String(company.id), detail: { ...report, applied: true, sourceBackupDigest: source.backupDigest, targetBackupDigest: options.targetBackupDigest } }));
      await q.commitTransaction(); report.applied = true;
    } else await q.rollbackTransaction();
    return report;
  } catch (error) { if (q.isTransactionActive) await q.rollbackTransaction(); throw error; }
  finally { await q.release(); }
}
