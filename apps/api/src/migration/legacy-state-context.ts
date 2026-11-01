import type { EntityManager } from 'typeorm';
const scopes = new WeakMap<EntityManager, { companyId: number; library: string }>();
export function importingMissingLegacyReason(em: EntityManager, companyId: number, library: string) {
  const s = scopes.get(em);
  return em.queryRunner?.isTransactionActive && em.queryRunner.data.legacyImport === true && s?.companyId === companyId && s.library === library;
}
export async function withMissingLegacyReason<T>(em: EntityManager, scope: { companyId: number; library: string }, fn: () => Promise<T>) {
  if (!em.queryRunner?.isTransactionActive || !em.queryRunner.data.legacyImport || scopes.has(em) || !['store-abnormal-reasons', 'phone-abnormal-reasons'].includes(scope.library)) throw new Error('历史异常状态必须位于单行迁移上下文');
  scopes.set(em, scope);
  try { return await fn(); } finally { scopes.delete(em); }
}
