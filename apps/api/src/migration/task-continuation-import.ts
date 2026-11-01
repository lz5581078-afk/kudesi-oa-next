import type { EntityManager } from 'typeorm';
import { WorkItem, ResourceRecord, User } from '../entities';
import { legacyWallTime as wall } from './legacy-time';
import { TASK_FEEDBACK_PRESETS } from '@kudesi/shared';
import { isDeepStrictEqual } from 'node:util';

type Row = Record<string, any>;
/** Existing independent tasks only. The frozen task owner/store/reviewer are
 * preserved; future recurrence generation is a separate compatibility check. */
export async function importStandaloneTask(ctx: { em: EntityManager; companyId: number; sourceCompanyId: number; lookup(type: string, id: unknown): number | undefined; register(type: string, id: string, target: number): Promise<void> }, task: Row, template?: Row) {
  if (!ctx.em.queryRunner?.isTransactionActive || ctx.em.queryRunner.data.legacyImport !== true) throw new Error('旧任务续办必须位于迁移事务');
  if (String(task.company_id) !== String(ctx.sourceCompanyId) || !['manual', 'routine'].includes(task.source_type) || task.workflow_instance_id != null || task.workflow_node_record_id != null || task.relation_type != null || task.submitted_at != null || !['pending', 'overdue'].includes(task.status)) throw new Error('旧任务状态或业务关联尚未兼容');
  const routine = task.source_type === 'routine';
  if ((!routine && task.template_id != null) || (routine && (!template || String(template.company_id) !== String(ctx.sourceCompanyId) || String(template.id) !== String(task.template_id) || ![0, 1].includes(Number(template.requires_review))))) throw new Error('旧任务模板关联或复核规则尚未兼容');
  if (task.feedback_to_id != null && String(task.feedback_to_id) !== String(task.supervisor_id)) throw new Error('旧任务另有反馈接收人，尚未兼容');
  let storeId: number | null = null;
  if (task.store_id != null) {
    storeId = ctx.lookup('stores', task.store_id) ?? null;
    if (!storeId || !await ctx.em.findOneBy(ResourceRecord, { id: storeId, companyId: ctx.companyId, type: 'stores' })) throw new Error('旧任务关联店铺未迁入本公司');
  }
  const schema = task.feedback_schema == null ? null : typeof task.feedback_schema === 'string' ? JSON.parse(task.feedback_schema) : task.feedback_schema;
  const hasSchema = Array.isArray(schema) && schema.length > 0;
  const feedbackPreset = hasSchema ? Object.entries(TASK_FEEDBACK_PRESETS).find(([, preset]) => isDeepStrictEqual(preset.fields, schema))?.[0] : 'simple';
  if (hasSchema && !feedbackPreset) throw new Error('旧任务自定义反馈表单尚未兼容');
  const mapped = async (v: unknown, optional = false): Promise<number | null> => {
    if (v == null && optional) return null;
    const id = ctx.lookup('user', v); if (!id || !await ctx.em.findOneBy(User, { id, companyId: ctx.companyId })) throw new Error('旧任务人员映射缺失'); return id;
  };
  if (routine && Number(template!.requires_review) === 1 && task.supervisor_id == null) throw new Error('旧任务需要复核但缺少监督人');
  const exists = ctx.lookup('work_item', task.id);
  if (exists) { await ctx.em.findOneByOrFail(WorkItem, { id: exists, companyId: ctx.companyId, kind: 'task' }); return { id: exists, reused: true }; }
  const work = await ctx.em.save(WorkItem, ctx.em.create(WorkItem, { companyId: ctx.companyId, kind: 'task', runId: null, stepId: null, assigneeId: (await mapped(task.assignee_id))!, createdBy: null, routineId: null, scheduleKey: null, storeId, title: task.title, description: null, status: 'open', supervisorId: await mapped(task.supervisor_id, true), requiresReview: routine && Number(template!.requires_review) === 1, feedbackPreset: feedbackPreset ?? null, completionStandard: task.completion_standard ?? null, submitPayload: null, isAbnormal: false, dueAt: wall(task.due_at), overdueNotifiedAt: null, createdAt: wall(task.created_at, true)!, finishedAt: null, doneNote: task.result_note ?? null, startedAt: null, submittedAt: null, reviewNote: task.review_comment ?? null }));
  await ctx.register('work_item', String(task.id), work.id);
  return { id: work.id, reused: false };
}
