import type { EntityManager } from 'typeorm';
import { yuanToPreciseCents } from '@kudesi/shared';
import type { CryptoService } from '../common/crypto.service';
import type { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import type { ResourcesService } from '../resources/resources.service';
import { withReadonlyAppend } from '../resources/append-only';
import { preserveSourceRow } from './source-rows';

type Row = Record<string, unknown>;
/** Old finance_entries are a non-bank income/expense ledger. Importing them
 * must never create a payment, debit a bank balance, or replay an approval. */
export async function importFinanceLedger(ctx: { em: EntityManager; crypto: CryptoService; resources: ResourcesService; user: AuthUser; sourceCompanyId: number; lookup(type: string, old: unknown): number | undefined }, row: Row) {
  const { em, user } = ctx;
  if (!em.queryRunner?.isTransactionActive || em.queryRunner.data.legacyImport !== true || String(row.company_id) !== String(ctx.sourceCompanyId)) throw new Error('旧收支导入缺少公司范围和迁移事务');
  if (row.id == null || !['income', 'expense', 'withdrawal'].includes(String(row.direction))) throw new Error('旧收支身份或方向不支持');
  const proof = await preserveSourceRow(em, ctx.crypto, { companyId: user.companyId, sourceCompanyId: ctx.sourceCompanyId, table: 'finance_entries', key: String(row.id) }, row);
  const key = `legacy-oa:${ctx.sourceCompanyId}:finance_entries:${row.id}`;
  const old = await em.findOneBy(ResourceRecord, { companyId: user.companyId, type: 'finance-ledger-history', uniqueKey: key });
  if (old) {
    if (old.data._sourceHash !== proof.hash) throw new Error('旧收支记录与加密来源不一致');
    return { id: old.id, reused: true };
  }
  const ref = (type: string, id: unknown) => {
    if (id == null) return undefined;
    const target = ctx.lookup(type, id); if (!target) throw new Error('旧收支关联资料未迁入'); return target;
  };
  const data = {
    caption: String(row.description || row.category || `旧收支记录 #${row.id}`).slice(0, 200), entryDate: row.entry_date, category: row.category,
    direction: row.direction, amountCents: yuanToPreciseCents(String(row.amount), 0),
    storeId: ref('stores', row.store_id), licenseId: ref('licenses', row.license_id), description: row.description,
    originalCreatedAt: row.created_at, sourceLabel: '旧站收支记录',
  };
  const record = await withReadonlyAppend(em, user.companyId, 'finance-ledger-history', () => ctx.resources.createRecord(em, user, 'finance-ledger-history', data, '旧站收支历史迁入；不生成银行分录'));
  record.uniqueKey = key;
  record.data = { ...record.data, _sourceHash: proof.hash, _sourceWorkflowId: row.workflow_id ?? null, _sourceType: row.source_type ?? null };
  await em.save(ResourceRecord, record);
  return { id: record.id, reused: false };
}
