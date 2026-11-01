import type { EntityManager } from 'typeorm';
import { yuanToPreciseCents, type FieldDef, type StepDef } from '@kudesi/shared';
import { FlowDefinition, FlowRun, FlowStep, FlowTemplateRow, User, WorkItem } from '../entities';
import type { CryptoService } from '../common/crypto.service';
import { preserveSourceRow } from './source-rows';
import { legacyWallTime as wall } from './legacy-time';

type Row = Record<string, any>;
interface Context {
  em: EntityManager; crypto: CryptoService; companyId: number; sourceCompanyId: number; actorId: number;
  lookup(type: string, old: unknown): number | undefined;
  register(type: string, id: string, target: number): Promise<void>;
}
const key = 'legacy-early';
const fields: FieldDef[] = [
  { key: 'legacyType', label: '原流程类型', type: 'text', group: '原流程', readonly: true },
  { key: 'legacyStatus', label: '迁入时状态', type: 'select', group: '原流程', readonly: true, options: [{ value: 'approving', label: '审批中' }, { value: 'executing', label: '执行中' }, { value: 'overdue', label: '逾期' }, { value: 'approved', label: '已审批' }, { value: 'completed', label: '已完成' }, { value: 'cancelled', label: '已取消' }] },
  { key: 'amountCents', label: '申请金额', type: 'money', group: '原流程', readonly: true },
  { key: 'storeId', label: '关联店铺', type: 'ref', ref: 'stores', group: '原流程', readonly: true },
  { key: 'licenseId', label: '营业执照', type: 'ref', ref: 'licenses', group: '原流程', readonly: true },
  { key: 'originalDueAt', label: '原截止时间', type: 'text', group: '原流程', readonly: true },
  { key: 'legacyResult', label: '原流程办理结果', type: 'select', group: '原流程', readonly: true, options: [{ value: 'approved', label: '已审批' }, { value: 'completed', label: '已完成' }] },
];
/** The early model has one approval action and no node-history table. Preserve
 * that action, rather than inventing a multi-step template or past approvers. */
