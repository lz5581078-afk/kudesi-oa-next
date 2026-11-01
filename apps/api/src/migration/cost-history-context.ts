import type { EntityManager } from 'typeorm';

// A request body cannot create this marker. The migration runner grants it only
// around one new cost row after preserving its immutable encrypted source.
const scopes = new WeakMap<EntityManager, { companyId: number; productId: number }>();
export function importingCostHistory(em: EntityManager, companyId: number, productId: unknown): boolean {
  const scope = scopes.get(em);
  return !!em.queryRunner?.isTransactionActive && em.queryRunner.data.legacyImport === true && scope?.companyId === companyId && scope.productId === productId;
}
export async function withCostHistory<T>(em: EntityManager, scope: { companyId: number; productId: number }, fn: () => Promise<T>): Promise<T> {
  if (!em.queryRunner?.isTransactionActive || em.queryRunner.data.legacyImport !== true || scopes.has(em)) throw new Error('成本历史导入必须使用独立迁移事务及单行上下文');
  scopes.set(em, scope);
  try { return await fn(); } finally { scopes.delete(em); }
}
