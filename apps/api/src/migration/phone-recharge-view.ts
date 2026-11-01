import type { DataSource,EntityManager } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import type { ResourcesService } from '../resources/resources.service';
import type { LegacyRecord } from './protocol';
/** Verify the actual native details, not just the converted import object. */
export async function verifyPhoneRechargeView(ctx:{em:EntityManager;resources:ResourcesService;user:AuthUser;sourceCompanyId:number;parentId:number},record:LegacyRecord,raw:Record<string,unknown>){
  const fail=()=>Object.assign(Error('旧号码充值日期或周期页面核对失败'),{name:'LegacyDataError'});
  if(record.type!=='phones'||String(raw.id)!==record.id||String(raw.company_id)!==String(ctx.sourceCompanyId))throw fail();
  const keys=['last_recharge_at','next_recharge_at'];
  if(keys.every(k=>!Object.hasOwn(raw,k)))return false; // Earlier partial fixtures/catalogs do not prove these fields.
  if(keys.some(k=>!Object.hasOwn(raw,k))||!Object.hasOwn(raw,'recharge_cycle'))throw fail();
  const date=(value:unknown)=>{if(value==null||value==='')return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw fail();return value;};
  const cycleText=raw.recharge_cycle==null?'':String(raw.recharge_cycle).trim();
  const cycle=cycleText===''?null:/^\d+$/.test(cycleText)?Number(cycleText):({monthly:30,quarterly:90,yearly:365} as Record<string,number>)[cycleText];
  if(cycle!==null&&(typeof cycle!=='number'||!Number.isSafeInteger(cycle)||cycle<1||cycle>3650))throw fail();
  const bound=Object.create(ctx.em.connection) as DataSource;Object.defineProperty(bound,'manager',{value:ctx.em});
  const viewer=Object.create(ctx.resources) as ResourcesService;Object.defineProperty(viewer,'dataSource',{value:bound});
  const view=await viewer.get(ctx.user,'phones',ctx.parentId);
  if((view.data.lastRechargeAt??null)!==date(raw.last_recharge_at)||(view.data.nextRechargeAt??null)!==date(raw.next_recharge_at)||(view.data.rechargeCycleDays??null)!==cycle||(record.data.rechargeCycleDays??null)!==cycle)throw fail();
  return true;
}
