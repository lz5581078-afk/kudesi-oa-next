import { ConflictException } from '@nestjs/common';
import { createChecker, type FieldDef } from '@kudesi/shared';
import type { EntityManager } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import type { FlowRun, FlowStep } from '../entities';
import type { ResourcesService } from '../resources/resources.service';
import { sourceRowHash } from '../migration/source-rows';
import { CLOSED_SKU_FIELDS, CLOSED_SKU_STEP_FIELDS, closedSkuForm, closedSkuPayload } from '../migration/closed-sku-forms';
import { legacyWallTime } from '../migration/legacy-time';

type Link={source_company_id:number;source_key:string;source_hash:string;target_id:number};
const statusFields:FieldDef[]=[{key:'legacyStatus',label:'原节点状态',type:'text',group:'迁入前记录',readonly:true},{key:'legacyAction',label:'原办理动作',type:'text',group:'迁入前记录',readonly:true}];
/** Called only after the normal flow-detail authorization. Original fields are
 * derived from immutable ledger identities, never a caller-supplied source ID.
 * No raw record, credential, or arbitrary JSON is returned. */
export async function legacySkuHistory(em:EntityManager,resources:ResourcesService,user:AuthUser,run:FlowRun,steps:FlowStep[]){
  if(run.templateKey!=='sku-batch-apply')return undefined;
  const links:Link[]=await em.query("SELECT source_company_id,source_key,source_hash,target_id FROM legacy_import_links WHERE company_id=? AND source_system='legacy-oa' AND target_type='flow_run' AND target_id=?",[user.companyId,run.id]);
  if(!links.length)return undefined;
  const fail=()=>new ConflictException('迁入前SKU记录完整性核对失败，请联系管理员');
  if(links.length!==1||!links[0].source_key.startsWith('flow_run:'))throw fail();
  const parent=links[0],sourceCompanyId=Number(parent.source_company_id),oldRunId=parent.source_key.slice('flow_run:'.length);
  const original=await resources.legacySourceRow(em,user,sourceCompanyId,'workflow_instances',oldRunId);
  if(!original||String(original.id)!==oldRunId||String(original.company_id)!==String(sourceCompanyId)||original.graph_status!=='batch'||sourceRowHash(original)!==parent.source_hash)throw fail();
  const owners:Link[]=await em.query("SELECT source_company_id,source_key,source_hash,target_id FROM legacy_import_links WHERE company_id=? AND source_system='legacy-oa' AND source_company_id=? AND source_key=? AND target_type='user' AND target_id=?",[user.companyId,sourceCompanyId,`user:${original.requester_id}`,run.requesterId]);
  if(owners.length!==1)throw fail();
  const can=createChecker(user.permissions);
  const visible=(fields:FieldDef[],values:Record<string,unknown>)=>{
    const allowed=fields.filter(f=>Object.prototype.hasOwnProperty.call(values,f.key)&&(!f.permission||can(f.permission)));
    return {fields:allowed,values:Object.fromEntries(allowed.map(f=>[f.key,values[f.key]]))};
  };
  let request:ReturnType<typeof visible>|undefined;
  let itemStatus:string|undefined;
  const oldItemId=run.payload._legacySkuItemId;
  if(oldItemId!=null){
    if(typeof oldItemId!=='string'||!/^\d+$/.test(oldItemId))throw fail();
    const item=await resources.legacySourceRow(em,user,sourceCompanyId,'workflow_batch_items',oldItemId);
    if(!item||String(item.id)!==oldItemId||String(item.company_id)!==String(sourceCompanyId)||String(item.workflow_instance_id)!==oldRunId)throw fail();
    request=visible(CLOSED_SKU_FIELDS,closedSkuPayload(item.payload_json));
    itemStatus=String(item.status);
  }
  const stepLinks:Link[]=steps.length?await em.query("SELECT source_company_id,source_key,source_hash,target_id FROM legacy_import_links WHERE company_id=? AND source_system='legacy-oa' AND source_company_id=? AND target_type='flow_step' AND target_id IN (?)",[user.companyId,sourceCompanyId,steps.map(s=>s.id)]):[];
  const snapshots=[];
  for(const step of steps){
    const matches=stepLinks.filter(l=>Number(l.target_id)===step.id);
    if(!matches.length)continue;
    if(matches.length!==1||!matches[0].source_key.startsWith('flow_step:'))throw fail();
    const link=matches[0],oldStepId=link.source_key.slice('flow_step:'.length);
    const row=await resources.legacySourceRow(em,user,sourceCompanyId,'workflow_node_records',oldStepId);
    if(!row||String(row.id)!==oldStepId||String(row.workflow_instance_id)!==oldRunId||sourceRowHash(row)!==link.source_hash)throw fail();
    const data=visible([...statusFields,...CLOSED_SKU_STEP_FIELDS],{legacyStatus:row.status,legacyAction:row.action??'',...closedSkuForm(row.form_payload)});
    snapshots.push({stepId:step.id,sourceRecordId:oldStepId,name:String(row.node_name),comment:typeof row.comment==='string'?row.comment:null,enteredAt:legacyWallTime(row.created_at,true),finishedAt:legacyWallTime(row.completed_at),...data});
  }
  return {sourceRunId:oldRunId,status:String(original.status),itemStatus,createdAt:legacyWallTime(original.created_at,true),request,steps:snapshots};
}
