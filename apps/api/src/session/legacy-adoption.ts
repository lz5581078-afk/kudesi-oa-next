import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Company, ResourceRecord, SessionDevice, SessionShop, User } from '../entities';
import { LegacyStore, SessionWorkspace } from './legacy-store';
import { LEGACY_NEW_STORE_BASE, newLegacyStoreId, validOldStoreId } from './legacy-identity';

const WORKSPACES: SessionWorkspace[] = ['finance_withdrawal', 'company_store_maintenance'];
const ACTIVE_UPDATES = new Set(['queued', 'downloading', 'verifying', 'staged', 'applying', 'restarting']);
export interface LegacyAdoptionPreview {
  companyId: number; actorId: number; sourceHash: string; currentSourceHash: string; alreadyApplied: boolean;
  shops: number; devicesPerWorkspace: number; preservedLegacyStoreIds: number; blockers: string[]; warnings: string[];
}
type SourceLink = { source_company_id: number; source_key: string; target_id: number };
function fingerprint(companyId: number, actorId: number, shops: SessionShop[], devices: SessionDevice[], links: SourceLink[], active: number[]) {
  // Only native session source state is frozen. Master-data names/statuses remain
  // live through the views and must not invalidate a legitimate legacy edit.
  return createHash('sha256').update(JSON.stringify({ actorId, companyId, newStoreBase: LEGACY_NEW_STORE_BASE, shops,
    devices: devices.map(({ tokenHash: _token, lastSeenAt: _heartbeat, ...d }) => d), links, active })).digest('hex');
}

