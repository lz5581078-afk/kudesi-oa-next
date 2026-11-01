export {};
const { planWorkflowContinuations: plan } = require('../../../../scripts/migration/workflow-plan.cjs');
const { readWorkflowSource } = require('../../../../scripts/migration/workflow-source.cjs');
const now = '2026-10-31T16:00:00Z';
const source = () => ({ companyId: 3, tables: {
  workflow_templates: [{ id: 9, company_id: 3, related_object_type: 'bundle_application', flow_mode: 'graph' }],
  workflow_instances: [{ id: 20, company_id: 3, template_id: 9, status: 'processing', current_node_id: 70, graph_status: 'batch', active_node_keys: ['sales'] }],
  workflow_batches: [{ id: 5, company_id: 3, template_snapshot: [{ id: 70, node_key: 'sales', node_type: 'submit' }] }],
  workflow_batch_items: [{ id: 6, company_id: 3, workflow_instance_id: 20, batch_id: 5, status: 'draft', payload_json: { lines: [] } }],
  workflow_node_records: [{ id: 7, workflow_instance_id: 20, template_node_id: 70, node_key: 'sales', status: 'pending', action: 'pending', is_active: 1, owner_id: 18 }],
  task_instances: [],
} as Record<string, Array<Record<string, any>>> });

describe('全量迁移的旧流程进度盘点', () => {
  it('保留空草稿和历史节点快照，不用今日模板替换、不伪造提交或待办', () => {
    const s = source();
    s.tables.workflow_template_nodes = [{ id: 70, template_id: 9, node_key: 'changed' }];
    const before = JSON.stringify(s), result = plan(s, now);
    expect(result.issues).toEqual([]);
    expect(result.counts).toMatchObject({ unfinishedRuns: 1, skuDrafts: 1, unfinishedTasks: 0 });
    expect(result.continuations[0]).toMatchObject({ currentNodeKeys: ['sales'], itemStatus: 'draft', currentRecordIds: ['7'] });
    expect(result.runtimeCompatibilityVerified).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });
  it('线性旧流程 is_active=0 时，按当前模板节点和 pending 状态定位，不复活已完成历史', () => {
    const s = source(); delete s.tables.workflow_batches; delete s.tables.workflow_batch_items;
    Object.assign(s.tables.workflow_templates[0], { flow_mode: 'linear' });
    Object.assign(s.tables.workflow_instances[0], { graph_status: 'linear', current_node_id: 72, active_node_keys: null });
    s.tables.workflow_template_nodes = [{ id: 71, template_id: 9, node_key: 'submit', node_type: 'submit' }, { id: 72, template_id: 9, node_key: 'check', node_type: 'approval' }];
    s.tables.workflow_node_records = [{ id: 1, workflow_instance_id: 20, template_node_id: 71, status: 'completed', action: 'submitted', is_active: 0 }, { id: 2, workflow_instance_id: 20, template_node_id: 72, status: 'pending', is_active: 0, owner_id: 5 }];
    expect(plan(s, now).continuations[0]).toMatchObject({ currentRecordIds: ['2'], currentNodeKeys: ['check'], historyCount: 2 });
    Object.assign(s.tables.workflow_instances[0], { status: 'submitted', current_node_id: 71 });
    expect(plan(s, now).continuations[0]).toMatchObject({ submittedBoundary: true, currentRecordIds: [], currentNodeKeys: ['submit'] });
  });
  it('退回待办保留原期限与办理人；拒绝跨流程节点引用和已结束流程的活待办', () => {
    const s = source(); s.tables.workflow_batch_items[0].status = 'returned';
    s.tables.task_instances = [{ id: 8, company_id: 3, source_type: 'workflow', status: 'overdue', assignee_id: 18, supervisor_id: 19, workflow_instance_id: 20, workflow_node_record_id: 7, due_at: '2026-10-01 11:00:00' }];
    const r = plan(s, now); expect(r.issues).toEqual([]);
    expect(r.tasks[0]).toMatchObject({ assigneeId: '18', supervisorId: '19', sourceStatus: 'overdue', dueAt: '2026-10-01 11:00:00' });
    s.tables.task_instances[0].workflow_node_record_id = 999;
    expect(plan(s, now).issues).toContainEqual({ table: 'task_instances', id: '8', code: 'mismatched_node_record' });
    s.tables.task_instances[0].workflow_node_record_id = 7;
    s.tables.workflow_instances[0].status = 'completed';
    expect(plan(s, now).issues).toContainEqual({ table: 'task_instances', id: '8', code: 'open_task_on_closed_run' });
  });
  it('跨公司、重复身份、未知状态、错误活跃节点不被静默转为可迁移', () => {
    const s = source(); s.tables.task_instances = [{ id: 1, company_id: 1 }];
    expect(() => plan(s, now)).toThrow('Cross-company');
    s.tables.task_instances = []; s.tables.workflow_instances.push({ ...s.tables.workflow_instances[0] });
    expect(() => plan(s, now)).toThrow('Duplicate'); s.tables.workflow_instances.pop();
    s.tables.workflow_instances[0].status = 'unknown';
    expect(plan(s, now).issues[0].code).toBe('unsupported_status');
    s.tables.workflow_instances[0].status = 'processing'; s.tables.workflow_instances[0].active_node_keys = ['wrong'];
    expect(plan(s, now).issues.some((x: {code:string}) => x.code === 'active_keys_mismatch')).toBe(true);
  });
  it('无公司列的模板节点/历史记录通过父对象限定公司；所有读取均参数化', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const c = { query: async (sql: string, args: unknown[]) => { calls.push([sql, args]); return [[]]; } };
    const columns = [{ t: 'workflow_templates', c: 'company_id' }, { t: 'workflow_template_nodes', c: 'template_id' }, { t: 'workflow_node_records', c: 'workflow_instance_id' }];
    await readWorkflowSource(c, columns, 3);
    expect(calls).toHaveLength(3);
    expect(calls.find(([q]) => q.includes('FROM workflow_node_records'))?.[0]).toContain('p.id=t.workflow_instance_id AND p.company_id=?');
    expect(calls.every(([, args]) => JSON.stringify(args) === '[3]')).toBe(true);
    await expect(readWorkflowSource(c, [{ t: 'task_instances', c: 'id' }], 3)).rejects.toThrow('Unverified');
  });
  it('早期 workflows/tasks 和新版表的相同编号不合并，兼容尚未验证就明确阻止切换', () => {
    const s = source();
    s.tables.workflows = [{ id: 20, company_id: 3, type: 'expense', status: 'approving', requester_id: 18, current_owner_id: 19 }];
    s.tables.tasks = [{ id: 7, company_id: 3, workflow_id: 20, status: 'pending', assignee_id: 19, supervisor_id: 18 }];
    const r = plan(s, now);
    expect(r.counts).toMatchObject({ unfinishedRuns: 1, earlyUnfinishedWorkflows: 1, earlyUnfinishedTasks: 1 });
    expect(r.earlyTasks[0]).toMatchObject({ sourceTable: 'tasks', sourceId: '7', workflowId: '20' });
    expect(r.issues).toContainEqual({ table: 'workflows', id: '20', code: 'early_model_runtime_not_verified' });
    s.tables.tasks[0].workflow_id = 21;
    expect(plan(s, now).issues).toContainEqual({ table: 'tasks', id: '7', code: 'missing_early_workflow' });
  });
});
