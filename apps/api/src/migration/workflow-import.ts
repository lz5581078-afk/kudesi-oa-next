import { importEarlyFlow } from './early-flow-import';
import { importLinearFlow } from './linear-flow-import';
import type { EntityManager } from 'typeorm';
import type { CryptoService } from '../common/crypto.service';
import { preserveSourceRow } from './source-rows';
import { importSkuContinuation } from './sku-continuation-import';
import type { LegacyArchive, LegacyWorkflowSource } from './protocol';
import { importStandaloneTask, importEarlyTask, importLinearTask } from './task-continuation-import';
import { restoreWorkflowAccess } from './workflow-access';
import { importClosedFlow } from './closed-flow-import';
import { importCurrentSkuTemplate } from './current-sku-template';
import type { ResourcesService } from '../resources/resources.service';
import { closedSkuForm, closedSkuPayload } from './closed-sku-forms';
import { verifyWorkflowView } from './workflow-view-verification';
import { importClosedTask } from './closed-task-import';

type Row = Record<string, any>;
export const WORKFLOW_TARGET_TABLE: Record<string, string> = { current_sku_definition:'flow_definitions', linear_flow_todo: 'work_items', linear_boundary_step: 'flow_steps', flow_run: 'flow_runs', flow_step: 'flow_steps', flow_definition: 'flow_definitions', work_item: 'work_items', early_work_item: 'work_items', early_flow_run: 'flow_runs', early_flow_step: 'flow_steps', early_flow_todo: 'work_items', legacy_flow_definition: 'flow_definitions', legacy_flow_template: 'flow_templates' };
export const workflowHashGroups = (source: LegacyWorkflowSource | undefined): Array<[string, Row[]]> => source ? [
  ['current_sku_definition',(source.tables.workflow_templates??[]).filter(t=>t.related_object_type==='bundle_application'&&t.status==='active')],
  ['linear_flow_todo', source.tables.workflow_instances ?? []], ['linear_boundary_step', source.tables.workflow_instances ?? []],
  ['legacy_flow_definition', (source.tables.workflow_instances ?? []).filter(r => r.graph_status === 'linear').map(r => ({ ...r, id: `linear:${r.id}` }))],
  ['legacy_flow_template', [{ id: 'linear', model: 'workflow_instances' }]],
  ['legacy_flow_definition', (source.tables.workflow_instances ?? []).filter(r=>CLOSED.has(r.status)).map(r=>({...r,id:`history:${r.id}`}))],
  ['legacy_flow_template', [{id:'history',model:'workflow_instances:closed'}]],
  ['flow_run', source.tables.workflow_instances ?? []], ['flow_step', source.tables.workflow_node_records ?? []], ['flow_definition', source.tables.workflow_batches ?? []], ['work_item', source.tables.task_instances ?? []], ['early_work_item', source.tables.tasks ?? []], ['early_flow_run', source.tables.workflows ?? []], ['early_flow_step', source.tables.workflows ?? []], ['early_flow_todo', source.tables.workflows ?? []], ['legacy_flow_definition', (source.tables.workflows ?? []).map(r => ({ ...r, id: `early:${r.id}` }))], ['legacy_flow_template', [{ id: 'early', model: 'workflows' }]],
] : [];
interface Context {
  em: EntityManager; resources:ResourcesService; crypto: CryptoService; companyId: number; actorId: number;
  lookup(type: string, id: unknown): number | undefined;
  register(type: string, sourceId: string, targetId: number): Promise<void>;
  count(which: 'created' | 'reused', type: string): void;
  verified(type:string):void;
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
      try{
        const result=await ctx.savepoint(()=>importClosedFlow({...ctx,sourceCompanyId:workflow.companyId,register:async(type,id,target)=>{await ctx.register(type,id,target);ctx.count('created',type);}},workflow,run));
        if(result.reused)ctx.count('reused','flow_run');
        ctx.note('workflow-history',String(run.id),run.graph_status==='batch'?'原状态、节点及SKU申请/核对快照已落地；原业务事件、完整历史任务与结果关联仍待验收，原文已加密保留':'原状态与节点只读时间线已落地；原采购申请/审批表单、结果附件及完整历史任务仍待验收，原文已加密保留');
      }catch(e){ctx.fail('flow_run',String(run.id),e instanceof Error&&e.message.startsWith('旧历史流程')?e.message:ctx.safeFailure(e));}
      continue;
    }
    if (run.graph_status === 'linear') {
      try {
        const result = await ctx.savepoint(() => importLinearFlow({ ...ctx, sourceCompanyId: workflow.companyId, register: async (type, id, target) => { await ctx.register(type, id, target); ctx.count('created', type); } }, workflow, run));
        if (result.reused) ctx.count('reused', 'flow_run');
      } catch (e) { ctx.fail('flow_run', String(run.id), e instanceof Error && e.message.startsWith('旧线性流程') ? e.message : ctx.safeFailure(e)); }
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
        closedSkuPayload(item.payload_json);
        for(const r of rows('workflow_node_records').filter(r=>String(r.workflow_instance_id)===String(run.id)))closedSkuForm(r.form_payload);
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
  for(const task of tasks)if(['completed','cancelled'].includes(task.status)){
    const run=rows('workflow_instances').find(r=>String(r.id)===String(task.workflow_instance_id));
    const node=rows('workflow_node_records').find(r=>String(r.id)===String(task.workflow_node_record_id));
    try{
      if(!run||!node)throw Error('旧历史任务缺少来源流程或节点');
      const result=await ctx.savepoint(()=>importClosedTask({...ctx,sourceCompanyId:workflow.companyId},task,run,node));
      ctx.count(result.reused?'reused':'created','historical-work-item');ctx.verified('historical-work-item');
    }catch(e){ctx.fail('work_item',String(task.id),e instanceof Error&&e.message.startsWith('旧历史任务')?e.message:ctx.safeFailure(e));}
  }
  for (const task of tasks) if (!CLOSED.has(task.status) && !mappedTasks.has(String(task.id))) {
    const linear = rows('workflow_instances').find(r => String(r.id) === String(task.workflow_instance_id) && r.graph_status === 'linear');
    if (linear) {
      try {
        const result = await ctx.savepoint(() => importLinearTask({ ...ctx, sourceCompanyId: workflow.companyId }, task, linear));
        ctx.count(result.reused ? 'reused' : 'created', 'work_item'); mappedTasks.add(String(task.id));
      } catch (e) { ctx.fail('work_item', String(task.id), e instanceof Error && e.message.startsWith('旧任务') ? e.message : ctx.safeFailure(e)); }
      continue;
    }
    if (['manual', 'routine'].includes(task.source_type)) {
      try {
        const result = await ctx.savepoint(() => importStandaloneTask({ em: ctx.em, companyId: ctx.companyId, sourceCompanyId: workflow.companyId, lookup: ctx.lookup, register: ctx.register }, task, rows('task_templates').find(t => String(t.id) === String(task.template_id))));
        ctx.count(result.reused ? 'reused' : 'created', 'work_item'); mappedTasks.add(String(task.id)); continue;
      } catch (e) { ctx.fail('work_item', String(task.id), e instanceof Error && e.message.startsWith('旧任务') ? e.message : ctx.safeFailure(e)); continue; }
    }
    ctx.fail('work_item', String(task.id), '原待办已加密保留，但续办或周期规则尚未验收');
  }
  for (const run of rows('workflows')) {
    try {
      const result = await ctx.savepoint(() => importEarlyFlow({ em: ctx.em, crypto: ctx.crypto, companyId: ctx.companyId, sourceCompanyId: workflow.companyId, actorId: ctx.actorId, lookup: ctx.lookup, register: async (type, id, target) => { await ctx.register(type, id, target); ctx.count('created', type); } }, run));
      if (result.reused) ctx.count('reused', 'early_flow_run');
    } catch (e) { ctx.fail('early_flow_run', String(run.id), e instanceof Error && e.message.startsWith('旧早期流程') ? e.message : ctx.safeFailure(e)); }
  }
  for (const task of rows('tasks')) if (!CLOSED.has(task.status)) {
    try {
      const result = await ctx.savepoint(() => importEarlyTask({ em: ctx.em, companyId: ctx.companyId, sourceCompanyId: workflow.companyId, lookup: ctx.lookup, register: ctx.register }, task, rows('workflows').find(w => String(w.id) === String(task.workflow_id))));
      ctx.count(result.reused ? 'reused' : 'created', 'early_work_item');
    } catch (e) { ctx.fail('early_work_item', String(task.id), e instanceof Error && e.message.startsWith('旧任务') ? e.message : ctx.safeFailure(e)); }
  }
  if (workflow.access) {
    try {
      const currentFinanceIds:number[]=[];
      if(workflow.currentSku){
        const finance=(workflow.tables.workflow_template_nodes??[]).filter(n=>String(n.template_id)===workflow.currentSku!.templateId&&n.node_type==='finance');
        for(const node of finance){
          const pick=workflow.currentSku.picks.find(p=>p.nodeId===String(node.id));
          if(!pick)throw Error('旧SKU当前财务缺少选人证据');
          for(const old of pick.employeeIds){const id=ctx.lookup('user',old);if(!id)throw Error('旧SKU当前财务人员未迁入');currentFinanceIds.push(id);}
        }
      }
      const result = await ctx.savepoint(() => restoreWorkflowAccess(ctx.em, { companyId: ctx.companyId, sourceCompanyId: workflow.companyId, actorId: ctx.actorId, source: workflow.access!, currentFinanceIds, lookup: ctx.lookup }));
      for (const _ of result.grants) ctx.count('created', 'workflow-access-grant');
      for (const denied of result.denied) ctx.fail('workflow_access', String(denied.userId), `保留明确禁止项：${denied.permission}；入口或办理资格需核对`);
    } catch (e) { ctx.fail('workflow_access', 'source', e instanceof Error && /^(旧|原)/.test(e.message) ? e.message : ctx.safeFailure(e)); }
  } else if (workflow.currentSku||rows('workflow_instances').some(r => !CLOSED.has(r.status))) ctx.fail('workflow_access', 'source', '缺少旧系统权限证据，未扩大授权');
  try{
    const result=await ctx.savepoint(()=>importCurrentSkuTemplate({...ctx,sourceCompanyId:workflow.companyId},workflow));
    if(result.created)ctx.count('created','current_sku_definition');
    if(result.reused)ctx.count('reused','current_sku_definition');
    if(result.sourceRowReused!==undefined)ctx.count(result.sourceRowReused?'reused':'created','legacy-source-row');
  }catch(e){ctx.fail('current_sku_definition',workflow.currentSku?.templateId??'current',e instanceof Error&&/^(旧SKU|SKU)/.test(e.message)?e.message:ctx.safeFailure(e));}
  for(const [type,sourceRuns] of [['flow_run',rows('workflow_instances')],['early_flow_run',rows('workflows')]] as const)for(const row of sourceRuns){
    const id=ctx.lookup(type,row.id);if(!id)continue;
    try{
      const result=await verifyWorkflowView(ctx.em,ctx.resources,ctx.companyId,id);ctx.verified('workflow-view');
      if(result.legacySkuHistory)ctx.verified('legacy-sku-history');
      if(result.costRestricted)ctx.verified('workflow-cost-restricted');
      if(result.syncRestricted)ctx.verified('workflow-sync-restricted');
      for(let i=0;i<result.historicalTasks;i++)ctx.verified('historical-task-view');
    }catch(e){ctx.fail('workflow_view',`${type}:${row.id}`,ctx.safeFailure(e));}
  }
}
