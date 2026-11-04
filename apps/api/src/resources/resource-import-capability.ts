import {getSourceProductImportProfile} from '@kudesi/shared';
import type { EntityManager } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';

/** Server-owned scope. Nothing in a request body can create this capability. */
const scopes = new WeakMap<EntityManager, { companyId:number; userId:number; profile:string }>();
export function trustedResourceImport(em:EntityManager,user:AuthUser,profile?:string) {
  const scope=scopes.get(em);
  return !!scope && scope.companyId===user.companyId && scope.userId===user.id && (!profile || scope.profile===profile || profile==='product_archives'&&!!getSourceProductImportProfile(scope.profile));
}
export async function withTrustedResourceImport<T>(em:EntityManager,user:AuthUser,profile:string,work:()=>Promise<T>):Promise<T> {
  const previous=scopes.get(em);
  scopes.set(em,{companyId:user.companyId,userId:user.id,profile});
  try { return await work(); } finally { if(previous)scopes.set(em,previous);else scopes.delete(em); }
}

export function trustedSourceProductImport(em:EntityManager,user:AuthUser){const scope=scopes.get(em);return !!scope&&scope.companyId===user.companyId&&scope.userId===user.id&&!!getSourceProductImportProfile(scope.profile);}
