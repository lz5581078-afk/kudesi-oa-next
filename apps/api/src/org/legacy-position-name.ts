import { ForbiddenException } from '@nestjs/common';
import { createChecker } from '@kudesi/shared';
import type { EntityManager } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import type { ResourcesService } from '../resources/resources.service';
import type { Position } from '../entities';

/** Only the original public name/dept are exposed, never the raw row or its
 * workspace/permission metadata. Tenant and ownership come from native ledger
 * links and the source department, not string parsing of a qualified name. */
export async function legacyPositionName(em:EntityManager,resources:ResourcesService|undefined,user:AuthUser,position:Position):Promise<{name:string;departmentName:string}|null>{
  if(position.companyId!==user.companyId)throw new ForbiddenException('没有本公司岗位权限');
  const links=await em.query("SELECT source_company_id companyId,source_key sourceKey FROM legacy_import_links WHERE company_id=? AND source_system='legacy-oa' AND target_type='position' AND target_id=?",[user.companyId,position.id]);
  if(!links.length)return null;
  if(!createChecker(user.permissions)('org.structure.view'))throw new ForbiddenException('没有岗位查看权限');
  if(links.length!==1||!Number.isSafeInteger(Number(links[0].companyId))||Number(links[0].companyId)<1||typeof links[0].sourceKey!=='string'||!/^position:[1-9]\d*$/.test(links[0].sourceKey))throw Error('原岗位名称关联核对失败');
  const sourceCompanyId=Number(links[0].companyId),sourceId=links[0].sourceKey.slice('position:'.length);
  if(!resources){
    const [raw]=await em.query("SELECT id FROM legacy_source_rows WHERE company_id=? AND source_system='legacy-oa' AND source_company_id=? AND source_table='positions' AND source_key=?",[user.companyId,sourceCompanyId,sourceId]);
    if(raw)throw Error('原岗位名称读取服务未配置');return null;
  }
  const row=await resources.legacySourceRow(em,user,sourceCompanyId,'positions',sourceId);
  // Earlier partial imports have links but no full encrypted source catalog.
  // Keep their existing position page usable without inventing a source name.
  if(!row)return null;
  if(String(row.id)!==sourceId||typeof row.name!=='string'||!row.name||row.name.length>100||row.department_id==null)throw Error('原岗位名称证据不完整');
  const dept=await resources.legacySourceRow(em,user,sourceCompanyId,'departments',String(row.department_id));
  if(!dept||String(dept.id)!==String(row.department_id)||String(dept.company_id)!==String(sourceCompanyId)||typeof dept.name!=='string'||!dept.name||dept.name.length>100)throw Error('原岗位所属公司或部门核对失败');
  if(row.name===position.name)return null;
  return {name:row.name,departmentName:dept.name};
}
