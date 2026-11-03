import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { createChecker, resolvePermissions, workforceLoginBlock, todayShanghai } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { loadLegacySessionModule } from './legacy-runtime/snapshot';
import { Company, User, PositionPermission, UserPermissionOverride, ResourceRecord } from '../entities';
import { workforceBlockFor } from '../workforce/workforce-contract';
import { remoteGloballyDisabled } from './remote.service';
import { AsyncLocalStorage } from 'node:async_hooks';

export type SessionWorkspace = 'finance_withdrawal' | 'company_store_maintenance';
export interface LegacySqlTx { query(sql: string, params?: any[]): Promise<any[]>; execute(sql: string, params?: any[]): Promise<any> }
const TABLES = ['session_workspaces', 'session_devices', 'session_device_pairings', 'session_managed_shops', 'session_device_shop_bindings',
  'session_versions', 'session_device_keys', 'session_open_requests', 'managed_browser_sessions', 'session_remote_sessions',
  'session_remote_commands', 'session_agent_update_jobs', 'session_audit_logs', 'stores', 'employees', 'companies', 'store_abnormal_reasons'];
const TABLE_TOKENS = new Set(TABLES);
const SQL_TOKEN = /'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"|`[^`]+`|--[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\/|\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
/** Changes trusted, snapshot-owned table identifiers only; values remain bound parameters. */
export const legacySql = (sql: string) => {
  const command = sql.replace(/\/\*[\s\S]*?\*\/|--[^\r\n]*|#[^\r\n]*/g, '');
  if (/^\s*(?:UPDATE|INSERT\s+INTO|REPLACE\s+INTO|DELETE\s+FROM)\s+`?(?:sm_legacy_)?(?:stores|employees|companies|store_abnormal_reasons|resource_change_logs)\b/i.test(command)) {
    throw new ForbiddenException('旧模块不能直接写入新版公共资料');
  }
  return sql.replace(SQL_TOKEN, token => {
    if (token.startsWith('`')) { const name = token.slice(1, -1); return TABLE_TOKENS.has(name) ? `\`sm_legacy_${name}\`` : token; }
    return TABLE_TOKENS.has(token) ? `sm_legacy_${token}` : token;
  });
};
export function workspaceKeys(ws: SessionWorkspace) {
  return ws === 'finance_withdrawal'
    ? { view: 'finance.doc-withdrawal.view', manage: 'finance.session.manage', remote: 'finance.session.remote' }
    : { view: 'resource.company-store-maintenance.view', manage: 'resource.company-store-maintenance.manage', remote: 'resource.company-store-maintenance.remote' };
}

@Injectable()
export class LegacyStore {
  private readonly modules = new Map<string, Record<string, any>>();
  private readonly candidateScope = new AsyncLocalStorage<boolean>();
  constructor(@InjectDataSource() readonly ds: DataSource, readonly crypto: CryptoService) {}

