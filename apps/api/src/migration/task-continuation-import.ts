import type { EntityManager } from 'typeorm';
import { WorkItem } from '../entities';
import { legacyWallTime as wall } from './legacy-time';
import { TASK_FEEDBACK_PRESETS } from '@kudesi/shared';
import { isDeepStrictEqual } from 'node:util';

type Row = Record<string, any>;
/** Existing manual tasks only. Recurrence and custom feedback templates require
 * separate compatibility checks; no routine is activated by this function. */
export async function importManualTask(ctx: { em: EntityManager; companyId: number; sourceCompanyId: number; lookup(type: string, id: unknown): number | undefined; register(type: string, id: string, target: number): Promise<void> }, task: Row) {
  if (!ctx.em.queryRunner?.isTransactionActive || ctx.em.queryRunner.data.legacyImport !== true) throw new Error('旧任务续办必须位于迁移事务');
  if (String(task.company_id) !== String(ctx.sourceCompanyId) || task.source_type !== 'manual' || task.workflow_instance_id != null || task.workflow_node_record_id != null || task.template_id != null || task.relation_type != null || task.submitted_at != null || !['pending', 'overdue'].includes(task.status)) throw new Error('旧任务状态或业务关联尚未兼容');
  const schema = task.feedback_schema == null ? null : typeof task.feedback_schema === 'string' ? JSON.parse(task.feedback_schema) : task.feedback_schema;
  const hasSchema = schema != null && Object.keys(schema).length > 0;
  const feedbackPreset = hasSchema ? Object.entries(TASK_FEEDBACK_PRESETS).find(([, preset]) => isDeepStrictEqual(preset.fields, schema))?.[0] : null;
  if (hasSchema && !feedbackPreset) throw new Error('旧任务自定义反馈表单尚未兼容');
  const mapped = (v: unknown, optional = false): number | null => {
    if (v == null && optional) return null;
    const id = ctx.lookup('user', v); if (!id) throw new Error('旧任务人员映射缺失'); return id;
  };
  const exists = ctx.lookup('work_item', task.id);
  if (exists) { await ctx.em.findOneByOrFail(WorkItem, { id: exists, companyId: ctx.companyId, kind: 'task' }); return { id: exists, reused: true }; }
  const work = await ctx.em.save(WorkItem, ctx.em.create(WorkItem, { companyId: ctx.companyId, kind: 'task', runId: null, stepId: null, assigneeId: mapped(task.assignee_id)!, createdBy: null, routineId: null, scheduleKey: null, title: task.title, description: null, status: 'open', supervisorId: mapped(task.supervisor_id, true), requiresReview: false, feedbackPreset: feedbackPreset ?? null, completionStandard: task.completion_standard ?? null, submitPayload: null, isAbnormal: false, dueAt: wall(task.due_at), overdueNotifiedAt: null, createdAt: wall(task.created_at, true)!, finishedAt: null, doneNote: task.result_note ?? null, startedAt: null, submittedAt: null, reviewNote: task.review_comment ?? null }));
  await ctx.register('work_item', String(task.id), work.id);
  return { id: work.id, reused: false };
}
