import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { Company, ResourceChangeLog, ResourceRecord, User } from '../entities';
import { ResourcesService } from '../resources/resources.service';
import { planCategoryFix } from '../resources/category-structure-fix';
import { registerCostSnapshots } from '../resources/cost-snapshot';
import { LegacyArchive, LegacyRef } from './protocol';
import { MigrationError, safeFailure } from './runner';

export const SKU_SOURCE_TYPES=['finance-products','finance-product-boms','finance-base-codes','finance-base-code-lines','finance-bundles','finance-bundle-lines','finance-bundle-naming-rules','finance-brands','finance-categories','finance-platforms','finance-scenarios','finance-product-units','finance-product-costs','finance-product-sources'];
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([k])=>k!=='locator').sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])) : value;
export const skuRepairHash = (value: unknown) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
interface RepairPatch { sourceKey: string; type: string; id: number; before: string; values: Record<string, unknown> }
export interface SkuRepairPlan { companyId: number; sourceCompanyId: number; sourceHash: string; targetHash: string; oemCategoryIds: number[]; relinks: Array<{sourceKey:string;type:string;id:number;sourceHash:string}>; patches: RepairPatch[]; additions: Array<{ type: string; id: string }>; conflicts: Array<{ sourceKey: string; field: string; reason: string }> }

/** Existing records only: allowlisted field corrections; manual edits remain explicit conflicts. */
export async function planSkuRepair(em: EntityManager, companyId: number, source: LegacyArchive): Promise<SkuRepairPlan> {
  const links: Array<{source_key:string;target_id:number}> = await em.query('SELECT source_key,target_id FROM legacy_import_links WHERE source_system=? AND source_company_id=? AND company_id=?', ['legacy-oa',source.company.id,companyId]);
  const ids = new Map(links.map(l=>[l.source_key,Number(l.target_id)]));
  const rows = await em.find(ResourceRecord, { where: { companyId }, order: { id:'ASC' } });
  const byId = new Map(rows.map(r=>[r.id,r]));
  const logs = await em.find(ResourceChangeLog, { where: { companyId, action:'update' } });
  const categories = await planCategoryFix(em, companyId);
  const plan: SkuRepairPlan = { companyId, sourceCompanyId:source.company.id, sourceHash:skuRepairHash(source.records), targetHash:skuRepairHash(rows.map(r=>[r.id,r.type,r.status,r.data])),oemCategoryIds:categories.oem.filter(m=>m.decision==='move').flatMap(m=>m.ids),relinks:[],patches:[],additions:[],conflicts:[] };
  const fields = ['weightG','weightManual','weightUnit','purchaseSpec','giftShortName','giftCodeShortName'] as const;
  const manuallyEdited = (r:ResourceRecord,field:string) => logs.some(l=>l.resourceId===r.id && l.resourceType===r.type && !l.note?.startsWith('旧系统') && l.note!=='构成变化，自动汇总成本和重量' && skuRepairHash(l.beforeJson?.[field]??null)!==skuRepairHash(l.afterJson?.[field]??null));
  for(const sourceRow of source.records){
    if(!['finance-products','finance-bundles','finance-base-codes','finance-bundle-lines','finance-product-boms','finance-bundle-naming-rules','finance-brands','finance-categories','finance-product-units'].includes(sourceRow.type))continue;
    const sourceKey=`${sourceRow.type}:${sourceRow.id}`;
    let id=ids.get(sourceKey),r=id?byId.get(id):undefined;
    const refId=(field:string)=>{const ref=(sourceRow.data[field] as LegacyRef|undefined)?.legacyRef;return ref?ids.get(`${ref.type}:${ref.id}`):undefined;};
    if(!r&&sourceRow.type==='finance-categories'&&sourceRow.data.archiveType==='oem_package'){
      const oldKey=`finance-categories:${sourceRow.id.replace(/:oem_package$/,':package')}`,oldId=ids.get(oldKey),old=oldId?byId.get(oldId):undefined;
      if(old?.type===sourceRow.type&&old.data.code===sourceRow.data.code)r=old;
    }
    if(!r&&sourceRow.type==='finance-product-boms'&&refId('productId')){
      const candidates=rows.filter(x=>x.type===sourceRow.type&&x.data.productId===refId('productId')&&(x.data.componentId??null)===(refId('componentId')??null)&&(x.data.laborId??null)===(refId('laborId')??null));
      if(candidates.length===1)r=candidates[0];
      else if(candidates.length>1){plan.conflicts.push({sourceKey,field:'构成',reason:'相同来源构成有多条候选，禁止重复增加'});continue;}
    }
    if(r&&!id){id=r.id;ids.set(sourceKey,id);plan.relinks.push({sourceKey,type:r.type,id,sourceHash:skuRepairHash(sourceRow)});}
    if(!r){plan.additions.push({type:sourceRow.type,id:sourceRow.id});continue;}
    const values:Record<string,unknown>={};
    const propose=(field:string,value:unknown)=>{
      if(field==='weightManual'&&!value&&!r!.data.weightManual)return;
      if(skuRepairHash(r.data[field]??null)===skuRepairHash(value??null))return;
      if(manuallyEdited(r,field)){plan.conflicts.push({sourceKey,field,reason:'新站人工修改过，保留当前值'});return;}
      values[field]=value??null;
    };
    if(r.type==='finance-products'){
      for(const field of fields)if(sourceRow.data[field]!==undefined){
        if(['purchaseSpec','giftShortName','giftCodeShortName'].includes(field)&&r.data[field])continue;
        if(field==='weightG'&&r.data.weightManual===true&&sourceRow.data.weightManual!==true){if(r.data[field]!==sourceRow.data[field])plan.conflicts.push({sourceKey,field,reason:'新站已设人工修正重量，保留并待核对'});continue;}
        propose(field,sourceRow.data[field]);
      }
      if(sourceRow.data.rawFinishedNames){const names=[...new Set(`${r.data.rawFinishedNames??''}\n${sourceRow.data.rawFinishedNames}`.split(/\r?\n/).map(s=>s.trim()).filter(Boolean))];propose('rawFinishedNames',names.join('\n'));}
      if(sourceRow.data.supplyMode==='supplier_oem'&&sourceRow.notices?.some(n=>n.includes('不作为额外采购价重复加入')))propose('purchasePrice',null);
    }
    if(r.type==='finance-bundles'&&!r.data.brandId){const ref=(sourceRow.data.brandId as LegacyRef|undefined)?.legacyRef;if(ref){const brand=ids.get(`${ref.type}:${ref.id}`);if(brand)propose('brandId',brand);}}
    if(r.type==='finance-bundles'&&/^V\d{1,3}$/i.test(String(r.data.configNo))&&String(r.data.configNo).replace(/^V/i,'').padStart(2,'0')===sourceRow.data.configNo)propose('configNo',sourceRow.data.configNo);
    if(r.type==='finance-product-boms')for(const field of ['qty','lossPercent'])if(sourceRow.data[field]!==undefined)propose(field,sourceRow.data[field]);
    if(Object.keys(values).length)plan.patches.push({sourceKey,type:r.type,id:r.id,before:skuRepairHash([r.status,r.data]),values});
  }
  return plan;
}