  configured() { return process.env.KUDESI_SESSION_ENGINE === 'legacy'; }
  async engine(user: AuthUser) {
    if (!this.configured()) return 'native' as const;
    const adopted = await this.ds.query('SELECT actor_id,source_hash FROM sm_legacy_company_adoptions WHERE company_id = ?', [user.companyId]);
    if (!adopted.length) throw new ConflictException('此公司的店铺登录资料尚未完成兼容接入，请先执行预览和迁入；原资料未清空');
    const { legacyAdoptionFingerprint } = await import('./legacy-adoption');
    if (await legacyAdoptionFingerprint(this.ds, user.companyId, Number(adopted[0].actor_id)) !== adopted[0].source_hash) {
      throw new ConflictException('原登录管理资料在接入后发生变化，请先核对差异；不会自动覆盖任一侧');
    }
    return 'legacy' as const;
  }
  require(user: AuthUser, ws: SessionWorkspace, action: 'view' | 'manage' | 'remote') {
    const keys = workspaceKeys(ws), can = createChecker(user.permissions);
    if (!can(keys.view) || (action !== 'view' && !can(keys[action]))) throw new ForbiddenException('没有当前工作区的操作权限');
  }
  module(name: string) {
    if (!this.modules.has(name)) this.modules.set(name, loadLegacySessionModule(name));
    return this.modules.get(name)!;
  }
  forMaintenanceCandidates<T>(enabled: boolean, work: () => T): T { return this.candidateScope.run(enabled, work); }
  private sql(text: string) {
    // Preserve the completed maintenance module's broader addable statuses while
    // reusing the original candidate/add transactions. Finance remains normal-only.
    if (this.candidateScope.getStore()) {
      if (/SELECT\s+s\.id,\s*s\.name,\s*s\.store_no[\s\S]*FROM stores s[\s\S]*NOT EXISTS/.test(text)) {
        text = text.replace(/s\.status = 'normal'/, "s.status IN ('normal','abnormal','cancelled','inactive')");
      } else if (/SELECT id, platform FROM stores\s+WHERE company_id = \? AND status = 'normal' AND id IN/.test(text)) {
        text = text.replace(/status = 'normal'/, "status IN ('normal','abnormal','cancelled','inactive')");
      }
    }
    return legacySql(text);
  }
  query = (sql: string, params: any[] = []): Promise<any[]> => this.ds.query(this.sql(sql), params);
  execute = (sql: string, params: any[] = []): Promise<any> => this.ds.query(this.sql(sql), params);
  withTransaction = async <T>(work: (tx: LegacySqlTx) => Promise<T>): Promise<T> => this.ds.transaction(em => work(this.forManager(em)));
  forManager(em: EntityManager): LegacySqlTx {
    return { query: (sql, params = []) => em.query(this.sql(sql), params), execute: (sql, params = []) => em.query(this.sql(sql), params) };
  }
  async workspace(user: AuthUser, key: SessionWorkspace, action: 'view' | 'manage' | 'remote' = 'view') {
    this.require(user, key, action);
    if (await this.engine(user) !== 'legacy') throw new NotFoundException('旧版登录协议尚未启用');
    const [row] = await this.query("SELECT id, workspace_key FROM session_workspaces WHERE company_id = ? AND workspace_key = ? AND status = 'active'", [user.companyId, key]);
    if (!row) throw new NotFoundException('此公司的登录工作区尚未初始化');
    return Number(row.id);
  }
  /** Resolve a previously authenticated session owner again for ticket/lease checks. */
  async sessionOwner(companyId: number, userId: number, em: EntityManager = this.ds.manager, currentRead = false): Promise<AuthUser | null> {
    const uq = em.createQueryBuilder(User, 'u').where('u.id=:userId AND u.companyId=:companyId AND u.status=:status', { userId, companyId, status: 'active' });
    const cq = em.createQueryBuilder(Company, 'c').where('c.id=:companyId AND c.status=:status', { companyId, status: 'active' });
    if (currentRead) { uq.setLock('pessimistic_read'); cq.setLock('pessimistic_read'); }
    const user = await uq.getOne();
    if (!user || !await cq.getOne()) return null;
    if (currentRead && user.employmentType && user.employmentType !== 'regular') {
      const record = await em.createQueryBuilder(ResourceRecord, 'r').where("r.company_id=:companyId AND r.type='workforce' AND r.archived_at IS NULL", { companyId })
        .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data,'$.userId'))=:userId", { userId: String(userId) }).setLock('pessimistic_read').getOne();
      if (record && workforceLoginBlock(record.data, record.status, todayShanghai())) return null;
    } else if (await workforceBlockFor(em, user)) return null;
    const positions = [...new Set([user.positionId, ...(user.extraPositionIds ?? [])].filter((id): id is number => !!id))];
    const pq = em.createQueryBuilder(PositionPermission, 'p').where('p.positionId IN (:...positions)', { positions: positions.length ? positions : [0] });
    const oq = em.createQueryBuilder(UserPermissionOverride, 'o').where('o.userId=:userId', { userId });
    if (currentRead) { pq.setLock('pessimistic_read'); oq.setLock('pessimistic_read'); }
    const permissions = await pq.getMany(), overrides = await oq.getMany();
    return { id: user.id, companyId, name: user.name, permissions: resolvePermissions({ isCompanyAdmin: user.isCompanyAdmin,
      positionPermissions: permissions.map(p => p.permission), overrides: overrides.map(o => ({ permission: o.permission, effect: o.effect })) }) };
  }
  async remoteAllowed(companyId: number, workspaceId: number, deviceId: string, userId: number) {
    if (!this.configured() || remoteGloballyDisabled()) return false;
    const [workspace] = await this.query("SELECT workspace_key FROM session_workspaces WHERE id = ? AND company_id = ? AND status = 'active'", [workspaceId, companyId]);
    const [policy] = await this.ds.query('SELECT enabled, allow_control FROM sm_legacy_remote_policies WHERE company_id = ? AND workspace_id = ? AND device_id = ?', [companyId, workspaceId, deviceId]);
    const owner = await this.sessionOwner(companyId, userId);
    if (!workspace || !owner || !policy?.enabled || !policy?.allow_control) return false;
    const keys = workspaceKeys(workspace.workspace_key);
    const can = createChecker(owner.permissions);
    return can(keys.view) && can(keys.remote);
  }
  /** Screenshot-only lease. Never used to authorize viewer tickets or input.
   * The exact pending capture/session association is mandatory. */
  async captureAllowed(companyId: number, workspaceId: number, deviceId: string, userId: number, sessionId: string, captureId?: string, manager?: EntityManager) {
    if (!this.configured() || remoteGloballyDisabled()) return false;
    const currentRead = !!manager?.queryRunner?.isTransactionActive;
    const owner = await this.sessionOwner(companyId, userId, manager ?? this.ds.manager, currentRead);
    if (!owner) return false;
    const can = createChecker(owner.permissions);
    if (!can('finance.doc-withdrawal.view') || (!can('finance.docs.create') && !can('finance.session.manage'))) return false;
    const query = manager ? this.forManager(manager).query : this.query;
    const rows = await query(`SELECT c.id FROM sm_legacy_captures c
      JOIN session_remote_sessions r ON r.id=c.remote_session_id AND r.company_id=c.company_id AND r.workspace_id=c.workspace_id AND r.user_id=c.user_id AND r.shop_id=c.store_id
      JOIN session_workspaces w ON w.id=c.workspace_id AND w.company_id=c.company_id AND w.workspace_key='finance_withdrawal' AND w.status='active'
      JOIN session_devices d ON d.id=r.device_id AND d.company_id=r.company_id AND d.workspace_id=r.workspace_id AND d.status='active'
      JOIN sm_legacy_remote_policies p ON p.device_id=d.id AND p.company_id=d.company_id AND p.workspace_id=d.workspace_id AND p.enabled=1 AND p.allow_control=1
      WHERE c.company_id=? AND c.workspace_id=? AND c.user_id=? AND r.device_id=? AND c.remote_session_id=? AND c.status='pending' AND r.status IN ('requested','connected') AND r.transport_mode='jpeg_fallback'
      AND c.created_at>=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 30 SECOND) ${captureId ? 'AND c.id=?' : ''} LIMIT 1${currentRead ? ' FOR UPDATE' : ''}`,
      captureId ? [companyId, workspaceId, userId, deviceId, sessionId, captureId] : [companyId, workspaceId, userId, deviceId, sessionId]);
    return rows.length > 0;
  }
}
