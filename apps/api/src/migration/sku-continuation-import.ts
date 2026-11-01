import type { EntityManager } from 'typeorm';
import type { CryptoService } from '../common/crypto.service';
import { FlowDefinition, FlowRun, FlowStep, WorkItem } from '../entities';
import { preserveSourceRow } from './source-rows';
import { prepareSkuContinuation } from './sku-continuation';
import { isDeepStrictEqual } from 'node:util';
import { legacyWallTime as wall } from './legacy-time';

type Context = Parameters<typeof prepareSkuContinuation>[0];
type Row = Record<string, any>;
interface ImportContext {
  em: EntityManager; crypto: CryptoService; companyId: number;
  lookup(type: string, sourceId: string): number | undefined;
  register(type: string, sourceId: string, targetId: number): Promise<void>;
}
const parsed = (v: any) => v == null ? {} : typeof v === 'string' ? JSON.parse(v) : v;
const id = (v: any) => String(v);

/** Transaction-only continuation. Does not start/advance a flow or call any
 * business adapter. Frozen recipients and existing open work items are copied;
 * a draft with no old task is not assigned a newly invented task. */
export async function importSkuContinuation(ctx: ImportContext, source: Context, sourceTasks: Row[]) {
  if (!ctx.em.queryRunner?.isTransactionActive || !ctx.em.queryRunner.data.legacyImport) throw new Error('SKU续办导入必须位于迁移事务');
  const plan = prepareSkuContinuation(source);
  const raw = async (table: string, row: Row) => preserveSourceRow(ctx.em, ctx.crypto, { companyId: ctx.companyId, sourceCompanyId: source.sourceCompanyId, table, key: id(row.id) }, row);
  await raw('workflow_batches', source.batch); await raw('workflow_batch_items', source.item); await raw('workflow_instances', source.run);
  const history = source.records.filter(r => id(r.workflow_instance_id) === id(source.run.id)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || Number(a.id) - Number(b.id));
  for (const record of history) await raw('workflow_node_records', record);
  const recordIds = new Set(history.map(r => id(r.id)));
  for (const recipient of source.recipients.filter(r => recordIds.has(id(r.node_record_id)))) await raw('workflow_node_recipients', recipient);
  const tasks = sourceTasks.filter(t => id(t.workflow_instance_id) === id(source.run.id));
  for (const task of tasks) await raw('task_instances', task);
  const existing = ctx.lookup('flow_run', id(source.run.id));
  if (existing) {
    await ctx.em.findOneByOrFail(FlowRun, { id: existing, companyId: ctx.companyId });
    return { runId: existing, reused: true, draftValidationErrors: plan.draftValidationErrors };
  }
  let definitionId = ctx.lookup('flow_definition', id(source.batch.id));
  if (definitionId) {
    const def = await ctx.em.findOneByOrFail(FlowDefinition, { id: definitionId, companyId: ctx.companyId, templateKey: plan.templateKey });
    if (!isDeepStrictEqual(def.steps, plan.steps)) throw new Error('旧申请的已迁节点快照与来源不同');
  }
  if (!definitionId) {
    const [last] = await ctx.em.query('SELECT COALESCE(MAX(version),0) version FROM flow_definitions WHERE company_id=? AND template_key=?', [ctx.companyId, plan.templateKey]);
    const def = await ctx.em.save(FlowDefinition, ctx.em.create(FlowDefinition, { companyId: ctx.companyId, templateKey: plan.templateKey, version: Number(last.version) + 1, status: 'retired', steps: plan.steps, schemaJson: null, escalateUserIds: [], starterScope: null, createdBy: plan.requesterId, createdAt: wall(source.batch.created_at, true)!, publishedAt: null, publishedBy: null }));
    definitionId = def.id; await ctx.register('flow_definition', id(source.batch.id), def.id);
  }
  const revision = Number(source.item.revision ?? 1);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('旧SKU版本号无效');
  const run = await ctx.em.save(FlowRun, ctx.em.create(FlowRun, { companyId: ctx.companyId, definitionId, templateKey: plan.templateKey, title: source.run.title, status: 'running', requesterId: plan.requesterId, currentStepKey: 'apply', payload: plan.payload, stepsSnapshot: plan.steps, escalateUserIds: [], revision, dueAt: wall(source.run.due_at), requestKey: `legacy-oa:${source.sourceCompanyId}:${source.run.id}`, createdAt: wall(source.run.created_at, true)!, finishedAt: null }));
  await ctx.register('flow_run', id(source.run.id), run.id);
  const nodeMap = new Map((parsed(source.batch.template_snapshot) as Row[]).map((n, i) => [n.node_key, plan.steps[i]]));
  const mapped = (type: string, value: any) => {
    const target = source.lookup(type, value);
    if (!target) throw new Error(`SKU续办缺少${type}映射`);
    return target;
  };
  let seq = 0;
  for (const r of history) {
    const step = nodeMap.get(r.node_key);
    if (!step || typeof r.node_name !== 'string' || r.node_name.length > 40) throw new Error('SKU历史节点无法无损对应');
    const active = id(r.id) === plan.activeStep.sourceRecordId;
    let status: FlowStep['status'];
    if (active) status = 'active';
    else if (r.action === 'return' && ['rejected', 'returned', 'completed'].includes(r.status)) status = 'returned';
    else if (r.status === 'completed') status = 'done';
    else if (r.status === 'cancelled') status = 'cancelled';
    else throw new Error('SKU历史状态尚未兼容');
    const timing = parsed(r.timing_json);
    const recipients = source.recipients.filter(x => id(x.node_record_id) === id(r.id)).map(x => mapped('user', x.employee_id));
    if (!recipients.length && r.owner_id) recipients.push(mapped('user', r.owner_id));
    // Raw legacy forms are encrypted above, never returned as unrestricted
    // FlowStep.form (they may contain cost snapshots unknown to new field ACLs).
    const row = await ctx.em.save(FlowStep, ctx.em.create(FlowStep, { companyId: ctx.companyId, runId: run.id, seq: ++seq, stepKey: step.key, stepName: r.node_name, stepType: step.type, status, enteredVia: active ? plan.activeStep.enteredVia : 'normal', recipients, handledBy: timing.handledBy ? mapped('user', timing.handledBy) : null, action: active ? null : r.action === 'return' ? 'return' : r.action === 'submit' ? 'pass' : null, comment: r.comment ?? null, form: null, enteredAt: wall(r.created_at, true)!, finishedAt: wall(r.completed_at), dueAt: active ? wall(source.run.due_at) : null }));
    await ctx.register('flow_step', id(r.id), row.id);
  }
  for (const task of tasks) {
    if (!['pending', 'overdue', 'completed', 'cancelled'].includes(task.status)) throw new Error('SKU待办状态尚未兼容');
    const stepId = ctx.lookup('flow_step', id(task.workflow_node_record_id));
    if (!stepId) throw new Error('SKU原待办节点未迁入');
    const open = ['pending', 'overdue'].includes(task.status);
    if (open && id(task.workflow_node_record_id) !== plan.activeStep.sourceRecordId) throw new Error('SKU活待办与当前节点不一致');
    if (open && !plan.activeStep.recipients.includes(mapped('user', task.assignee_id))) throw new Error('SKU活待办办理人与冻结名单不一致');
    const work = await ctx.em.save(WorkItem, ctx.em.create(WorkItem, { companyId: ctx.companyId, kind: 'flow', runId: run.id, stepId, assigneeId: mapped('user', task.assignee_id), createdBy: null, routineId: null, scheduleKey: null, title: task.title, description: null, status: open ? 'open' : task.status === 'completed' ? 'done' : 'cancelled', supervisorId: task.supervisor_id ? mapped('user', task.supervisor_id) : null, requiresReview: false, feedbackPreset: null, completionStandard: task.completion_standard ?? null, submitPayload: null, isAbnormal: false, dueAt: wall(task.due_at), overdueNotifiedAt: null, createdAt: wall(task.created_at, true)!, finishedAt: wall(task.completed_at), doneNote: task.result_note ?? null, startedAt: null, submittedAt: wall(task.submitted_at), reviewNote: task.review_comment ?? null }));
    await ctx.register('work_item', id(task.id), work.id);
  }
  return { runId: run.id, reused: false, draftValidationErrors: plan.draftValidationErrors };
}
