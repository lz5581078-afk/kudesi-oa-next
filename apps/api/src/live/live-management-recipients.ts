import { EntityManager } from 'typeorm';
import { Department, Position, User } from '../entities';

const HR=new Set(['人事','人事部','人事部门','人事综合部','人力资源部']);
const MANAGEMENT=new Set(['总经办','总经办部门','总经理办公室','A总经理','总经理','总经理部','总经理部门']);
/** Active department trees and primary/secondary positions; never cross company boundaries. */
export async function liveManagementRecipients(em:EntityManager,companyId:number) {
  const departments=await em.find(Department,{where:{companyId,status:'active'}});
  const positions=await em.find(Position,{where:{companyId,status:'active'}});
  const people=await em.find(User,{where:{companyId,status:'active'}});
  const members=(names:Set<string>)=>{
    const ids=new Set(departments.filter(d=>names.has(d.name.trim())).map(d=>d.id));
    let size=-1;
    while(size!==ids.size){size=ids.size;for(const d of departments)if(d.parentId&&ids.has(d.parentId))ids.add(d.id);}
    const jobs=new Set(positions.filter(p=>p.departmentId&&ids.has(p.departmentId)).map(p=>p.id));
    return people.filter(u=>u.departmentId&&ids.has(u.departmentId)||[u.positionId,...(u.extraPositionIds??[])].some(id=>id!=null&&jobs.has(id))).map(u=>u.id);
  };
  return {hr:members(HR),management:members(MANAGEMENT)};
}
