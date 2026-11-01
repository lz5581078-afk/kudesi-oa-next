import type { LegacyArchive } from './protocol';

const fail=()=>Object.assign(Error('旧任职状态、主岗位或来源归属不明确，禁止扩大岗位权限'),{name:'LegacyDataError'});
const primary=(v:unknown)=>v===1||v==='1'||v===true;
/** Full snapshots use every original membership, including inactive history.
 * Partial legacy adapters may omit status, but explicit inactive rows never grant.
 * Employee login status is separate from membership status. */
export function employeePositions(source:LegacyArchive,employeeId:unknown){
  const raw=(source.sourceRows??[]).filter(r=>r.table==='employee_positions');
  const full=raw.length>0||(source.sourceRows??[]).some(r=>r.table==='legacy_schema_inventory');
  const rows=(full?raw.map(r=>r.row):source.employeePositions).filter(r=>String(r.employee_id)===String(employeeId));
  const seen=new Set<string>();
  for(const row of rows){
    if((full&&!['active','inactive'].includes(String(row.status)))||(!full&&row.status!=null&&!['active','inactive'].includes(String(row.status)))||
       ![0,1,'0','1',true,false].includes(row.is_primary as any)||!source.positions.some(p=>String(p.id)===String(row.position_id)))throw fail();
    if(row.status==='active'&&row.ended_at!=null&&row.ended_at!=='')throw fail();
  }
  const active=rows.filter(r=>(r.status==null||r.status==='active')&&!r.ended_at);
  for(const row of active){const id=String(row.position_id);if(seen.has(id))throw fail();seen.add(id);}
  const primaries=active.filter(r=>primary(r.is_primary));
  if(primaries.length>1||(full&&active.length>0&&primaries.length!==1))throw fail();
  const main=primaries[0]??active[0];
  return {primary:main,extras:active.filter(r=>r!==main)};
}
