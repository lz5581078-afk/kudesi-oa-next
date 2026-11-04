import {EntityManager} from 'typeorm';
import {AuthUser} from '../common/auth.decorators';
import {ResourceRecord} from '../entities';
export const CATEGORY_POLICY_TYPE='finance-category-sync-policy';
export type CategoryScope='product'|'bundle'|'archive';
export const categoryScopes:readonly CategoryScope[]=['product','bundle','archive'];
export function categoryScope(type:string,data:Record<string,unknown>):CategoryScope|null{
 if(type==='finance-code-dictionaries')return data.kind==='product_category'?'product':null;
 if(type==='finance-categories')return data.archiveType==='bundle'?'bundle':'archive';return null;
}
const business=(record:ResourceRecord)=>JSON.stringify([record.data.kind,record.data.archiveType,record.data.name,record.data.code,record.data.parentId??0,record.data.sort??0,record.status,!!record.archivedAt]);
/** 内部设置无ResourceDef，普通资源、草稿和导入均不能读写；只存可信授权及处理代次。 */
export function categoryPolicy(em:EntityManager,companyId:number,scope:CategoryScope,lock=false){return em.findOne(ResourceRecord,{where:{companyId,type:CATEGORY_POLICY_TYPE,uniqueKey:scope},...(lock?{lock:{mode:'pessimistic_write' as const}}:{})});}
/** 与真实分类变更同一事务，只标记已提交后需核对；不调用远端。 */
export async function markCategorySyncDirty(em:EntityManager,user:AuthUser,type:string,record:ResourceRecord,existing?:ResourceRecord|null){
 if(existing&&business(record)===business(existing))return;
 const scopes=new Set([categoryScope(type,record.data),existing?categoryScope(type,existing.data):null]);
 for(const scope of scopes){if(!scope)continue;await em.query("UPDATE resource_records SET data=JSON_SET(data,'$.generation',COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.generation')) AS UNSIGNED),0)+1,'$.lastActorId',?,'$.lastMutationAt',?,'$.nextAttemptAt',0),updated_by=? WHERE company_id=? AND type=? AND unique_key=? AND JSON_EXTRACT(data,'$.enabled')=TRUE",[user.id,new Date().toISOString(),user.id,user.companyId,CATEGORY_POLICY_TYPE,scope]);}
}
