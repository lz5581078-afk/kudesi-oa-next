import {In,MoreThan,type EntityManager} from 'typeorm';
import {FlowEvent,FlowRun,FlowStep} from '../entities';
export function supportsSkuWarehouseDraft(run: FlowRun): boolean {
 return run.payload._applicationDraftOrigin === true || typeof run.payload._legacySkuItemId === 'string';
}

/** Current source input is distinct from the unchanged submitted-step history. */
export async function initialSkuWarehouseDraft(em:EntityManager,run:FlowRun):Promise<Record<string,unknown>>{
 const imported = run.payload._legacyWarehouseDraft as Record<string,unknown> | undefined;
 if (!Array.isArray(run.payload._warehouse)) return imported && Array.isArray(imported.config) ? imported : {};
 const last=await em.findOne(FlowStep,{where:{companyId:run.companyId,runId:run.id,stepKey:'warehouse',action:'pass'},order:{seq:'DESC',id:'DESC'}});
 let reuseInfo=last?.form?.reuseInfo;
 if(reuseInfo&&last){const passed=await em.findOne(FlowEvent,{where:{companyId:run.companyId,runId:run.id,stepId:last.id,action:'pass'},order:{id:'DESC'}}),submitSteps=await em.find(FlowStep,{where:{companyId:run.companyId,runId:run.id,stepType:'submit'},select:['id']});if(!passed||submitSteps.length&&await em.count(FlowEvent,{where:{companyId:run.companyId,runId:run.id,action:'draft_save',stepId:In(submitSteps.map(step=>step.id)),id:MoreThan(passed.id)}}))reuseInfo=undefined;}
 return {config:run.payload._warehouse,...(typeof last?.form?.note==='string'?{note:last.form.note}:{}),...(reuseInfo?{reuseInfo}:{})};
}
