import type { EntityManager } from 'typeorm';
import { yuanToPreciseCents, type FieldDef, type StepDef } from '@kudesi/shared';
import { FlowDefinition, FlowRun, FlowStep, FlowTemplateRow, ResourceRecord, User, WorkItem } from '../entities';
import type { CryptoService } from '../common/crypto.service';
import type { LegacyWorkflowSource } from './protocol';
import { preserveSourceRow } from './source-rows';
import { legacyWallTime as wall } from './legacy-time';

type Row = Record<string, any>;
interface Context {
  em: EntityManager; crypto: CryptoService; companyId: number; sourceCompanyId: number; actorId: number;
  lookup(type: string, old: unknown): number | undefined;
  register(type: string, id: string, target: number): Promise<void>;
}
const key = 'legacy-linear';
const fields: FieldDef[] = [
  { key: 'legacyStatus', label: '迁入时状态', type: 'text', group: '原流程', readonly: true },
  { key: 'amountCents', label: '申请金额', type: 'money', group: '原流程', readonly: true },
  { key: 'storeId', label: '关联店铺', type: 'ref', ref: 'stores', group: '原流程', readonly: true },
  { key: 'licenseId', label: '营业执照', type: 'ref', ref: 'licenses', group: '原流程', readonly: true },
  { key: 'legacyResult', label: '办理结果', type: 'text', group: '原流程', readonly: true },
];
/** The source advance API follows node_order, even when the template was later
 * edited to graph mode. Archive nodes remain manual actions. */
