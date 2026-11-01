import { employeePositions } from './employee-positions';
import type { LegacyArchive } from './protocol';
const base=()=>({positions:[{id:1},{id:2}],employeePositions:[]} as unknown as LegacyArchive);
describe('迁移现任岗位与原始任职分开处理',()=>{
  it('显式停用或已结束任职不赋权；字符串0不能当作主岗位',()=>{
    const s=base();s.employeePositions=[{employee_id:9,position_id:2,is_primary:'0',status:'inactive'},{employee_id:9,position_id:1,is_primary:'1',status:'active'}];
    expect(employeePositions(s,9)).toEqual({primary:s.employeePositions[1],extras:[]});
    s.employeePositions[1].ended_at='2026-01-01';expect(()=>employeePositions(s,9)).toThrow('任职状态');
  });
  it('全量原文优先于已过滤适配器；未知状态/多个主岗/无主岗/重复有效登记都拒绝',()=>{
    const s=base();s.sourceRows=[{table:'employee_positions',key:'1',row:{id:1,employee_id:9,position_id:1,is_primary:1,status:'active',ended_at:null}}];
    expect(employeePositions(s,9).primary?.position_id).toBe(1);
    const row=s.sourceRows[0].row;
    row.status='unknown';expect(()=>employeePositions(s,9)).toThrow();row.status='active';
    row.is_primary='0';expect(()=>employeePositions(s,9)).toThrow();row.is_primary=1;
    s.sourceRows.push({table:'employee_positions',key:'2',row:{...row,id:2,position_id:2}});expect(()=>employeePositions(s,9)).toThrow();
    s.sourceRows[1].row.is_primary=0;s.sourceRows[1].row.position_id=1;expect(()=>employeePositions(s,9)).toThrow();
  });
});
