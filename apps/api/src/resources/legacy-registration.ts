import { normalizePhone } from '@kudesi/shared';
import type { EntityManager } from 'typeorm';
import type { CryptoService } from '../common/crypto.service';
import type { ResourceRecord } from '../entities';
import { readSourceRow } from '../migration/source-rows';

export interface LegacyRegistration { sourceCompanyId:number; sourceId:string }
const tables:Record<string,{table:string;column:string}>={phones:{table:'phone_numbers',column:'number'},'bank-accounts':{table:'bank_accounts',column:'account_no'}};
export const isRegistrationType=(type:string)=>Object.hasOwn(tables,type);
export const registrationIdentity=(type:string,value:unknown)=>type==='phones'?normalizePhone(String(value??'')):String(value??'').trim().toLowerCase();
/** Domain-separated HMAC: neither a bank number nor a phone is stored in this
 * exceptional unique key. All old registrations, including the first, use it. */
export function registrationPrefixes(crypto:CryptoService,companyId:number,type:string,identity:string){
  return crypto.indexTokens(JSON.stringify(['legacy-registration-v1',companyId,type,identity])).map(k=>'lr1:'+k+':');
}
export function registrationKeys(crypto:CryptoService,companyId:number,type:string,identity:string,source:LegacyRegistration){
  return registrationPrefixes(crypto,companyId,type,identity).map(k=>k+source.sourceCompanyId+':'+source.sourceId);
}
export async function proveRegistration(em:EntityManager,crypto:CryptoService,companyId:number,type:string,identity:string,source:LegacyRegistration){
  const config=tables[type];
  if(!config||!identity||!Number.isSafeInteger(source.sourceCompanyId)||source.sourceCompanyId<1||!/^\d+$/.test(source.sourceId)||BigInt(source.sourceId)<1n)throw Error('原登记身份无效');
  const row=await readSourceRow(em,crypto,{companyId,sourceCompanyId:source.sourceCompanyId,table:config.table,key:source.sourceId});
  if(!row||String(row.id)!==source.sourceId||String(row.company_id)!==String(source.sourceCompanyId)||typeof row[config.column]!=='string'||registrationIdentity(type,row[config.column])!==identity)throw Error('原登记号码或所属公司核对失败');
  const keys=registrationKeys(crypto,companyId,type,identity,source);if(keys.some(k=>k.length>200))throw Error('原登记索引超出范围');
  return keys;
}
/** An unchanged original number may retain its exceptional key. The capability
 * is proved by the tenant ledger AND the authenticated encrypted original row;
 * a request body, admin flag or a forged JSON marker cannot confer it. */
export async function proveExistingRegistration(em:EntityManager,crypto:CryptoService,record:ResourceRecord,identity:string){
  if(!record.uniqueKey?.startsWith('lr1:')||!isRegistrationType(record.type))return false;
  const links=await em.query("SELECT source_company_id sourceCompanyId,source_key sourceKey FROM legacy_import_links WHERE company_id=? AND source_system='legacy-oa' AND target_type=? AND target_id=?",[record.companyId,record.type,record.id]);
  if(links.length!==1||typeof links[0].sourceKey!=='string'||!links[0].sourceKey.startsWith(record.type+':'))throw Error('原登记来源关联缺失或重复');
  const source={sourceCompanyId:Number(links[0].sourceCompanyId),sourceId:links[0].sourceKey.slice(record.type.length+1)};
  const keys=await proveRegistration(em,crypto,record.companyId,record.type,identity,source);
  if(!keys.includes(record.uniqueKey))throw Error('原登记索引与来源不一致');
  return true;
}
