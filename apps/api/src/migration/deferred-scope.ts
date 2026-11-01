import { createHash } from 'node:crypto';
import type { ImportResult } from './runner';

export interface DeferredScope {version:1;decision:'verified-scope-first-retain-rest';reportDigest:string;backupDigest:string}
/** An explicit staged cutover binds the exact deferred list, never hides it or
 * accepts insertion failures. Ordinary import/apply retains its strict guard. */
export function deferredReportDigest(r:ImportResult){
  return createHash('sha256').update(JSON.stringify({company:r.companyId,source:r.sourceFingerprint,software:r.softwareFingerprint,target:r.targetFingerprint,
    exclusions:[...r.excluded].map(e=>[e.type,e.id,e.reason]).sort(),fields:r.fieldCoverage??null})).digest('hex');
}
export function deferredScopeMatches(scope:DeferredScope|undefined,report:ImportResult|undefined){
  return Boolean(scope&&report&&scope.version===1&&scope.decision==='verified-scope-first-retain-rest'&&/^[a-f0-9]{64}$/.test(scope.backupDigest)&&scope.reportDigest===deferredReportDigest(report));
}