export async function importLinearFlow(ctx: Context, source: LegacyWorkflowSource, row: Row) {
  if (!ctx.em.queryRunner?.isTransactionActive || ctx.em.queryRunner.data.legacyImport !== true || String(row.company_id) !== String(ctx.sourceCompanyId)) throw new Error('旧线性流程缺少公司范围和迁移事务');
  if (row.graph_status !== 'linear' || !['approving', 'processing', 'submitted', 'finance_confirming'].includes(row.status) || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200) throw new Error('旧线性流程状态或模型尚未兼容');
  if (!source.assignment) throw new Error('旧线性流程缺少源码选人证据');
  const existing = ctx.lookup('flow_run', row.id);
  if (existing) { await ctx.em.findOneByOrFail(FlowRun, { id: existing, companyId: ctx.companyId, templateKey: key }); return { runId: existing, reused: true }; }
  const person = async (old: unknown) => {
    const id = ctx.lookup('user', old);
    if (!id || !await ctx.em.findOneBy(User, { id, companyId: ctx.companyId })) throw new Error('旧线性流程人员未迁入本公司');
    return id;
  };
  const ref = async (type: string, old: unknown) => {
    if (old == null) return undefined;
    const id = ctx.lookup(type, old);
    if (!id || !await ctx.em.findOneBy(ResourceRecord, { id, companyId: ctx.companyId, type })) throw new Error('旧线性流程关联资料未迁入本公司');
    return id;
  };
  const nodes = (source.tables.workflow_template_nodes ?? []).filter(n => String(n.template_id) === String(row.template_id)).sort((a, b) => Number(a.node_order) - Number(b.node_order));
  if (!nodes.length || new Set(nodes.map(n => Number(n.node_order))).size !== nodes.length) throw new Error('旧线性流程节点顺序缺失或重复');
  const current = nodes.find(n => String(n.id) === String(row.current_node_id));
  if (!current) throw new Error('旧线性流程当前节点缺失');
  const records = (source.tables.workflow_node_records ?? []).filter(r => String(r.workflow_instance_id) === String(row.id)).sort((a, b) => Number(a.node_order) - Number(b.node_order));
  const pending = records.filter(r => String(r.template_node_id) === String(current.id) && r.status === 'pending');
  const boundary = row.status === 'submitted' && current.node_type === 'submit' && pending.length === 0 && records.some(r => String(r.template_node_id) === String(current.id) && r.status === 'completed');
  if (!boundary && (pending.length !== 1 || String(pending[0].owner_id) !== String(row.current_owner_id))) throw new Error('旧线性流程当前办理记录与负责人不一致');
  if (records.some(r => !['pending', 'completed'].includes(r.status) || !nodes.some(n => String(n.id) === String(r.template_node_id)))) throw new Error('旧线性流程历史状态或节点尚未兼容');
  const requesterId = await person(row.requester_id), ownerId = await person(row.current_owner_id);
  const stepKey = (n: Row) => `node_${n.id}`;
  const policies: Record<string, { createsTask: boolean; supervisorId: number }> = {};
  const steps: StepDef[] = [{ key: 'submit', name: '发起', type: 'submit', assignee: { source: 'requester' } }];
  for (const node of nodes) {
    if (node.node_type === 'submit') continue;
    if (!['approval', 'execute', 'finance', 'archive'].includes(node.node_type) || ![0, 1].includes(Number(node.creates_task))) throw new Error('旧线性流程节点类型或任务规则尚未兼容');
    const pick = source.assignment.picks.find(p => p.runId === String(row.id) && p.nodeId === String(node.id));
    if (!pick) throw new Error('旧线性流程缺少节点选人结果');
    const supervisorId = await person(pick.supervisor.employeeId);
    const dueMinutes = node.due_hours == null ? null : Number(node.due_hours); // Source DATE_ADD uses MINUTE.
    if (dueMinutes != null && (!Number.isInteger(dueMinutes) || dueMinutes < 1 || dueMinutes > 100800)) throw new Error('旧线性流程时限尚未兼容');
    policies[stepKey(node)] = { createsTask: Number(node.creates_task) === 1, supervisorId };
    steps.push({ key: stepKey(node), name: node.node_name, type: node.node_type === 'archive' ? 'execute' : node.node_type, assignee: { source: 'employee', id: await person(pick.owner.employeeId) }, dueMinutes });
  }
  // The old submit node is already recorded as completed, but advance has not
  // been clicked. Keep that boundary as an explicit continuation, without a todo.
  if (boundary) { steps.splice(1, 0, { key: 'continue', name: '继续流转', type: 'execute', assignee: { source: 'employee', id: ownerId } }); policies.continue = { createsTask: false, supervisorId: ownerId }; }
  steps.push({ key: 'end', name: '完成', type: 'end' });
  await preserveSourceRow(ctx.em, ctx.crypto, { companyId: ctx.companyId, sourceCompanyId: ctx.sourceCompanyId, table: 'legacy_assignment_policy', key: String(row.id) }, { policyHash: source.assignment.policyHash, functions: source.assignment.functions, picks: source.assignment.picks.filter(p => p.runId === String(row.id)) });
  if (!ctx.lookup('legacy_flow_template', 'linear')) {
    const template = await ctx.em.save(FlowTemplateRow, ctx.em.create(FlowTemplateRow, { companyId: ctx.companyId, templateKey: key, name: '旧线性流程续办', description: '按原节点顺序继续办理', departmentId: null, sourceKey: 'legacy-oa-linear', createdBy: ctx.actorId }));
    await ctx.register('legacy_flow_template', 'linear', template.id);
  }
  const [last] = await ctx.em.query('SELECT COALESCE(MAX(version),0) version FROM flow_definitions WHERE company_id=? AND template_key=?', [ctx.companyId, key]);
  const definition = await ctx.em.save(FlowDefinition, ctx.em.create(FlowDefinition, { companyId: ctx.companyId, templateKey: key, version: Number(last.version) + 1, status: 'retired', steps, schemaJson: { fields, stepFields: {}, posting: null }, escalateUserIds: [], starterScope: null, createdBy: ctx.actorId, publishedAt: null, publishedBy: null }));
  await ctx.register('legacy_flow_definition', `linear:${row.id}`, definition.id);
  const storeId = await ref('stores', row.store_id);
  const run = await ctx.em.save(FlowRun, ctx.em.create(FlowRun, { companyId: ctx.companyId, definitionId: definition.id, templateKey: key, title: row.title, status: 'running', requesterId, currentStepKey: boundary ? 'continue' : stepKey(current), payload: { legacyStatus: row.status, amountCents: yuanToPreciseCents(String(row.amount ?? 0), 0), storeId, licenseId: await ref('licenses', row.license_id), _legacySteps: policies }, stepsSnapshot: steps, escalateUserIds: [], revision: 1, dueAt: wall(row.due_at), requestKey: `legacy-oa:linear:${ctx.sourceCompanyId}:${row.id}`, createdAt: wall(row.created_at, true)!, finishedAt: null }));
  await ctx.register('flow_run', String(row.id), run.id);
  let seq = 0;
  for (const record of records) {
    const active = !boundary && record === pending[0];
    if (record.status === 'pending' && !active) throw new Error('旧线性流程还有其他未处理节点');
    const node = nodes.find(n => String(n.id) === String(record.template_node_id))!;
    const done = record.status === 'completed';
    // Old upsert can leave action=pending on completed rows. Never invent who
    // approved or when: owner is only the assigned person, not proof of action.
    const hasAction = done && !['pending', '', null].includes(record.action);
    const step = await ctx.em.save(FlowStep, ctx.em.create(FlowStep, { companyId: ctx.companyId, runId: run.id, seq: ++seq, stepKey: node.node_type === 'submit' ? 'submit' : stepKey(node), stepName: record.node_name, stepType: node.node_type === 'archive' ? 'execute' : node.node_type, status: done ? 'done' : 'active', enteredVia: 'normal', recipients: active ? [ownerId] : [await person(record.owner_id)], handledBy: null, action: null, comment: record.comment ?? (done && !hasAction ? '旧记录缺少可确认的办理动作，原记录已保留。' : null), form: null, enteredAt: wall(record.created_at, true)!, finishedAt: wall(record.completed_at), dueAt: active ? wall(row.due_at) : null }));
    await ctx.register('flow_step', String(record.id), step.id);
    if (active) {
      const todo = await ctx.em.save(WorkItem, ctx.em.create(WorkItem, { companyId: ctx.companyId, kind: 'flow', runId: run.id, stepId: step.id, assigneeId: ownerId, supervisorId: policies[stepKey(node)].supervisorId, title: `${record.node_name} · ${row.title}`.slice(0, 200), status: 'open', storeId: storeId ?? null, dueAt: wall(row.due_at), createdAt: wall(record.created_at, true)! }));
      await ctx.register('linear_flow_todo', String(row.id), todo.id);
    }
  }
  if (boundary) {
    const step = await ctx.em.save(FlowStep, ctx.em.create(FlowStep, { companyId: ctx.companyId, runId: run.id, seq: ++seq, stepKey: 'continue', stepName: '继续流转', stepType: 'execute', status: 'active', enteredVia: 'normal', recipients: [ownerId], dueAt: wall(row.due_at), enteredAt: wall(row.created_at, true)! }));
    await ctx.register('linear_boundary_step', String(row.id), step.id);
  }
  return { runId: run.id, reused: false };
}
