import type { EntityManager } from 'typeorm';
const contexts = new WeakMap<EntityManager, { companyId: number; type: string }>();
/** Internal capability, never supplied by HTTP input or a company-admin flag. */
export function canAppendReadonly(em: EntityManager, companyId: number, type: string) {
  const c = contexts.get(em);
  return em.queryRunner?.isTransactionActive && c?.companyId === companyId && c.type === type;
}
export async function withReadonlyAppend<T>(em: EntityManager, companyId: number, type: string, fn: () => Promise<T>) {
  if (!em.queryRunner?.isTransactionActive || contexts.has(em)) throw new Error('只读历史追加必须位于独立行事务');
  contexts.set(em, { companyId, type });
  try { return await fn(); } finally { contexts.delete(em); }
}
