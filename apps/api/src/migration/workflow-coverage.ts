import type { LegacyWorkflowSource } from './protocol';
const PENDING:Record<string,string>={
  task_templates:'周期/手动模板的后续生成、原期限及选人规则',
  workflow_batch_item_deletions:'已删除规格及原删除记录的只读历史',
  workflow_business_commands:'原业务命令与结果关联（禁止回放原命令）',
  workflow_business_observers:'原业务关注人及查看范围',
  workflow_timeout_policies:'原超时策略与新站执行规则',
  workflow_timeout_policy_events:'原超时策略修改历史',
  workflow_timeout_incidents:'原超时事件、状态及提醒游标',
  workflow_timeout_escalations:'原升级提醒记录及防重复通知',
  workflow_timeout_penalties:'原处罚状态及金额（禁止重复扣款）',
  workflow_timeout_penalty_events:'原处罚变更历史',
};
/** Raw preservation is evidence, not acceptance of future execution or views. */
export function pendingWorkflowCoverage(source:LegacyWorkflowSource,currentSkuVerified:boolean){
  const pending=Object.entries(PENDING).map(([table,reason])=>({table,reason,rows:source.tables[table]??[]}));
  const templates=(source.tables.workflow_templates??[]).filter(t=>!(currentSkuVerified&&source.currentSku?.templateId===String(t.id)&&t.status==='active'&&t.related_object_type==='bundle_application'));
  pending.push({table:'workflow_templates',reason:'除已核对当前SKU外的模板配置、启停状态及后续发起',rows:templates});
  return pending.filter(p=>p.rows.length).map(p=>({type:'workflow-table.pending',id:p.table,reason:`本公司${p.rows.length}条：${p.reason}尚未验收；原文加密保留不代表已可用`}));
}
