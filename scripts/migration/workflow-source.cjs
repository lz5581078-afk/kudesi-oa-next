'use strict';

// Read using the adapter's existing read-only transaction. Parent joins are
// explicit: several legacy child tables have no company_id of their own.
const DIRECT = [
  'workflow_templates', 'workflow_instances', 'workflow_batches', 'workflow_batch_items',
  'workflow_batch_item_deletions', 'workflow_node_recipients', 'workflow_business_events',
  'workflow_business_runs', 'workflow_business_commands', 'workflow_business_observers',
  'task_templates', 'task_instances', 'tasks', 'workflows',
  'workflow_timeout_policies', 'workflow_timeout_policy_events', 'workflow_timeout_incidents',
  'workflow_timeout_escalations', 'workflow_timeout_penalties', 'workflow_timeout_penalty_events',
];
const PARENTS = {
  workflow_template_nodes: ['workflow_templates', 'template_id'],
  workflow_node_records: ['workflow_instances', 'workflow_instance_id'],
};
const TABLES = [...DIRECT, ...Object.keys(PARENTS)];

async function readWorkflowSource(connection, columns, companyId) {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error('Invalid source company');
  const tables = {};
  for (const table of TABLES) {
    const fields = columns.filter(c => c.t === table).map(c => c.c);
    if (!fields.length) continue;
    let where;
    if (PARENTS[table]) {
      const [parent, foreignKey] = PARENTS[table];
      where = `EXISTS (SELECT 1 FROM ${parent} p WHERE p.id=t.${foreignKey} AND p.company_id=?)`;
    } else {
      if (!fields.includes('company_id')) throw new Error(`Unverified workflow ownership: ${table}`);
      where = 't.company_id=?';
    }
    tables[table] = (await connection.query(`SELECT t.* FROM ${table} t WHERE ${where}`, [companyId]))[0];
  }
  return { companyId, tables };
}

module.exports = { readWorkflowSource, TABLES };
