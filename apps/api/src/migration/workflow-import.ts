import type { EntityManager } from 'typeorm';
import type { CryptoService } from '../common/crypto.service';
import { preserveSourceRow } from './source-rows';
import { importSkuContinuation } from './sku-continuation-import';
import type { LegacyArchive, LegacyWorkflowSource } from './protocol';
import { importStandaloneTask } from './task-continuation-import';
import { restoreWorkflowAccess } from './workflow-access';

type Row = Record<string, any>;
export const WORKFLOW_TARGET_TABLE: Record<string, string> = { flow_run: 'flow_runs', flow_step: 'flow_steps', flow_definition: 'flow_definitions', work_item: 'work_items' };
export const workflowHashGroups = (source: LegacyWorkflowSource | undefined): Array<[string, Row[]]> => source ? [
  ['flow_run', source.tables.workflow_instances ?? []], ['flow_step', source.tables.workflow_node_records ?? []], ['flow_definition', source.tables.workflow_batches ?? []], ['work_item', source.tables.task_instances ?? []],
] : [];
interface Context {
  em: EntityManager; crypto: CryptoService; companyId: number; actorId: number;
  lookup(type: string, id: unknown): number | undefined;
  register(type: string, sourceId: string, targetId: number): Promise<void>;
  count(which: 'created' | 'reused', type: string): void;
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
  fail(type: string, id: string, reason: string): void;
  note(type: string, id: string, reason: string): void;
  safeFailure(e: unknown): string;
}
const CLOSED = new Set(['completed', 'cancelled', 'rejected', 'skipped']);
const KEYS: Record<string, string[]> = { workflow_business_observers: ['company_id', 'run_id', 'employee_id'], workflow_timeout_policies: ['company_id', 'template_id', 'node_key'] };

/** Preserve all supplied workflow rows before projecting supported continuations.
 * Unsupported in-flight models are failures, never silently archived as done. */
export async function importWorkflows(ctx: Context, archive: LegacyArchive, workflow: LegacyWorkflowSource) {
  if (workflow.companyId !== archive.company.id) throw new Error('流程来源公司不一致');
  for (const [table, rows] of Object.entries(workflow.tables)) for (const row of rows) {
    let key: string;
    if (row.id != null) key = String(row.id);
    else {
      const fields = KEYS[table];
      if (!fields || fields.some(field => row[field] == null)) throw new Error('流程来源存在未定义的复合身份');
      key = JSON.stringify(fields.map(field => row[field]));
    }
    const stored = await preserveSourceRow(ctx.em, ctx.crypto, { companyId: ctx.companyId, sourceCompanyId: workflow.companyId, table, key }, row);
    ctx.count(stored.reused ? 'reused' : 'created', 'legacy-source-row');
  }
  const rows = (name: string) => workflow.tables[name] ?? [];
  const tasks = rows('task_instances');
  const mappedTasks = new Set<string>();
  for (const run of rows('workflow_instances')) {
    if (CLOSED.has(run.status)) {
      ctx.note('workflow-history', String(run.id), '原始历史已加密保留，旧流程只读时间线尚需验收');
      continue;
    }
    if (run.graph_status !== 'batch') { ctx.fail('flow_run', String(run.id), '旧线性或业务流程续办尚未验收，禁止按新申请重建'); continue; }
    const items = rows('workflow_batch_items').filter(i => String(i.workflow_instance_id) === String(run.id));
    const item = items.length === 1 ? items[0] : null;
    const batch = item && rows('workflow_batches').find(b => String(b.id) === String(item.batch_id));
    if (!item || !batch) { ctx.fail('flow_run', String(run.id), '旧SKU缺少唯一申请单或规格'); continue; }
    try {
      await ctx.savepoint(async () => {
        const existed = ctx.lookup('flow_run', run.id);
        await importSkuContinuation({ em: ctx.em, crypto: ctx.crypto, companyId: ctx.companyId, lookup: ctx.lookup, register: async (type, id, target) => { await ctx.register(type, id, target); ctx.count('created', type); } }, {
          sourceCompanyId: workflow.companyId, run, item, batch, records: rows('workflow_node_records'), recipients: rows('workflow_node_recipients'), lookup: ctx.lookup,
          scenario: code => {
            const matches = archive.records.filter(r => r.type === 'finance-scenarios' && r.data.code === code);
            return matches.length === 1 ? ctx.lookup('finance-scenarios', matches[0].id) : undefined;
          },
          brand: dictionaryId => {
            const d = workflow.catalog?.dictionaries.find(r => String(r.id) === String(dictionaryId) && r.dictionary_type === 'brand');
            return d ? ctx.lookup('finance-brands', `brand:${String(d.item_name).trim()}`) : undefined;
          },
        }, tasks);
        if (existed) ctx.count('reused', 'flow_run');
      });
      for (const t of tasks.filter(t => String(t.workflow_instance_id) === String(run.id))) mappedTasks.add(String(t.id));
    } catch (e) {
      const reason = e instanceof Error && /^(SKU|旧|此SKU)/.test(e.message) ? e.message : ctx.safeFailure(e);
      ctx.fail('flow_run', String(run.id), reason);
    }
  }
  for (const task of tasks) if (!CLOSED.has(task.status) && !mappedTasks.has(String(task.id))) {
    if (['manual', 'routine'].includes(task.source_type)) {
      try {
        const result = await ctx.savepoint(() => importStandaloneTask({ em: ctx.em, companyId: ctx.companyId, sourceCompanyId: workflow.companyId, lookup: ctx.lookup, register: ctx.register }, task, rows('task_templates').find(t => String(t.id) === String(task.template_id))));
        ctx.count(result.reused ? 'reused' : 'created', 'work_item'); mappedTasks.add(String(task.id)); continue;
      } catch (e) { ctx.fail('work_item', String(task.id), e instanceof Error && e.message.startsWith('旧任务') ? e.message : ctx.safeFailure(e)); continue; }
    }
    ctx.fail('work_item', String(task.id), '原待办已加密保留，但续办或周期规则尚未验收');
  }
  for (const run of rows('workflows')) if (!CLOSED.has(run.status)) ctx.fail('early_flow_run', String(run.id), '早期流程独立保留，尚未验收续办，不与新版同号流程合并');
  for (const task of rows('tasks')) if (!CLOSED.has(task.status)) ctx.fail('early_work_item', String(task.id), '早期待办独立保留，尚未验收续办，不与新版同号待办合并');
  if (workflow.access) {
    try {
      const result = await ctx.savepoint(() => restoreWorkflowAccess(ctx.em, { companyId: ctx.companyId, sourceCompanyId: workflow.companyId, actorId: ctx.actorId, source: workflow.access!, lookup: ctx.lookup }));
      for (const _ of result.grants) ctx.count('created', 'workflow-access-grant');
      for (const denied of result.denied) ctx.fail('workflow_access', String(denied.userId), `保留明确禁止项：${denied.permission}；入口或办理资格需核对`);
    } catch (e) { ctx.fail('workflow_access', 'source', e instanceof Error && /^(旧|原)/.test(e.message) ? e.message : ctx.safeFailure(e)); }
  } else if (rows('workflow_instances').some(r => !CLOSED.has(r.status))) ctx.fail('workflow_access', 'source', '缺少旧系统权限证据，未扩大授权');
}
