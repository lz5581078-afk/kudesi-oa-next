import type { ResourceRecord } from '../entities';

const from=(r:ResourceRecord)=>String(r.data.effectiveFrom || '0000-01-01');
const to=(r:ResourceRecord)=>String(r.data.effectiveTo || '9999-12-31');
const overlaps=(a:ResourceRecord,b:ResourceRecord)=>from(a)<=to(b) && from(b)<=to(a);
export function costVersionActivationPlan(target:ResourceRecord,records:ResourceRecord[],closePrevious=true) {
  const issues:string[]=[];
  if(!target.data.effectiveFrom)issues.push('启用前必须填写生效开始日期');
  const active=records.filter(r=>r.type==='finance-cost-versions' && r.id!==target.id && r.status==='active');
  const previous=active.find(r=>r.data.isDefault===true);
  let transition:{id:number;name:string;effectiveTo:string} | null=null;
  if(closePrevious && previous && target.data.effectiveFrom && from(previous)<from(target) && to(previous)>=from(target)) {
    const day=new Date(`${String(target.data.effectiveFrom)}T00:00:00Z`);day.setUTCDate(day.getUTCDate()-1);
    transition={id:previous.id,name:previous.title,effectiveTo:day.toISOString().slice(0,10)};
  }
  for(const record of active) {
    const compared=transition?.id===record.id?{...record,data:{...record.data,effectiveTo:transition.effectiveTo}}:record;
    if(overlaps(target,compared))issues.push(`与已启用版本「${record.title}」的生效日期重叠`);
  }
  return {issues,transition,fingerprint:[target.id,target.data.effectiveFrom ?? null,target.data.effectiveTo ?? null,active.map(r=>[r.id,r.status,r.data.effectiveFrom ?? null,r.data.effectiveTo ?? null,r.data.isDefault===true]) ]};
}
