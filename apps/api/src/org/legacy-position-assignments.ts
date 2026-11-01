import { ForbiddenException } from '@nestjs/common';
import { createChecker } from '@kudesi/shared';
import type { EntityManager } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import type { ResourcesService } from '../resources/resources.service';
import type { User } from '../entities';

export interface LegacyPositionAssignment {
  sourceId:string;sourceEmployeeId:string;sourcePositionId:string;
  positionName:string;departmentName:string;status:'active'|'inactive';isPrimary:boolean;
  startedAt:string|null;endedAt:string|null;
}
const fail=()=>Object.assign(Error('原任职履历身份、日期或公司归属核对失败'),{name:'LegacyDataError'});
function date(v:unknown):string|null{
  if(v===null)return null;
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)throw fail();return v;
}
/** Typed, read-only original assignments. No permissions, passwords or raw JSON
 * are returned; this history never participates in current authorization. */
export async function legacyPositionAssignments(em:EntityManager,resources:ResourcesService|undefined,actor:AuthUser,target:User):Promise<LegacyPositionAssignment[]>{
  if(target.companyId!==actor.companyId)throw new ForbiddenException('没有本公司人员记录查看权限');
  const links=await em.query("SELECT source_company_id sourceCompanyId,source_key sourceKey FROM legacy_import_links WHERE company_id=? AND source_system='legacy-oa' AND target_type='user' AND target_id=?",[actor.companyId,target.id]);
  if(!links.length)return [];
  if(!createChecker(actor.permissions)('org.staff.view'))throw new ForbiddenException('没有本公司人员记录查看权限');
  if(links.length!==1||!Number.isSafeInteger(Number(links[0].sourceCompanyId))||Number(links[0].sourceCompanyId)<1||!/^user:[1-9]\d*$/.test(links[0].sourceKey))throw fail();
  const sourceCompanyId=Number(links[0].sourceCompanyId),sourceEmployeeId=links[0].sourceKey.slice(5);
  const keys:Array<{sourceKey:string}>=await em.query("SELECT source_key sourceKey FROM legacy_source_rows WHERE company_id=? AND source_system='legacy-oa' AND source_company_id=? AND source_table='employee_positions' ORDER BY id",[actor.companyId,sourceCompanyId]);
  if(!keys.length)return [];
  if(!resources)throw Error('原任职履历读取服务未配置');
  const read=(table:string,key:string)=>resources.legacySourceRow(em,actor,sourceCompanyId,table,key);
  const employee=await read('employees',sourceEmployeeId);
  const employeeDept=employee?.department_id!=null?await read('departments',String(employee.department_id)):null;
  if(!employee||String(employee.id)!==sourceEmployeeId||!employeeDept||String(employeeDept.id)!==String(employee.department_id)||String(employeeDept.company_id)!==String(sourceCompanyId))throw fail();
  const out:LegacyPositionAssignment[]=[];
  for(const key of keys){
    const row=await read('employee_positions',key.sourceKey);if(!row||String(row.id)!==key.sourceKey)throw fail();
    if(String(row.employee_id)!==sourceEmployeeId)continue;
    if(!/^[1-9]\d*$/.test(key.sourceKey)||!['active','inactive'].includes(String(row.status))||![0,1,'0','1',true,false].includes(row.is_primary as any))throw fail();
    const p=await read('positions',String(row.position_id)),dept=p?.department_id!=null?await read('departments',String(p.department_id)):null;
    if(!p||String(p.id)!==String(row.position_id)||!dept||String(dept.id)!==String(p.department_id)||String(dept.company_id)!==String(sourceCompanyId)||typeof p.name!=='string'||!p.name||typeof dept.name!=='string'||!dept.name)throw fail();
    out.push({sourceId:key.sourceKey,sourceEmployeeId,sourcePositionId:String(row.position_id),positionName:p.name,departmentName:dept.name,status:row.status as 'active'|'inactive',isPrimary:row.is_primary===1||row.is_primary==='1'||row.is_primary===true,startedAt:date(row.started_at),endedAt:date(row.ended_at)});
  }
  return out.sort((a,b)=>BigInt(a.sourceId)<BigInt(b.sourceId)?-1:1);
}
