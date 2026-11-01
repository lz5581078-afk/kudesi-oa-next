import type { EntityManager } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import type { ResourcesService } from './resources.service';
import { withReadonlyAppend } from './append-only';

/** The sole append path for immutable non-bank historical income/expenses. */
export async function appendLedgerHistory(em: EntityManager, resources: ResourcesService, user: AuthUser, entry: { key: string; sourceHash: string; data: Record<string, unknown>; detail: Record<string, unknown> }) {
  const old = await em.findOneBy(ResourceRecord, { companyId: user.companyId, type: 'finance-ledger-history', uniqueKey: entry.key });
  if (old) {
    if (old.data._sourceHash !== entry.sourceHash) throw new Error('旧收支记录与加密来源不一致');
    return { id: old.id, reused: true };
  }
  const record = await withReadonlyAppend(em, user.companyId, 'finance-ledger-history', () => resources.createRecord(em, user, 'finance-ledger-history', entry.data, '旧站收支历史；不生成银行分录'));
  record.uniqueKey = entry.key;
  record.data = { ...record.data, ...entry.detail, _sourceHash: entry.sourceHash };
  await em.save(ResourceRecord, record);
  return { id: record.id, reused: false };
}