/** Dry-run executes the same hooks and rolls the whole transaction back. No workflow or outbox is started. */
export async function runSkuRepair(ds:DataSource,resources:ResourcesService,source:LegacyArchive,opts:{companyId:number;actorId:number;expectedName:string;apply:boolean;expectedPlan?:SkuRepairPlan;preparePlan?:(plan:SkuRepairPlan)=>void}):Promise<SkuRepairPlan>{
  const q=ds.createQueryRunner();await q.connect();await q.startTransaction();q.data.legacyImport=true;
  try{
    const company=await q.manager.findOneByOrFail(Company,{id:opts.companyId});
    if(company.name!==opts.expectedName||source.company.name!==opts.expectedName)throw new MigrationError('修复公司名称不一致');
    const actor=await q.manager.findOneByOrFail(User,{id:opts.actorId,companyId:opts.companyId,isCompanyAdmin:true,status:'active'});
    // Serialize maintenance for this company; the expected plan still guards changes since dry-run.
    await q.manager.findOne(Company,{where:{id:company.id},lock:{mode:'pessimistic_write'}});
    await q.manager.createQueryBuilder(ResourceRecord,'r').where('r.companyId = :companyId',{companyId:company.id}).setLock('pessimistic_write').getMany();
    const plan=await planSkuRepair(q.manager,company.id,source);
    if(opts.apply&&(!opts.expectedPlan||skuRepairHash(plan)!==skuRepairHash(opts.expectedPlan)))throw new MigrationError('修复计划与空跑不一致，禁止写入，请重新空跑');
    const user:AuthUser={id:actor.id,companyId:company.id,name:actor.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    for(const p of plan.patches){
      const current=await q.manager.findOneOrFail(ResourceRecord,{where:{id:p.id,companyId:company.id,type:p.type},lock:{mode:'pessimistic_write'}});
      if(skuRepairHash([current.status,current.data])!==p.before)throw new MigrationError('修复对象已变化，禁止覆盖');
    }
    for(const id of plan.oemCategoryIds)await resources.patchData(q.manager,user,'finance-categories',id,{archiveType:'oem_package'},'旧系统SKU分类归属修正');
    for(const link of plan.relinks)await q.manager.query('INSERT INTO legacy_import_links(source_system,source_company_id,company_id,source_key,target_type,target_id,source_hash) VALUES(?,?,?,?,?,?,?)',['legacy-oa',source.company.id,company.id,link.sourceKey,link.type,link.id,link.sourceHash]);
    for(const p of plan.patches)await resources.importPatch(q.manager,user,p.type,p.id,p.values);
    opts.preparePlan?.(plan);
    if(opts.apply)await q.commitTransaction();else await q.rollbackTransaction();
    return plan;
  }catch(e){if(q.isTransactionActive)await q.rollbackTransaction();throw e;}finally{await q.release();}
}

export interface SkuVerification { sourceHash:string;targetHash:string;checked:Array<{type:string;id:number}>;issues:Array<{type:string;id:number;reason:string}>;history?:{recorded:number;unchanged:number;missing:number} }
/** Re-verify through the ordinary rules after fields and missing records have been reconciled. */
export async function runSkuVerification(ds:DataSource,resources:ResourcesService,source:LegacyArchive,opts:{companyId:number;actorId:number;expectedName:string;apply:boolean;expected?:SkuVerification;prepare?:(report:SkuVerification)=>void}):Promise<SkuVerification>{
  const q=ds.createQueryRunner();await q.connect();await q.startTransaction();q.data.legacyImport=true;
  try{
    const c=await q.manager.findOneByOrFail(Company,{id:opts.companyId});if(c.name!==opts.expectedName||source.company.name!==c.name)throw new MigrationError('验证公司不一致');
    const actor=await q.manager.findOneByOrFail(User,{id:opts.actorId,companyId:c.id,isCompanyAdmin:true,status:'active'}),user:AuthUser={id:actor.id,companyId:c.id,name:actor.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    await q.manager.createQueryBuilder(ResourceRecord,'r').where('r.companyId = :companyId',{companyId:c.id}).setLock('pessimistic_write').getMany();
    const keys=new Set(source.records.filter(r=>['finance-base-codes','finance-bundles'].includes(r.type)&&!r.archive).map(r=>`${r.type}:${r.id}`));
    const links:Array<{source_key:string;target_id:number;target_type:string}>=await q.manager.query('SELECT source_key,target_id,target_type FROM legacy_import_links WHERE company_id=? AND source_company_id=? AND source_system=?',[c.id,source.company.id,'legacy-oa']);
    const rows=await q.manager.find(ResourceRecord,{where:{companyId:c.id},order:{id:'ASC'}}),byId=new Map(rows.map(r=>[r.id,r]));
    const selected=[...new Set(links.filter(l=>keys.has(l.source_key)).map(l=>Number(l.target_id)))].map(id=>byId.get(id)!).filter(r=>r&&['pending','reverify','verified'].includes(r.status));
    selected.sort((a,b)=>(a.type==='finance-base-codes'?0:1)-(b.type==='finance-base-codes'?0:1)||Number(!!a.data.canonicalId)-Number(!!b.data.canonicalId)||a.id-b.id);
    const repair=await planSkuRepair(q.manager,c.id,source);
    const report:SkuVerification={sourceHash:skuRepairHash(source.records),targetHash:skuRepairHash(selected.map(r=>[r.id,r.status,r.data])),checked:[],issues:repair.conflicts.map(x=>({type:'conflict',id:0,reason:`${x.sourceKey}.${x.field}：${x.reason}`}))};
    if(repair.additions.length)report.issues.push({type:'missing',id:0,reason:'仍有未补入的SKU资料，请先完成增量补入'});
    if(opts.apply&&(!opts.expected||opts.expected.issues.length||opts.expected.sourceHash!==report.sourceHash||opts.expected.targetHash!==report.targetHash))throw new MigrationError('验证报告未通过或来源/目标已变化');
    for(const r of selected){
      await q.query('SAVEPOINT sku_verify');
      try{await resources.saveChecked(q.manager,user,r.type,r.id,{}, {status:'verified',note:'旧系统SKU专项修复后重新验证'});report.checked.push({type:r.type,id:r.id});await q.query('RELEASE SAVEPOINT sku_verify');}
      catch(e){await q.query('ROLLBACK TO SAVEPOINT sku_verify');await q.query('RELEASE SAVEPOINT sku_verify');report.issues.push({type:r.type,id:r.id,reason:safeFailure(e)});}
    }
    report.history=await registerCostSnapshots(q.manager,c.id,actor.id,report.checked.filter(r=>r.type==='finance-bundles').map(r=>r.id),'旧系统SKU专项修复后重新验证','workflow_publish');
    opts.prepare?.(report);
    if(opts.apply&&report.issues.length)throw new MigrationError('存在不能验证的资料，整批已回滚');
    if(opts.apply)await q.commitTransaction();else await q.rollbackTransaction();return report;
  }catch(e){if(q.isTransactionActive)await q.rollbackTransaction();throw e;}finally{await q.release();}
}
