import type { DataSource } from 'typeorm';
import { User } from '../entities';
import { OrgAdminService } from '../org/org-admin.service';
import type { ResourcesService } from '../resources/resources.service';
import type { AuthUser } from '../common/auth.decorators';
import type { LegacyArchive } from './protocol';

/** Check actual personnel-record response and native live assignments separately.
 * Do not infer successful preservation from an encrypted-row insertion count. */
export async function verifyEmployeePositionView(ds:DataSource,resources:ResourcesService,user:AuthUser,source:LegacyArchive,lookup:(type:string,id:unknown)=>number|undefined){
  const rows=(source.sourceRows??[]).filter(r=>r.table==='employee_positions');
  if(!rows.length)return 0;
  const org=new OrgAdminService(ds,resources);let verified=0;
  const fail=()=>Object.assign(Error('旧任职履历或现任岗位实际回读不一致'),{name:'LegacyDataError'});
  for(const e of source.employees){
    const id=lookup('user',e.id);if(!id)throw fail();
    const native=await ds.manager.findOneByOrFail(User,{id,companyId:user.companyId});
    const originals=rows.filter(r=>String(r.row.employee_id)===String(e.id));
    const view=(await org.staffRecords(user,id)).legacyAssignments;
    if(view.length!==originals.length)throw fail();
    for(const original of originals){
      const r=original.row,v=view.find(v=>v.sourceId===String(r.id));
      const pos=source.positions.find(p=>String(p.id)===String(r.position_id)),dept=source.departments.find(d=>String(d.id)===String(pos?.department_id));
      if(!v||v.sourceEmployeeId!==String(e.id)||v.sourcePositionId!==String(r.position_id)||v.status!==r.status||v.isPrimary!==(r.is_primary===1||r.is_primary==='1'||r.is_primary===true)||v.startedAt!==r.started_at||v.endedAt!==r.ended_at||v.positionName!==pos?.name||v.departmentName!==dept?.name)throw fail();
      verified++;
    }
    const active=originals.filter(r=>r.row.status==='active'&&r.row.ended_at===null),main=active.find(r=>[1,'1',true].includes(r.row.is_primary as any));
    const extras=active.filter(r=>r!==main).map(r=>lookup('position',r.row.position_id)).sort((a,b)=>Number(a)-Number(b));
    if(native.positionId!==(main?lookup('position',main.row.position_id):null)||JSON.stringify([...(native.extraPositionIds??[])].sort((a,b)=>a-b))!==JSON.stringify(extras))throw fail();
  }
  if(verified!==rows.length)throw fail();return verified;
}
