import { isDeepStrictEqual } from 'node:util';
import type { DataSource,EntityManager } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import type { ResourcesService } from '../resources/resources.service';
import { DUTY_CATEGORIES,OrgAdminService } from '../org/org-admin.service';

/** Older responsibilities are accepted as duplicate records only after every
 * non-identity column matches one current source duty and its real native view.
 * Source identities remain separately encrypted and receive ledger aliases. */
export async function verifyResponsibilityDuplicates(ctx:{em:EntityManager;resources:ResourcesService;user:AuthUser;sourceCompanyId:number;duties:Array<Record<string,any>>;lookup(type:string,id:unknown):number|undefined},rows:Array<Record<string,unknown>>){
  const fail=()=>Object.assign(Error('旧岗位职责副本未能逐字段对应原生条目，禁止丢弃或重复生成'),{name:'LegacyDataError'});
  if(!ctx.em.queryRunner?.isTransactionActive||ctx.em.queryRunner.data.legacyImport!==true)throw fail();
  const bound=Object.create(ctx.em.connection) as DataSource;Object.defineProperty(bound,'manager',{value:ctx.em});const org=new OrgAdminService(bound,ctx.resources);
  const result:Array<{sourceId:string;targetId:number}>=[],seen=new Set<string>(),targets=new Set<number>();
  for(const row of rows){
    if(Object.keys(row).sort().join(',')!=='category,description,frequency,id,position_id,related_module,title'||!/^\d+$/.test(String(row.id))||seen.has(String(row.id)))throw fail();seen.add(String(row.id));
    const original=await ctx.resources.legacySourceRow(ctx.em,ctx.user,ctx.sourceCompanyId,'position_responsibilities',String(row.id));
    if(!isDeepStrictEqual(original,row))throw fail();
    const position=await ctx.resources.legacySourceRow(ctx.em,ctx.user,ctx.sourceCompanyId,'positions',String(row.position_id));
    const department=position?await ctx.resources.legacySourceRow(ctx.em,ctx.user,ctx.sourceCompanyId,'departments',String(position.department_id)):null;
    if(!position||String(position.id)!==String(row.position_id)||!department||String(department.id)!==String(position.department_id)||String(department.company_id)!==String(ctx.sourceCompanyId))throw fail();
    const matches=ctx.duties.filter(d=>String(d.position_id)===String(row.position_id)&&d.duty_category===row.category&&['title','description','frequency','related_module'].every(k=>d[k]===row[k]));
    if(matches.length!==1||matches[0].status!=='active')throw fail();
    const duty=matches[0],targetId=ctx.lookup('position_duty',duty.id),positionId=ctx.lookup('position',row.position_id);
    if(!targetId||!positionId||targets.has(targetId))throw fail();targets.add(targetId);
    const view=await org.positionProfile(ctx.user,positionId),native=view.duties.find(d=>d.id===targetId);
    const category=String(row.category),known=(DUTY_CATEGORIES as readonly string[]).includes(category),description=String(row.description)+(known?'':`（旧分类：${category}）`);
    if(!native||native.category!==(known?category:'岗位职责')||native.title!==row.title||(native.description??'')!==description||(native.frequency??null)!==(row.frequency??null)||(native.relatedModule??null)!==(row.related_module??null)||native.status!=='active')throw fail();
    result.push({sourceId:String(row.id),targetId});
  }
  return result;
}
