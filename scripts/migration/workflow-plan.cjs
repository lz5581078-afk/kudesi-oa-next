'use strict';

const CLOSED = new Set(['completed', 'cancelled', 'rejected', 'skipped']);
const OPEN = new Set(['draft', 'submitted', 'approving', 'processing', 'executing', 'finance_confirming', 'returned', 'overdue', 'abnormal', 'blocked']);
const TASK_CLOSED = new Set(['completed', 'cancelled']);
const TASK_OPEN = new Set(['pending', 'overdue', 'processing', 'submitted', 'returned']);
const text = v => v == null ? '' : String(v);
const json = (v, fallback) => v == null || v === '' ? fallback : typeof v === 'string' ? JSON.parse(v) : v;

/** Structural plan only. Readiness does not imply that business hooks, target
 * references or all financial effects have passed end-to-end verification. */
function planWorkflowContinuations({ companyId, tables }, now) {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || !Number.isFinite(Date.parse(now))) throw new Error('Explicit source company and evaluation time required');
  const rows = name => tables[name] || [];
  const index = name => new Map(rows(name).map(r => [text(r.id), r]));
  const templates = index('workflow_templates'), runs = index('workflow_instances');
  const batches = index('workflow_batches'), records = index('workflow_node_records');
  const itemsByRun = new Map();
  const issues = [], continuations = [], tasks = [], earlyWorkflows = [], earlyTasks = [];
  const issue = (table, id, code) => issues.push({ table, id: text(id), code });
  for (const [table, list] of Object.entries(tables)) {
    const seen = new Set();
    for (const r of list) {
      if (r.company_id != null && text(r.company_id) !== text(companyId)) throw new Error('Cross-company workflow source');
      if (r.id != null) {
        if (seen.has(text(r.id))) throw new Error(`Duplicate source identity: ${table}`);
        seen.add(text(r.id));
      }
    }
  }
  for (const item of rows('workflow_batch_items')) {
    const key = text(item.workflow_instance_id);
    if (!runs.has(key)) issue('workflow_batch_items', item.id, 'missing_run');
    if (!batches.has(text(item.batch_id))) issue('workflow_batch_items', item.id, 'missing_batch');
    if (itemsByRun.has(key)) issue('workflow_batch_items', item.id, 'multiple_items_per_run');
    itemsByRun.set(key, item);
  }
  for (const r of rows('workflow_node_records')) if (!runs.has(text(r.workflow_instance_id))) issue('workflow_node_records', r.id, 'missing_run');
  for (const run of rows('workflow_instances')) {
    if (CLOSED.has(run.status)) continue;
    if (!OPEN.has(run.status)) { issue('workflow_instances', run.id, 'unsupported_status'); continue; }
    const template = templates.get(text(run.template_id));
    if (!template) { issue('workflow_instances', run.id, 'missing_template'); continue; }
    const history = rows('workflow_node_records').filter(r => text(r.workflow_instance_id) === text(run.id));
    const item = itemsByRun.get(text(run.id));
    const batch = item && batches.get(text(item.batch_id));
    let nodes;
    try {
      nodes = batch ? json(batch.template_snapshot, null) : rows('workflow_template_nodes').filter(n => text(n.template_id) === text(template.id));
      if (!Array.isArray(nodes) || !nodes.length) throw new Error();
    } catch { issue('workflow_instances', run.id, 'invalid_node_snapshot'); continue; }
    // Historical graph batch snapshots, rather than today's editable template,
    // define the routes and handlers for an in-flight application.
    let active = history.filter(r => Number(r.is_active) === 1);
    const linear = !['batch', 'business', 'graph'].includes(run.graph_status) && (run.graph_status === 'linear' || template.flow_mode === 'linear');
    if (!active.length && linear) active = history.filter(r => text(r.template_node_id) === text(run.current_node_id) && r.status === 'pending');
    const current = nodes.find(n => text(n.id) === text(run.current_node_id));
    // Old /advance leaves the submitted first node completed, while the run
    // explicitly awaits its next advance. Record this boundary; do not change
    // that completed record into pending or fabricate an approval.
    const boundary = !active.length && linear && run.status === 'submitted' && current?.node_type === 'submit' && history.some(r => text(r.template_node_id) === text(current.id) && r.status === 'completed' && r.action === 'submitted');
    if (!active.length && !boundary) issue('workflow_instances', run.id, 'no_actionable_node');
    const keys = active.map(r => text(r.node_key || nodes.find(n => text(n.id) === text(r.template_node_id))?.node_key));
    for (const r of active) {
      const node = nodes.find(n => r.node_key ? n.node_key === r.node_key : text(n.id) === text(r.template_node_id));
      if (!node) issue('workflow_node_records', r.id, 'missing_snapshot_node');
      if (CLOSED.has(r.status)) issue('workflow_node_records', r.id, 'closed_active_node');
      if (!r.owner_id && !rows('workflow_node_recipients').some(x => text(x.node_record_id) === text(r.id))) issue('workflow_node_records', r.id, 'missing_recipients');
    }
    let declared;
    try { declared = json(run.active_node_keys, []); if (!Array.isArray(declared)) throw new Error(); }
    catch { issue('workflow_instances', run.id, 'invalid_active_keys'); declared = []; }
    if (!linear && (keys.length !== declared.length || keys.some(k => !declared.includes(k)))) issue('workflow_instances', run.id, 'active_keys_mismatch');
    const sku = run.graph_status === 'batch' && template.related_object_type === 'bundle_application';
    if (sku && (!item || !batch)) issue('workflow_instances', run.id, 'missing_sku_item');
    continuations.push({ sourceRunId: text(run.id), templateId: text(template.id), kind: sku ? 'sku' : linear ? 'legacy_linear' : 'business_graph', sourceStatus: run.status, batchId: item ? text(item.batch_id) : null, itemId: item ? text(item.id) : null, itemStatus: item?.status ?? null, currentRecordIds: active.map(r => text(r.id)), currentNodeKeys: boundary ? [text(current.node_key)] : keys, submittedBoundary: Boolean(boundary), historyCount: history.length, dueAt: run.due_at ?? null });
  }
  for (const task of rows('task_instances')) {
    if (TASK_CLOSED.has(task.status)) continue;
    if (!TASK_OPEN.has(task.status)) { issue('task_instances', task.id, 'unsupported_status'); continue; }
    const run = task.workflow_instance_id == null ? null : runs.get(text(task.workflow_instance_id));
    const record = task.workflow_node_record_id == null ? null : records.get(text(task.workflow_node_record_id));
    if (!task.assignee_id) issue('task_instances', task.id, 'missing_assignee');
    if (task.source_type === 'workflow') {
      if (!run) issue('task_instances', task.id, 'missing_run');
      if (!record || text(record.workflow_instance_id) !== text(run?.id)) issue('task_instances', task.id, 'mismatched_node_record');
      if (run && CLOSED.has(run.status)) issue('task_instances', task.id, 'open_task_on_closed_run');
      if (record && record.status !== 'pending') issue('task_instances', task.id, 'open_task_on_closed_node');
    } else if (!['manual', 'routine'].includes(task.source_type)) issue('task_instances', task.id, 'unsupported_source');
    tasks.push({ sourceTaskId: text(task.id), sourceRunId: run ? text(run.id) : null, sourceRecordId: record ? text(record.id) : null, kind: task.source_type, sourceStatus: task.status, assigneeId: text(task.assignee_id), supervisorId: task.supervisor_id == null ? null : text(task.supervisor_id), dueAt: task.due_at ?? null, submittedAt: task.submitted_at ?? null });
  }
  // The earliest OA model remains alongside workflow_instances/task_instances.
  // Equal numeric IDs across these tables are different source identities.
  const earlyRuns = index('workflows');
  for (const run of rows('workflows')) {
    if (CLOSED.has(run.status)) continue;
    if (!OPEN.has(run.status)) issue('workflows', run.id, 'unsupported_status');
    earlyWorkflows.push({ sourceTable: 'workflows', sourceId: text(run.id), sourceStatus: run.status, type: run.type, requesterId: text(run.requester_id), currentOwnerId: text(run.current_owner_id), dueAt: run.due_at ?? null });
    issue('workflows', run.id, 'early_model_runtime_not_verified');
  }
  for (const task of rows('tasks')) {
    if (TASK_CLOSED.has(task.status)) continue;
    if (!TASK_OPEN.has(task.status)) issue('tasks', task.id, 'unsupported_status');
    if (task.workflow_id != null && !earlyRuns.has(text(task.workflow_id))) issue('tasks', task.id, 'missing_early_workflow');
    earlyTasks.push({ sourceTable: 'tasks', sourceId: text(task.id), workflowId: task.workflow_id == null ? null : text(task.workflow_id), sourceStatus: task.status, assigneeId: text(task.assignee_id), supervisorId: text(task.supervisor_id), dueAt: task.due_at ?? null });
  }
  return { companyId, evaluatedAt: now, productionDataChanged: false, continuations, tasks, earlyWorkflows, earlyTasks, issues,
    counts: { allRuns: rows('workflow_instances').length, unfinishedRuns: continuations.length, skuDrafts: continuations.filter(r => r.kind === 'sku' && r.itemStatus === 'draft').length, skuReturned: continuations.filter(r => r.kind === 'sku' && r.itemStatus === 'returned').length, submittedBoundaries: continuations.filter(r => r.submittedBoundary).length, unfinishedTasks: tasks.length, earlyUnfinishedWorkflows: earlyWorkflows.length, earlyUnfinishedTasks: earlyTasks.length },
    runtimeCompatibilityVerified: false };
}

module.exports = { planWorkflowContinuations };
