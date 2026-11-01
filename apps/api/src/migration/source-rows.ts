import { createHash } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { CryptoService } from '../common/crypto.service';

const SOURCE = 'legacy-oa';
type Row = Record<string, unknown>;
function stable(v: unknown): unknown {
  if (v instanceof Date) throw new Error('原始日期必须在读取时保留为字符串');
  if (Buffer.isBuffer(v)) throw new Error('二进制来源字段需要显式编码，不能静默改型');
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => {
    if (value === undefined) throw new Error('原始来源包含未定义值');
    return [k, stable(value)];
  }));
  if (typeof v === 'number' && (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v)))) throw new Error('原始数字超出可精确保存范围');
  return v;
}

export interface SourceRowIdentity { companyId: number; sourceCompanyId: number; table: string; key: string }
function check(identity: SourceRowIdentity) {
  if (![identity.companyId, identity.sourceCompanyId].every(n => Number.isSafeInteger(n) && n > 0) || !/^[a-z][a-z0-9_]{0,79}$/.test(identity.table) || !identity.key || identity.key.length > 200 || /[\u0000-\u001f]/.test(identity.key)) throw new Error('来源记录身份不合法');
}

/** Must run in the caller's migration transaction, without workers or hooks.
 * Existing source rows are immutable. A new snapshot needs an explicit migration
 * batch strategy, rather than silently replacing the evidence from a prior run. */
export async function preserveSourceRow(em: EntityManager, crypto: CryptoService, identity: SourceRowIdentity, row: Row) {
  check(identity);
  if (!em.queryRunner?.isTransactionActive) throw new Error('原始来源保留必须位于迁移事务中');
  if (row.company_id != null && String(row.company_id) !== String(identity.sourceCompanyId)) throw new Error('来源记录不属于指定旧公司');
  const raw = JSON.stringify(stable(row));
  const hash = createHash('sha256').update(raw).digest('hex');
  const args = [identity.companyId, SOURCE, identity.sourceCompanyId, identity.table, identity.key];
  const [old] = await em.query('SELECT id,source_hash,raw_encrypted FROM legacy_source_rows WHERE company_id=? AND source_system=? AND source_company_id=? AND source_table=? AND source_key=? FOR UPDATE', args);
  if (old) {
    if (old.source_hash !== hash || crypto.decrypt(old.raw_encrypted) !== raw) throw new Error('来源记录变化或完整性不一致，禁止覆盖');
    return { id: String(old.id), reused: true, hash };
  }
  const result = await em.query('INSERT INTO legacy_source_rows (company_id,source_system,source_company_id,source_table,source_key,source_hash,raw_encrypted) VALUES (?,?,?,?,?,?,?)', [...args, hash, crypto.encrypt(raw)]);
  return { id: String(result.insertId), reused: false, hash };
}

/** Internal migration reader. No raw-history HTTP endpoint or broad permission
 * grant is introduced by this storage facility. */
export async function readSourceRow(em: EntityManager, crypto: CryptoService, identity: SourceRowIdentity): Promise<Row | null> {
  check(identity);
  const [r] = await em.query('SELECT source_hash,raw_encrypted FROM legacy_source_rows WHERE company_id=? AND source_system=? AND source_company_id=? AND source_table=? AND source_key=?', [identity.companyId, SOURCE, identity.sourceCompanyId, identity.table, identity.key]);
  if (!r) return null;
  const raw = crypto.decrypt(r.raw_encrypted);
  if (createHash('sha256').update(raw).digest('hex') !== r.source_hash) throw new Error('原始来源完整性校验失败');
  return JSON.parse(raw);
}
