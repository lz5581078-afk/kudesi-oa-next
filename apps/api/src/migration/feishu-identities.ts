import type { EntityManager } from 'typeorm';
import { User } from '../entities';
import { legacyWallTime as wall } from './legacy-time';

type Row=Record<string,unknown>;
export const feishuIdentityKey=(row:Row)=>JSON.stringify([String(row.employee_id),String(row.app_id)]);
interface Context {
  em:EntityManager;companyId:number;sourceCompanyId:number;
  lookup(type:string,id:unknown):number|undefined;
  register(type:string,id:string,target:number):Promise<void>;
}
/** Preserve identities, not OAuth authorization sessions or pending deliveries.
 * Conflicts never transfer another person's identity or overwrite newer binds. */
export async function importFeishuIdentity(ctx:Context,row:Row){
  const fail=()=>Error('旧飞书身份归属、原时间或绑定冲突，未覆盖现有身份');
  if(!ctx.em.queryRunner?.isTransactionActive||ctx.em.queryRunner.data.legacyImport!==true||String(row.company_id)!==String(ctx.sourceCompanyId))throw fail();
  const text=(v:unknown,max:number)=>{if(typeof v!=='string'||!v.trim()||v.length>max||v!==v.trim())throw fail();return v;};
  const appId=text(row.app_id,100),tenantKey=text(row.tenant_key,100),openId=text(row.open_id,150),unionId=row.union_id==null?null:text(row.union_id,150);
  const userId=ctx.lookup('user',row.employee_id);
  if(!userId||!await ctx.em.findOneBy(User,{id:userId,companyId:ctx.companyId}))throw fail();
  const boundAt=wall(row.bound_at,true)!;
  const key=feishuIdentityKey(row);
  const existing=await ctx.em.query('SELECT id,company_id,user_id,app_id,tenant_key,open_id,union_id,bound_at FROM feishu_identities WHERE (app_id=? AND tenant_key=? AND open_id=?) OR (company_id=? AND user_id=? AND app_id=?) FOR UPDATE',[appId,tenantKey,openId,ctx.companyId,userId,appId]);
  if(existing.length){
    if(existing.length!==1)throw fail();
    const e=existing[0];
    if(Number(e.company_id)!==ctx.companyId||Number(e.user_id)!==userId||e.app_id!==appId||e.tenant_key!==tenantKey||e.open_id!==openId||(e.union_id??null)!==unionId)throw fail();
    // A matching newer native binding remains at its original native time.
    const linked=ctx.lookup('feishu_identity',key);
    if(linked!=null&&linked!==Number(e.id))throw fail();
    if(!linked)await ctx.register('feishu_identity',key,Number(e.id));
    return {id:Number(e.id),reused:true};
  }
  if(ctx.lookup('feishu_identity',key))throw fail();
  const result=await ctx.em.query('INSERT INTO feishu_identities(company_id,user_id,app_id,tenant_key,open_id,union_id,bound_at) VALUES(?,?,?,?,?,?,?)',[ctx.companyId,userId,appId,tenantKey,openId,unionId,boundAt]);
  const id=Number(result.insertId);if(!Number.isSafeInteger(id)||id<1)throw fail();
  await ctx.register('feishu_identity',key,id);
  return {id,reused:false};
}
