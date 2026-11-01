'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const KNOWN = {
  resolveAssignee: '84c82ebc21adaeb5df6cb776ed7f0ac01253ab19174b9ec789a351e581405c52',
  getBossEmployeeId: 'c3bc64b2e9c6d0de01050b9e93fcb81d32cee51f4fa9bd3805a23666c67f2437',
};
/** Read the old role/delegation policy result. No source application is started,
 * no source function is executed, and no new runtime name-regex is introduced. */
async function resolveLegacyRole(query, companyId, role, fallbackEmployeeId, asOf) {
  if (role) {
    const [delegation] = await query(`SELECT d.delegate_employee_id id FROM delegations d JOIN employees e ON e.id=d.delegate_employee_id AND e.status='active' JOIN departments dep ON dep.id=e.department_id WHERE d.source_type='role' AND d.source_id=? AND dep.company_id=? AND d.status='active' AND d.starts_at<=? AND (d.ends_at IS NULL OR d.ends_at>=?) ORDER BY d.id DESC LIMIT 1`, [role, companyId, asOf, asOf]);
    if (delegation) return { employeeId: String(delegation.id), via: 'delegation' };
    const [employee] = await query(`SELECT e.id FROM employees e JOIN departments d ON d.id=e.department_id LEFT JOIN employee_roles er ON er.employee_id=e.id AND er.status='active' LEFT JOIN roles r ON r.id=er.role_id WHERE e.status='active' AND (e.role_key=? OR r.role_key=?) AND d.company_id=? ORDER BY e.id LIMIT 1`, [role, role, companyId]);
    if (employee) return { employeeId: String(employee.id), via: 'role' };
  }
  if (fallbackEmployeeId) {
    const [fallback] = await query(`SELECT e.id FROM employees e JOIN departments d ON d.id=e.department_id WHERE e.id=? AND d.company_id=? AND e.status='active' LIMIT 1`, [fallbackEmployeeId, companyId]);
    if (fallback) return { employeeId: String(fallback.id), via: 'fallback' };
  }
  const [boss] = await query(`SELECT e.id FROM employees e JOIN departments d ON d.id=e.department_id WHERE d.company_id=? AND e.status='active' AND e.role_key='boss' ORDER BY e.id LIMIT 1`, [companyId]);
  if (boss) return { employeeId: String(boss.id), via: 'boss_fallback' };
  const [first] = await query(`SELECT e.id FROM employees e JOIN departments d ON d.id=e.department_id WHERE d.company_id=? AND e.status='active' ORDER BY e.id LIMIT 1`, [companyId]);
  // The old last literal fallback was employee 1, potentially another tenant.
  // Do not fabricate that cross-company assignment when no member exists.
  if (!first) throw Error('旧流程没有本公司可用的后备办理人');
  return { employeeId: String(first.id), via: 'first_member_fallback' };
}
async function readLegacyAssignments(connection, workflow, app, requireFromOldApp) {
  const closed = new Set(['completed', 'cancelled', 'rejected', 'skipped']);
  const runs = (workflow.tables.workflow_instances || []).filter(r => !closed.has(r.status) && (r.graph_status === 'linear' || (!r.graph_status && (workflow.tables.workflow_templates || []).some(t => String(t.id) === String(r.template_id) && t.flow_mode === 'linear'))));
  if (!runs.length) return;
  const source = fs.readFileSync(path.join(app, 'server/index.js'), 'utf8');
  const ast = requireFromOldApp('@babel/parser').parse(source, { sourceType: 'unambiguous' });
  const functions = {};
  for (const [name, known] of Object.entries(KNOWN)) {
    const fn = ast.program.body.find(n => n.type === 'FunctionDeclaration' && n.id?.name === name);
    if (!fn) throw Error('旧流程选人策略缺失，不能猜测');
    const code = source.slice(fn.start, fn.end), hash = crypto.createHash('sha256').update(code).digest('hex');
    if (hash !== known) throw Error('旧流程选人策略已变化，须重新核对源码');
    functions[name] = code;
  }
  const query = async (sql, args) => (await connection.query(sql, args))[0];
  const [clock] = await query('SELECT CURRENT_TIMESTAMP AS asOf');
  const picks = [], cache = new Map();
  const pick = async (role, fallback) => {
    const key = JSON.stringify([role, fallback]);
    if (!cache.has(key)) cache.set(key, await resolveLegacyRole(query, workflow.companyId, role, fallback, clock.asOf));
    return cache.get(key);
  };
  for (const run of runs) for (const node of (workflow.tables.workflow_template_nodes || []).filter(n => String(n.template_id) === String(run.template_id))) {
    const owner = await pick(node.assignee_role, node.assignee_employee_id || run.requester_id);
    const supervisor = await pick(node.supervisor_role, node.supervisor_employee_id || 1);
    picks.push({ runId: String(run.id), nodeId: String(node.id), owner, supervisor });
  }
  workflow.assignment = { policyHash: crypto.createHash('sha256').update(JSON.stringify(KNOWN)).digest('hex'), functions, picks };
}
async function readCurrentSkuAssignments(connection,workflow,app,requireFromOldApp){
  const templates=(workflow.tables.workflow_templates||[]).filter(t=>t.related_object_type==='bundle_application'&&t.status==='active');
  if(!templates.length)return;
  if(templates.length!==1)throw Error('旧SKU存在多个启用模板，须核对新发起入口');
  const file=path.join(app,'server/modules/workflows/node-recipients.js'),code=fs.readFileSync(file);
  const policyHash=crypto.createHash('sha256').update(code).digest('hex');
  if(policyHash!=='d1423fdd9fe64695155c6484845e478f52f7501dcdf2d10c6e61cb7f2f5d0a54')throw Error('旧SKU选人策略已变化，须重新核对源码');
  const policy=requireFromOldApp(file),template=templates[0],nodes=(workflow.tables.workflow_template_nodes||[]).filter(n=>String(n.template_id)===String(template.id)).sort((a,b)=>Number(a.node_order)-Number(b.node_order));
  const query=async(sql,args)=>{
    if(!/^\s*SELECT\b/i.test(sql)||sql.includes(';'))throw Error('旧SKU权限核对只允许单条只读查询');
    return (await connection.query(sql,args))[0];
  };
  const picks=[];
  for(const node of nodes){
    if(['submit','end'].includes(node.node_type))continue;
    const result=await policy.resolveNodeRecipients(workflow.companyId,node,query);
    picks.push({nodeId:String(node.id),employeeIds:result.employeeIds.map(String),mode:result.mode,departmentId:result.departmentId==null?null:String(result.departmentId)});
  }
  if(!code.equals(fs.readFileSync(file)))throw Error('旧SKU选人策略读取期间发生变化');
  workflow.currentSku={templateId:String(template.id),policyHash,policyCode:code.toString('utf8'),picks};
}
module.exports = { readLegacyAssignments, resolveLegacyRole, readCurrentSkuAssignments };
