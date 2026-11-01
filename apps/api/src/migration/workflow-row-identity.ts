const keys:Record<string,string[]>={workflow_business_observers:['company_id','run_id','employee_id'],workflow_timeout_policies:['company_id','template_id','node_key']};
/** Shared by raw persistence and field accounting, including composite keys. */
export function workflowRowIdentity(table:string,row:Record<string,unknown>):string{
  if(row.id!=null)return String(row.id);
  const fields=Object.hasOwn(keys,table)?keys[table]:undefined;if(!fields||fields.some(k=>row[k]==null))throw new Error('流程来源存在未定义的复合身份');
  return JSON.stringify(fields.map(k=>row[k]));
}
