import { pendingWorkflowCoverage } from './workflow-coverage';
import type { LegacyWorkflowSource } from './protocol';
it('原文保存不能放行周期生成、超时处理或其他当前模板；只排除已实际验收的当前SKU',()=>{
  const source:LegacyWorkflowSource={companyId:3,currentSku:{templateId:'9',policyHash:'',policyCode:'',picks:[]},tables:{
    workflow_templates:[{id:9,status:'active',related_object_type:'bundle_application'},{id:10,status:'active',related_object_type:'purchase'},{id:11,status:'disabled',related_object_type:'bundle_application'}],
    task_templates:[{id:1}],workflow_timeout_incidents:[{id:2}],workflow_timeout_penalties:[],
  }};
  expect(pendingWorkflowCoverage(source,false).find(p=>p.id==='workflow_templates')?.reason).toContain('3条');
  const result=pendingWorkflowCoverage(source,true);
  expect(result.find(p=>p.id==='workflow_templates')?.reason).toContain('2条');
  expect(result.map(p=>p.id)).toEqual(['task_templates','workflow_timeout_incidents','workflow_templates']);
});
