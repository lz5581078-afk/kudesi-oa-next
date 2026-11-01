import type { EntityManager } from 'typeorm';
import { WorkItem, ResourceRecord, User, FlowRun } from '../entities';
import { legacyWallTime as wall } from './legacy-time';
import { TASK_FEEDBACK_PRESETS } from '@kudesi/shared';
import { isDeepStrictEqual } from 'node:util';

type Row = Record<string, any>;
interface Context {
  em: EntityManager; companyId: number; sourceCompanyId: number;
  lookup(type: string, id: unknown): number | undefined;
  register(type: string, id: string, target: number): Promise<void>;
}
function controlled(ctx: Context, task: Row) {
  if (!ctx.em.queryRunner?.isTransactionActive || ctx.em.queryRunner.data.legacyImport !== true) throw new Error('旧任务续办必须位于迁移事务');
  if (String(task.company_id) !== String(ctx.sourceCompanyId) || !['pending', 'overdue'].includes(task.status)) throw new Error('旧任务状态或公司尚未兼容');
}
async function persist(ctx: Context, task: Row, opts: { ledgerType: string; requiresReview: boolean; feedbackPreset: string | null; description?: string; createdAtUnknown?: boolean }) {
  let storeId: number | null = null;
  if (task.store_id != null) {
    storeId = ctx.lookup('stores', task.store_id) ?? null;
    if (!storeId || !await ctx.em.findOneBy(ResourceRecord, { id: storeId, companyId: ctx.companyId, type: 'stores' })) throw new Error('旧任务关联店铺未迁入本公司');
  }
  const mapped = async (v: unknown, optional = false): Promise<number | null> => {
    if (v == null && optional) return null;
    const id = ctx.lookup('user', v);
    if (!id || !await ctx.em.findOneBy(User, { id, companyId: ctx.companyId })) throw new Error('旧任务人员映射缺失');
    return id;
  };
  const exists = ctx.lookup(opts.ledgerType, task.id);
  if (exists) { await ctx.em.findOneByOrFail(WorkItem, { id: exists, companyId: ctx.companyId, kind: 'task' }); return { id: exists, reused: true }; }
  const description = [opts.description, task.severity === 'urgent' ? '原优先级：紧急' : task.severity === 'important' ? '原优先级：重要' : ''].filter(Boolean).join('\n') || null;
  const work = await ctx.em.save(WorkItem, ctx.em.create(WorkItem, {
    companyId: ctx.companyId, kind: 'task', runId: null, stepId: null, assigneeId: (await mapped(task.assignee_id))!,
    createdBy: null, routineId: null, scheduleKey: null, storeId, title: task.title, description, status: 'open', supervisorId: await mapped(task.supervisor_id, true),
    requiresReview: opts.requiresReview, feedbackPreset: opts.feedbackPreset, completionStandard: task.completion_standard ?? null,
    submitPayload: null, isAbnormal: false, dueAt: wall(task.due_at), overdueNotifiedAt: null,
    ...(!opts.createdAtUnknown ? { createdAt: wall(task.created_at, true)! } : {}),
    finishedAt: null, doneNote: task.result_note ?? null, startedAt: null, submittedAt: null, reviewNote: task.review_comment ?? null,
  }));
  await ctx.register(opts.ledgerType, String(task.id), work.id);
  return { id: work.id, reused: false };
}
/** Frozen task owner/store/reviewer, without activating future recurrence. */
export async function importStandaloneTask(ctx: Context, task: Row, template?: Row) {
  controlled(ctx, task);
  if (!['manual', 'routine'].includes(task.source_type) || task.workflow_instance_id != null || task.workflow_node_record_id != null || task.relation_type != null || task.submitted_at != null) throw new Error('旧任务状态或业务关联尚未兼容');
  const routine = task.source_type === 'routine';
  if ((!routine && task.template_id != null) || (routine && (!template || String(template.company_id) !== String(ctx.sourceCompanyId) || String(template.id) !== String(task.template_id) || ![0, 1].includes(Number(template.requires_review))))) throw new Error('旧任务模板关联或复核规则尚未兼容');
  if (task.feedback_to_id != null && String(task.feedback_to_id) !== String(task.supervisor_id)) throw new Error('旧任务另有反馈接收人，尚未兼容');
  const schema = task.feedback_schema == null ? null : typeof task.feedback_schema === 'string' ? JSON.parse(task.feedback_schema) : task.feedback_schema;
  const hasSchema = Array.isArray(schema) && schema.length > 0;
  const feedbackPreset = hasSchema ? Object.entries(TASK_FEEDBACK_PRESETS).find(([, preset]) => isDeepStrictEqual(preset.fields, schema))?.[0] : 'simple';
  if (hasSchema && !feedbackPreset) throw new Error('旧任务自定义反馈表单尚未兼容');
  const requiresReview = routine && Number(template!.requires_review) === 1;
  if (requiresReview && task.supervisor_id == null) throw new Error('旧任务需要复核但缺少监督人');
  return persist(ctx, task, { ledgerType: 'work_item', requiresReview, feedbackPreset: feedbackPreset ?? null });
}
/** The earlier /api/tasks/:id/complete closes the task independently. Its
 * workflow_id is context, not a flow-engine todo: approving the related flow
 * must not cancel this task. Keep the two source namespaces distinct. */
