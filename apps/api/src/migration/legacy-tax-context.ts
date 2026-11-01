import type { EntityManager } from 'typeorm';
import type { ResourceDef } from '@kudesi/shared';
import type { ResourceRecord } from '../entities';

interface TaxIssue { missingLicense?: true; duplicateLicenseId?: number; duplicateCategory?: string }
const scopes = new WeakMap<EntityManager, { companyId: number; issue: TaxIssue }>();
function scope(em: EntityManager, companyId: number) {
  const value = scopes.get(em);
  return em.queryRunner?.isTransactionActive && em.queryRunner.data.legacyImport === true && value?.companyId === companyId ? value.issue : undefined;
}
function retainedIssue(existing: ResourceRecord | null, input: Record<string, unknown>): TaxIssue | undefined {
  // This marker is written only after verifying encrypted source evidence. It is
  // not a configurable field, so ordinary resource input cannot create it.
  const old = existing?.data._legacyTaxIssue as TaxIssue | undefined;
  if (!old) return undefined;
  const data = { ...existing!.data, ...input };
  const issue: TaxIssue = {};
  if (old.missingLicense && !data.licenseId) issue.missingLicense = true;
  if (old.duplicateLicenseId && data.licenseId === old.duplicateLicenseId && data.taxCategory === old.duplicateCategory) {
    issue.duplicateLicenseId = old.duplicateLicenseId; issue.duplicateCategory = old.duplicateCategory;
  }
  return issue;
}
/** Retain existing historical anomalies without permitting a new missing or
 * duplicate identity. Changing the identity resumes the ordinary validation. */
export function legacyTaxDefinition(def: ResourceDef, em: EntityManager, companyId: number, existing: ResourceRecord | null, input: Record<string, unknown>): ResourceDef {
  if (def.key !== 'tax-profiles') return def;
  const issue = !existing ? scope(em, companyId) : retainedIssue(existing, input);
  if (!issue) return def;
  return { ...def, fields: issue.missingLicense ? def.fields.map(f => f.key === 'licenseId' ? { ...f, required: false } : f) : def.fields,
    uniqueTogether: issue.duplicateLicenseId ? def.uniqueTogether?.filter(r => !(r.fields.length === 2 && r.fields.includes('licenseId') && r.fields.includes('taxCategory'))) : def.uniqueTogether };
}
export function applyLegacyTaxIssue(em: EntityManager, companyId: number, existing: ResourceRecord | null, data: Record<string, unknown>) {
  const issue = !existing ? scope(em, companyId) : retainedIssue(existing, data);
  if (issue && Object.keys(issue).length) {
    data._legacyTaxIssue = issue;
    data.migrationNotice = issue.missingLicense ? '旧税务资料未关联营业执照，原值保留并已加密留档；请核对后补充真实执照。' : '旧执照合并后存在同类别的多份税务资料；各份原值分别保留并已加密留档，请核对差异。';
  } else if (existing?.data._legacyTaxIssue) {
    delete data._legacyTaxIssue; delete data.migrationNotice;
  }
}
export async function withLegacyTax<T>(em: EntityManager, companyId: number, issue: TaxIssue, fn: () => Promise<T>) {
  if (!em.queryRunner?.isTransactionActive || em.queryRunner.data.legacyImport !== true || scopes.has(em)) throw new Error('税务历史必须位于独立迁移行事务');
  scopes.set(em, { companyId, issue });
  try { return await fn(); } finally { scopes.delete(em); }
}