export async function importEarlyFlow(ctx: Context, row: Row) {
  if (!ctx.em.queryRunner?.isTransactionActive || ctx.em.queryRunner.data.legacyImport !== true || String(row.company_id) !== String(ctx.sourceCompanyId)) throw new Error('旧早期流程缺少公司范围和迁移事务');
  if (row.id == null || !String(row.title ?? '').trim()) throw new Error('旧早期流程缺少原始编号或标题');
  if (!['approving', 'executing', 'overdue', 'approved', 'completed', 'cancelled'].includes(row.status) || typeof row.title !== 'string' || row.title.length > 200) throw new Error('旧早期流程状态或标题尚未兼容');
  await preserveSourceRow(ctx.em, ctx.crypto, { companyId: ctx.companyId, sourceCompanyId: ctx.sourceCompanyId, table: 'workflows', key: String(row.id) }, row);
  const exists = ctx.lookup('early_flow_run', row.id);
  if (exists) { await ctx.em.findOneByOrFail(FlowRun, { id: exists, companyId: ctx.companyId, templateKey: key }); return { runId: exists, reused: true }; }
  const person = async (old: unknown) => {
    const id = ctx.lookup('user', old);
    if (!id || !await ctx.em.findOneBy(User, { id, companyId: ctx.companyId })) throw new Error('旧早期流程人员未迁入本公司');
    return id;
  };
  const ref = (type: string, old: unknown) => {
    if (old == null) return undefined;
    const id = ctx.lookup(type, old); if (!id) throw new Error('旧早期流程关联资料未迁入'); return id;
  };
  const closed = ['approved', 'completed', 'cancelled'].includes(row.status);
  const requesterId = await person(row.requester_id), ownerId = closed && row.current_owner_id == null ? null : await person(row.current_owner_id);
  const type = row.status === 'approving' ? 'approval' : 'execute';
  const steps: StepDef[] = [
    { key: 'submit', name: '发起', type: 'submit', assignee: { source: 'requester' }, locked: true },
    { key: 'handle', name: '原流程办理', type, ...(ownerId ? { assignee: { source: 'employee' as const, id: ownerId } } : {}), locked: true },
    { key: 'end', name: '完成', type: 'end', locked: true },
  ];
  let templateId = ctx.lookup('legacy_flow_template', 'early');
  if (!templateId) {
    const template = await ctx.em.save(FlowTemplateRow, ctx.em.create(FlowTemplateRow, { companyId: ctx.companyId, templateKey: key, name: '旧流程续办', description: '保留迁入前的业务、负责人和进度', departmentId: null, sourceKey: 'legacy-oa-early', createdBy: ctx.actorId }));
    templateId = template.id; await ctx.register('legacy_flow_template', 'early', template.id);
  }
  const [last] = await ctx.em.query('SELECT COALESCE(MAX(version),0) version FROM flow_definitions WHERE company_id=? AND template_key=?', [ctx.companyId, key]);
  const definition = await ctx.em.save(FlowDefinition, ctx.em.create(FlowDefinition, { companyId: ctx.companyId, templateKey: key, version: Number(last.version) + 1, status: 'retired', steps, schemaJson: { fields, stepFields: {}, posting: null }, escalateUserIds: [], starterScope: null, createdBy: ctx.actorId, publishedAt: null, publishedBy: null }));
  await ctx.register('legacy_flow_definition', `early:${row.id}`, definition.id);
  const payload = { legacyType: row.type, legacyStatus: row.status, ...(row.amount != null ? { amountCents: yuanToPreciseCents(String(row.amount), 0) } : {}), storeId: ref('stores', row.store_id), licenseId: ref('licenses', row.license_id), originalDueAt: row.due_at, ...(closed && row.status !== 'cancelled' ? { legacyResult: row.status } : {}) };
  const status = closed ? row.status === 'cancelled' ? 'cancelled' : 'completed' : 'running';
  const run = await ctx.em.save(FlowRun, ctx.em.create(FlowRun, { companyId: ctx.companyId, definitionId: definition.id, templateKey: key, title: row.title, status, requesterId, currentStepKey: closed ? null : 'handle', payload, stepsSnapshot: steps, escalateUserIds: [], revision: 1, dueAt: closed ? null : wall(row.due_at), requestKey: `legacy-oa:early:${ctx.sourceCompanyId}:${row.id}`, createdAt: wall(row.created_at, true)!, finishedAt: null }));
  await ctx.register('early_flow_run', String(row.id), run.id);
  const step = await ctx.em.save(FlowStep, ctx.em.create(FlowStep, { companyId: ctx.companyId, runId: run.id, seq: 1, stepKey: 'handle', stepName: closed ? '旧站已结束' : '原流程办理', stepType: type, status: closed ? row.status === 'cancelled' ? 'cancelled' : 'done' : 'active', enteredVia: 'normal', recipients: closed ? [] : [ownerId!], handledBy: null, action: closed && row.status === 'approved' ? 'pass' : null, comment: closed ? '旧站未记录审批时间或操作人，按原状态保留。' : null, form: null, enteredAt: wall(row.created_at, true)!, finishedAt: null, dueAt: closed ? null : wall(row.due_at) }));
  await ctx.register('early_flow_step', String(row.id), step.id);
  if (!closed) {
    // A pending owned workflow is a real action, separate from old independent
    // tasks. This projects its booking entry without fabricating an approval.
    const todo = await ctx.em.save(WorkItem, ctx.em.create(WorkItem, { companyId: ctx.companyId, kind: 'flow', runId: run.id, stepId: step.id, assigneeId: ownerId!, title: row.title, status: 'open', dueAt: wall(row.due_at), createdAt: wall(row.created_at, true)!, storeId: ref('stores', row.store_id) ?? null }));
    await ctx.register('early_flow_todo', String(row.id), todo.id);
  }
  return { runId: run.id, reused: false };
}