export async function importEarlyTask(ctx: Context, task: Row, workflow?: Row) {
  controlled(ctx, task);
  if (task.workflow_id != null && (!workflow || String(workflow.company_id) !== String(ctx.sourceCompanyId) || String(workflow.id) !== String(task.workflow_id))) throw new Error('旧任务关联早期流程缺失或公司不一致');
  return persist(ctx, task, { ledgerType: 'early_work_item', requiresReview: false, feedbackPreset: null, createdAtUnknown: true,
    description: [workflow ? `关联旧流程：${workflow.title}（原编号 ${workflow.id}）` : '', '旧站未记录任务创建时间；页面创建时间为迁入时间。'].filter(Boolean).join('\n') });
}
/** In the old linear model, submit closes only task_instances; it does not
 * advance workflow_instances. Keep this task independent of the engine todo. */
export async function importLinearTask(ctx: Context, task: Row, workflow: Row) {
  controlled(ctx, task);
  if (workflow.graph_status !== 'linear' || String(workflow.company_id) !== String(ctx.sourceCompanyId) || String(workflow.id) !== String(task.workflow_instance_id) || task.source_type !== 'workflow' || task.template_id != null || task.submitted_at != null) throw new Error('旧任务线性流程关联尚未兼容');
  const runId = ctx.lookup('flow_run', workflow.id);
  if (!runId || !await ctx.em.findOneBy(FlowRun, { id: runId, companyId: ctx.companyId, templateKey: 'legacy-linear' })) throw new Error('旧任务关联流程未迁入');
  const schema = task.feedback_schema == null ? [] : typeof task.feedback_schema === 'string' ? JSON.parse(task.feedback_schema) : task.feedback_schema;
  const feedbackPreset = Array.isArray(schema) && schema.length === 0 ? 'simple' : Object.entries(TASK_FEEDBACK_PRESETS).find(([, p]) => isDeepStrictEqual(p.fields, schema))?.[0];
  if (!feedbackPreset) throw new Error('旧任务自定义反馈表单尚未兼容');
  let feedback = '';
  if (task.feedback_to_id != null) {
    const id = ctx.lookup('user', task.feedback_to_id);
    const person = id && await ctx.em.findOneBy(User, { id, companyId: ctx.companyId });
    if (!person) throw new Error('旧任务反馈接收人未迁入本公司');
    feedback = `原反馈接收人：${person.name}`;
  }
  return persist(ctx, task, { ledgerType: 'work_item', requiresReview: false, feedbackPreset,
    description: [`关联流程：${workflow.title}（新编号 ${runId}，旧编号 ${workflow.id}）`, `流程办理：/workbench/started?run=${runId}`, feedback, '按旧站规则，此任务提交完成与流程推进分别办理。'].filter(Boolean).join('\n') });
}
