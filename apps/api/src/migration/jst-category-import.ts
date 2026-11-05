import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { CryptoService } from '../common/crypto.service';
import type { JstAccount } from '../integrations/external-config.service';
import type { LegacyArchive } from './protocol';
import { preserveSourceRow } from './source-rows';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const obj = (value: unknown): Record<string, unknown> => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
};
const scopeOf = (value: unknown) => value === 'product_category' ? 'product' : value === 'bundle_category' ? 'bundle' : null;
type Scope = NonNullable<ReturnType<typeof scopeOf>>;

async function configuredTarget(em: EntityManager, crypto: CryptoService, companyId: number) {
  const [setting] = await em.query("SELECT config_enc FROM integration_settings WHERE company_id=? AND setting_key='jushuitan'", [companyId]);
  const apps = await em.query("SELECT app_key_enc,base_url FROM platform_integration_apps WHERE integration_key='jushuitan' AND environment='production' AND status='active'");
  if (!setting || apps.length !== 1) return null;
  const accounts = (JSON.parse(crypto.decrypt(setting.config_enc)).accounts as JstAccount[] ?? []).filter(account => account.coid && account.accessToken);
  if (accounts.length !== 1) return null;
  const [account] = accounts;
  const coid = String(account.coid), appKey = crypto.decrypt(apps[0].app_key_enc);
  const baseUrl = String(account.baseUrl || apps[0].base_url || 'https://openapi.jushuitan.com').replace(/\/$/, '');
  return { key: `jst:${companyId}:${coid}`, proof: digest([coid, appKey, baseUrl]) };
}

export async function importJstCategoryHistory(
  em: EntityManager, crypto: CryptoService, companyId: number, sourceCompanyId: number,
  source: NonNullable<LegacyArchive['jstCategories']>,
  lookup: (type: string, id: unknown) => number | undefined,
  register: (type: string, id: unknown, targetId: number) => Promise<void>,
  count: (which: 'created' | 'reused', type: string) => void,
) {
  const target = await configuredTarget(em, crypto, companyId);
  const category = (scope: Scope, id: unknown) => scope === 'product'
    ? lookup('finance-code-dictionaries', id)
    : lookup('finance-categories', `bundle-dict:${id}`);
  const preserve = (table: string, key: string, row: Record<string, unknown>) =>
    preserveSourceRow(em, crypto, { companyId, sourceCompanyId, table, key }, row);
  for (const row of source.links) {
    const oldTarget = String(row.target_key ?? ''), scope = scopeOf(row.dictionary_type);
    if (!scope || !/^[a-f0-9]{64}$/.test(oldTarget) || String(row.company_id) !== String(sourceCompanyId)) throw new Error('旧聚水潭分类关联的公司、目标或目录范围无效');
    const preserved=await preserve('jst_category_sync_links', `${oldTarget}:${row.local_id}`, row);
    const id = category(scope, row.local_id);
    if (!id || !target || source.targets[oldTarget] !== target.proof) {
      count(preserved.reused?'reused':'created', 'jst-category-link-history-only');
      continue;
    }
    const remoteId = row.remote_id == null ? null : String(row.remote_id);
    if (remoteId !== null && !/^[1-9]\d{0,39}$/.test(remoteId)) throw new Error('旧聚水潭分类 ID 无效');
    const local = obj(row.local_json);
    const parentId = local.parentId && local.parentId !== '0' ? category(scope, local.parentId) : 0;
    if (parentId === undefined) { count(preserved.reused?'reused':'created', 'jst-category-link-history-only'); continue; }
    const status = String(row.status);
    if (!['linked', 'rejected', 'uncertain', 'retired'].includes(status)) throw new Error('旧聚水潭分类关联状态无法对应');
    const [existing] = await em.query('SELECT category_id,remote_id FROM jst_category_links WHERE company_id=? AND target_key=? AND category_id=? FOR UPDATE', [companyId, target.key, id]);
    if (existing) {
      if (String(existing.remote_id ?? '') !== String(remoteId ?? '')) throw new Error('新旧聚水潭分类映射不一致，需人工核对');
      count('reused', 'jst-category-link');
      continue;
    }
    if (remoteId) {
      const [owner] = await em.query('SELECT category_id FROM jst_category_links WHERE company_id=? AND target_key=? AND remote_id=? FOR UPDATE', [companyId, target.key, remoteId]);
      if (owner) throw new Error('旧聚水潭分类已关联到另一条本地分类，需人工核对');
    }
    await em.query('INSERT INTO jst_category_links (company_id,category_id,target_key,remote_id,status,local_json,remote_json,pending_json) VALUES (?,?,?,?,?,?,?,?)',
      [companyId, id, target.key, remoteId, status, JSON.stringify({ ...local, id: String(id), parentId: String(parentId), syncScope: scope }),
        row.remote_json == null ? null : JSON.stringify(obj(row.remote_json)), row.pending_json == null ? null : JSON.stringify(obj(row.pending_json))]);
    count('created', 'jst-category-link');
  }
  for (const row of source.runs) {
    if (String(row.company_id) !== String(sourceCompanyId)) throw new Error('旧聚水潭分类日志不属于来源公司');
    await preserve('jst_category_outbound_runs', String(row.id), row);
    const scope = scopeOf(row.dictionary_type);
    if (!scope) continue;
    if (lookup('jst-category-run', row.id)) { count('reused', 'jst-category-run'); continue; }
    const raw = typeof row.details_json === 'string' ? JSON.parse(row.details_json) : row.details_json;
    const details = Array.isArray(raw) ? raw : [];
    const changes = details.map((entry: unknown) => {
      const change = obj(entry);
      return { localId: String(category(scope, change.localId) ?? change.localId ?? ''), path: String(change.path ?? ''), action: String(change.action ?? ''),
        jobId: null, status: String(change.status ?? 'success') };
    });
    const status = row.status === 'running' ? 'failed' : String(row.status ?? 'failed');
    const result = await em.query('INSERT INTO jst_category_runs (company_id,mode,actor_id,status,message,details_json,created_at) VALUES (?,?,?,?,?,?,?)',
      [companyId, scope, lookup('user', row.actor_id) ?? null, status, String(row.message ?? '').slice(0, 800),
        JSON.stringify({ scope, mode: row.mode, changes, legacyRunId: row.id }), row.created_at]);
    await register('jst-category-run', row.id, Number(result.insertId));
    count('created', 'jst-category-run');
  }
}