type StoreMappingRow = { id: number; record_id: number; company_id: number };
async function inspectStoreMappings(em: EntityManager, companyId: number, input: number[], lock = false) {
  const recordIds = [...new Set(input)].sort((a, b) => a - b);
  const blockers: string[] = [], desired = new Map<number, number>(), preferred = new Map<number, number>();
  if (recordIds.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff)) throw new ConflictException('店铺资料编号无效');
  if (!recordIds.length) return { blockers, desired, preferred, existing: [] as StoreMappingRow[] };
  const records: Array<{ id: number }> = await em.query(`SELECT id FROM resource_records WHERE company_id=? AND type='stores' AND id IN (?) ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [companyId, recordIds]);
  if (records.length !== recordIds.length) blockers.push('存在不属于本公司的店铺档案，禁止建立身份映射');
  const links: SourceLink[] = await em.query("SELECT source_company_id,source_key,target_id FROM legacy_import_links WHERE source_system='legacy-oa' AND company_id=? AND target_type='stores' AND target_id IN (?) ORDER BY source_company_id,source_key", [companyId, recordIds]);
  const existing: StoreMappingRow[] = await em.query(`SELECT id,record_id,company_id FROM sm_legacy_store_ids WHERE company_id=? AND record_id IN (?) ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [companyId, recordIds]);
  for (const recordId of recordIds) {
    const sources = links.filter(l => Number(l.target_id) === recordId);
    if (sources.length > 1) { blockers.push(`店铺档案 ${recordId} 的旧编号来源不唯一`); continue; }
    let id: number;
    if (sources.length) {
      const source = sources[0].source_key;
      id = Number(source.slice(7));
      if (!/^stores:[1-9]\d*$/.test(source) || !validOldStoreId(id)) {
        blockers.push(`店铺档案 ${recordId} 的旧编号不是正安全整数或进入新编号保留段，需核实原始来源`); continue;
      }
      preferred.set(recordId, id);
    } else id = newLegacyStoreId(recordId);
    if ([...desired].some(([other, otherId]) => other !== recordId && otherId === id)) blockers.push(`旧店铺编号 ${id} 对应多份新档案，禁止猜测`);
    desired.set(recordId, id);
    const previous = existing.find(m => Number(m.record_id) === recordId);
    if (previous && Number(previous.id) !== id) blockers.push(`店铺档案 ${recordId} 的既有编号与来源/保留段规则冲突，禁止复用历史Profile`);
    const [occupied] = await em.query(`SELECT id FROM sm_legacy_store_ids WHERE id=? AND (company_id<>? OR record_id<>?) LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id, companyId, recordId]);
    if (occupied) blockers.push(`店铺登录编号 ${id} 已归属另一份档案，禁止覆盖`);
  }
  return { blockers, desired, preferred, existing };
}

/** Shared by explicit adoption and normal candidate discovery. No name matching,
 * no store business record changes, no low-number allocation without a ledger. */
export async function ensureLegacyStoreMappings(em: EntityManager, companyId: number, recordIds: number[]): Promise<Map<number, number>> {
  if (!em.queryRunner?.isTransactionActive) throw new ConflictException('建立店铺身份映射必须使用事务');
  const plan = await inspectStoreMappings(em, companyId, recordIds, true);
  if (plan.blockers.length) throw new ConflictException(plan.blockers.join('；'));
  for (const [recordId, id] of plan.desired) {
    if (plan.existing.some(m => Number(m.record_id) === recordId)) continue;
    try { await em.query('INSERT INTO sm_legacy_store_ids (id,record_id,company_id) VALUES (?,?,?)', [id, recordId, companyId]); }
    catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new ConflictException('店铺身份映射已发生变化，请刷新核实');
      throw error;
    }
  }
  return plan.desired;
}
/** Activation fence helper: no store.engine(), permissions or mutation. Use the
 * actor_id saved in the adoption marker, not the currently browsing employee. */
export async function legacyAdoptionFingerprint(ds: DataSource, companyId: number, actorId: number): Promise<string> {
  return ds.transaction('REPEATABLE READ', async em => {
    const shops = await em.find(SessionShop, { where: { companyId }, order: { id: 'ASC' } });
    const devices = await em.find(SessionDevice, { where: { companyId }, order: { id: 'ASC' } });
    const links: SourceLink[] = await em.query("SELECT source_company_id,source_key,target_id FROM legacy_import_links WHERE source_system='legacy-oa' AND company_id=? AND target_type='stores' ORDER BY source_company_id,source_key", [companyId]);
    const requests = await em.query("SELECT id FROM session_open_requests WHERE company_id=? AND status IN ('pending','claimed') LIMIT 1", [companyId]);
    const remotes = await em.query("SELECT id FROM session_remote_sessions WHERE company_id=? AND status IN ('requested','active') LIMIT 1", [companyId]);
    return fingerprint(companyId, actorId, shops, devices, links, [requests.length, remotes.length, devices.filter(d => ACTIVE_UPDATES.has(d.updateStatus ?? '')).length]);
  });
}

/** Explicit company-scoped adoption only. Not called by startup, migrations or a
 * normal page request. The native records and all browser data remain untouched. */
@Injectable()
export class LegacyAdoptionService {
  constructor(private readonly store: LegacyStore) {}

  private async actor(em: EntityManager, user: AuthUser) {
    const can = createChecker(user.permissions);
    if (!user.permissions.isCompanyAdmin || !can('finance.session.manage') || !can('resource.company-store-maintenance.manage')) {
      throw new ForbiddenException('仅有两个工作区管理权限的公司管理员可以迁入');
    }
    const actor = await em.findOne(User, { where: { id: user.id, companyId: user.companyId, status: 'active', isCompanyAdmin: true } });
    const company = await em.findOne(Company, { where: { id: user.companyId, status: 'active' } });
    if (!actor || !company) throw new ForbiddenException('公司或执行管理员不可用');
  }

  private async inspect(em: EntityManager, user: AuthUser, lock = false) {
    const shops = await em.find(SessionShop, { where: { companyId: user.companyId }, order: { id: 'ASC' } });
    const devices = await em.find(SessionDevice, { where: { companyId: user.companyId }, order: { id: 'ASC' } });
    if (lock) {
      await em.query('SELECT id FROM session_shops WHERE company_id = ? FOR UPDATE', [user.companyId]);
      await em.query('SELECT id FROM session_devices WHERE company_id = ? FOR UPDATE', [user.companyId]);
    }
    const records = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'stores' }, order: { id: 'ASC' } });
    const links: SourceLink[] = await em.query(
      "SELECT source_company_id,source_key,target_id FROM legacy_import_links WHERE source_system = 'legacy-oa' AND company_id = ? AND target_type = 'stores' ORDER BY source_company_id,source_key", [user.companyId]);
    const [applied] = await em.query('SELECT source_hash,actor_id FROM sm_legacy_company_adoptions WHERE company_id = ?', [user.companyId]);
    const blockers: string[] = [];
    const recordMap = new Map(records.map(r => [r.id, r]));
    for (const shop of shops) {
      if (!WORKSPACES.includes(shop.workspace as SessionWorkspace)) blockers.push(`店铺管理记录 ${shop.id} 的用途未知`);
      if (!recordMap.has(shop.storeId)) blockers.push(`店铺管理记录 ${shop.id} 的本公司档案缺失`);
      if (shop.status === 'active' && recordMap.get(shop.storeId)?.archivedAt) blockers.push(`店铺管理记录 ${shop.id} 对应已归档档案`);
      if (shop.deviceId && !devices.some(d => d.id === shop.deviceId)) blockers.push(`店铺管理记录 ${shop.id} 的负责电脑不属于本公司`);
      if (shop.loginPasswordEnc) {
        try { this.store.crypto.decrypt(shop.loginPasswordEnc); } catch { blockers.push(`店铺管理记录 ${shop.id} 的凭据无法校验`); }
      }
    }
    const mapping = await inspectStoreMappings(em, user.companyId, shops.map(s => s.storeId), lock);
    blockers.push(...mapping.blockers);
    const activeRequests = await em.query("SELECT id FROM session_open_requests WHERE company_id = ? AND status IN ('pending','claimed') LIMIT 1", [user.companyId]);
    const activeRemote = await em.query("SELECT id FROM session_remote_sessions WHERE company_id = ? AND status IN ('requested','active') LIMIT 1", [user.companyId]);
    if (activeRequests.length || activeRemote.length) blockers.push('仍有原版登录、截图或远程任务进行中，请结束后重新预览');
    const activeUpdates = devices.filter(d => ACTIVE_UPDATES.has(d.updateStatus ?? '')).length;
    if (activeUpdates) blockers.push('仍有原助手升级任务进行中，请完成或取消后重新预览');
    if (!applied) {
      const [target] = await em.query('SELECT (SELECT COUNT(*) FROM sm_legacy_session_devices WHERE company_id = ?) + (SELECT COUNT(*) FROM sm_legacy_session_managed_shops WHERE company_id = ?) AS n', [user.companyId, user.companyId]);
      if (Number(target.n)) blockers.push('兼容工作区已有未归账设备或店铺，禁止覆盖');
    }
    // Hashes bind preview to exact source content without returning any credentials.
    const actorId = Number(applied?.actor_id ?? user.id);
    const sourceHash = fingerprint(user.companyId, actorId, shops, devices, links, [activeRequests.length, activeRemote.length, activeUpdates]);
    return { shops, devices, preview: { companyId: user.companyId, actorId, sourceHash: applied?.source_hash ?? sourceHash, currentSourceHash: sourceHash,
      alreadyApplied: !!applied, shops: shops.length, devicesPerWorkspace: devices.length,
      preservedLegacyStoreIds: mapping.preferred.size, blockers: [...new Set(blockers)],
      warnings: [`正式切换前必须核实旧来源店铺ID最大值小于 ${LEGACY_NEW_STORE_BASE}；当前只校验已登记来源，不能据此保证未核实设备上的任意历史Profile编号都安全`] } satisfies LegacyAdoptionPreview };
  }

  async preview(user: AuthUser): Promise<LegacyAdoptionPreview> {
    return this.store.ds.transaction('REPEATABLE READ', async em => { await this.actor(em, user); return (await this.inspect(em, user)).preview; });
  }

  async adopt(user: AuthUser, expectedHash: string, confirm: string): Promise<LegacyAdoptionPreview> {
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || confirm !== `company:${user.companyId}:both-session-workspaces`) {
      throw new ConflictException('需要有效预览摘要与当前公司双工作区确认');
    }
    return this.store.ds.transaction('SERIALIZABLE', async em => {
      await this.actor(em, user);
      await em.query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [user.companyId]);
      const result = await this.inspect(em, user, true), p = result.preview;
      if (p.alreadyApplied) {
        if (p.sourceHash !== expectedHash) throw new ConflictException('迁入已完成，但提供的预览不属于这次迁入');
        return p; // Never overwrite subsequent edits or create a second device set.
      }
      if (p.sourceHash !== expectedHash) throw new ConflictException('预览后资料发生变化，请重新预览');
      if (p.blockers.length) throw new ConflictException(p.blockers.join('；'));
      const ids = await ensureLegacyStoreMappings(em, user.companyId, result.shops.map(s => s.storeId));
      const publicKey = result.devices.length ? generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).publicKey : '';
      for (const ws of WORKSPACES) {
        await em.query('INSERT INTO sm_legacy_session_workspaces (company_id,workspace_key,name,permission_key,status) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id',
          [user.companyId, ws, ws === 'finance_withdrawal' ? '店铺提现' : '公司店铺维护', ws === 'finance_withdrawal' ? 'finance.session-manager.manage' : 'resources.company-store-maintenance.manage', 'active']);
        const [workspace] = await em.query('SELECT id FROM sm_legacy_session_workspaces WHERE company_id = ? AND workspace_key = ?', [user.companyId, ws]);
        const deviceIds = new Map<number, string>();
        for (const d of result.devices) {
          const id = randomUUID(); deviceIds.set(d.id, id);
          await em.query(`INSERT INTO sm_legacy_session_devices
            (id,company_id,workspace_id,registered_by_employee_id,device_code,name,remark,hostname,platform,arch,agent_version,public_key_pem,token_hash,status,last_seen_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
            [id, user.companyId, workspace.id, user.id, randomBytes(9).toString('hex').slice(0, 12).toUpperCase(), d.name, d.remark,
              `native-record-${d.id}`, /^win/i.test(d.os ?? '') ? 'win32' : 'unknown', 'unknown', d.agentVersion ?? 'unknown', publicKey,
              createHash('sha256').update(randomBytes(48)).digest('hex'), d.status === 'deleted' ? 'deleted' : 'revoked']);
        }
        for (const s of result.shops.filter(s => s.workspace === ws)) {
          await em.query(`INSERT INTO sm_legacy_session_managed_shops
            (company_id,workspace_id,store_id,added_by_employee_id,status,assigned_device_id,assigned_by_employee_id,assigned_at,withdrawal_login_account,withdrawal_login_password,auto_login_enabled)
            VALUES (?,?,?,?,?,?,?,IF(? IS NULL,NULL,CURRENT_TIMESTAMP),?,?,?)`,
            [user.companyId, workspace.id, ids.get(s.storeId), user.id, s.status, s.deviceId ? deviceIds.get(s.deviceId) : null,
              s.deviceId ? user.id : null, s.deviceId, s.loginAccount, s.loginPasswordEnc, s.autoLogin ? 1 : 0]);
        }
      }
      await em.query('INSERT INTO sm_legacy_company_adoptions (company_id,actor_id,applied_at,source_hash) VALUES (?,?,CURRENT_TIMESTAMP(3),?)', [user.companyId, user.id, p.sourceHash]);
      await em.query(`INSERT INTO sm_legacy_session_audit_logs (company_id,workspace_id,employee_id,event_type,outcome,summary)
        SELECT ?,id,?,'oa_company_adopted','success',? FROM sm_legacy_session_workspaces WHERE company_id = ?`,
        [user.companyId, user.id, `兼容迁入完成：${p.shops}条店铺记录；负责电脑保留为已撤销，需实际助手重新绑定`, user.companyId]);
      return { ...p, alreadyApplied: true };
    });
  }
}
