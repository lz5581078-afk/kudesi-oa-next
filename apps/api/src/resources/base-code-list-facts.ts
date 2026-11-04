import {In,type EntityManager} from 'typeorm';
import {ResourceRecord} from '../entities';
import {buildSnapshot} from './base-code-support';
import {codeVerificationState,type CodePhase} from './finance-code-lifecycle';
import {snapshotReadContext} from './snapshot-read-context';

export interface BaseCodeListFacts {issueCount:number;canonicalId:number|null;canonicalState:CodePhase|null;aliasCount:number}
const positiveId=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
/** Exact existing report validation, with one manager/company read cache for this page only. */
export async function deriveBaseCodeListFacts(em:EntityManager,companyId:number,records:readonly Pick<ResourceRecord,'id'|'companyId'|'type'>[]):Promise<Map<number,BaseCodeListFacts>> {
 const ids=[...new Set(records.filter(row=>row.companyId===companyId&&row.type==='finance-base-codes'&&positiveId(row.id)).map(row=>row.id))];
 const result=new Map<number,BaseCodeListFacts>();if(!ids.length)return result;
 const bases=await em.find(ResourceRecord,{where:{companyId,type:'finance-base-codes',id:In(ids)}}),composed=bases.filter(row=>row.data.origin==='composed').map(row=>row.id);
 const lines=composed.length?await em.createQueryBuilder(ResourceRecord,'r').where('r.companyId=:companyId AND r.type=:type',{companyId,type:'finance-base-code-lines'}).andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data,'$.baseCodeId')) IN (:...ids)",{ids:composed.map(String)}).getMany():[];
 const reader=snapshotReadContext(em,companyId,bases,composed.map(id=>({type:'finance-base-code-lines',field:'baseCodeId',value:id,rows:lines.filter(line=>String(line.data.baseCodeId)===String(id))})));
 const realIds=[...new Set(bases.flatMap(row=>positiveId(row.data.canonicalId)?[row.id,row.data.canonicalId]:[row.id]))];
 const aliases=realIds.length?await em.createQueryBuilder(ResourceRecord,'r').select(['r.id','r.data']).where('r.companyId=:companyId AND r.type=:type',{companyId,type:'finance-base-codes'}).andWhere('r.archivedAt IS NULL AND r.status<>:deleted',{deleted:'deleted'}).andWhere("JSON_EXTRACT(r.data,'$.canonicalId') IN (:...ids)",{ids:realIds}).getMany():[];
 const counts=new Map<number,number>();for(const row of aliases)if(positiveId(row.data.canonicalId))counts.set(row.data.canonicalId,(counts.get(row.data.canonicalId)??0)+1);
 await Promise.all(bases.map(async base=>{
  const real=positiveId(base.data.canonicalId)?await reader.one('finance-base-codes',base.data.canonicalId):base.data.canonicalId==null?base:null;
  // Missing/cross-company/invalid canonical links remain unknown; no fallback to a different row.
  const canonical=real&&real.data.canonicalId==null?real:null;
  const report=await buildSnapshot(em,companyId,base,reader);
  result.set(base.id,{issueCount:report.issues.length,canonicalId:canonical?.id??null,canonicalState:canonical?codeVerificationState(canonical):null,aliasCount:counts.get(base.id)??0});
 }));
 return result;
}
