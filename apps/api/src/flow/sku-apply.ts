import {initialSkuWarehouseDraft,supportsSkuWarehouseDraft} from './sku-warehouse-draft';
import {bundleLaborUnit} from '../resources/bundle-component-validation';
import {confirmSkuDuplicates} from './sku-duplicate-confirmation';
import {skuReuseLibrary} from './sku-reuse';
import {costCompositionFacts} from '../resources/cost-components';
import {captureSkuInspection,publicSkuInspection} from './sku-inspection';
import {SKU_ROLE_ARCHIVES,skuCodeFamily,skuLaborIsCurrent} from './sku-catalog';
import {resolveSkuBrandId} from './sku-brand';
import { writeNotification } from '../outbox/write-notification';
import { BadRequestException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { createChecker, SPECIAL_PERMISSIONS, normalizeSpecs, normalizeWarehouse, type SkuSpec, type WarehouseLine, type WarehouseSpec } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { FlowRun, FlowStep, Notification, ResourceRecord,OutboxJob } from '../entities';
import { sigOf } from '../resources/base-code-support';
import { registerCostSnapshots } from '../resources/cost-snapshot';
import type { BundleToolsService, LineInput, TargetInput } from '../resources/bundle-tools.service';
import type { FlowAdapter } from './flow-adapters';

/**
 * SKU 批量申请流程的业务规则（运营 → 仓库 → 财务）。流转、办理人、退回、通知都由流程引擎负责，
 * 这里只声明：能不能发起、每一步办理时校验什么、财务通过时调用「商品组合编码」的批量生成服务建组合。
 */

export const SKU_TEMPLATE = 'sku-batch-apply';
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const asEngine = (user: AuthUser): AuthUser => ({ ...user, permissions: { isCompanyAdmin: true, allow: [], deny: [] } });

/** 各用途允许的商品档案类型（沿用旧系统：主品=原料/采购成品；赠品另加发货物料；包装=产品包装；标签/说明书/其他=发货物料） */
const ALLOWED_ARCHIVE: Record<string, readonly string[]> = {...SKU_ROLE_ARCHIVES,instruction:SKU_ROLE_ARCHIVES.label};

const ROLE_LABEL: Record<string, string> = { main: '主商品', gift: '赠品', package: '包装', label: '标签', instruction: '说明书', other: '其他物料' };

export const platformIdsOf = (p: Record<string, unknown>): number[] => (Array.isArray(p.platformIds) ? p.platformIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

export function specLines(spec: SkuSpec, wh?: WarehouseSpec): LineInput[] {
  const lines: LineInput[] = [
    ...spec.main.map((l) => ({ role: 'main', baseCodeId: l.baseCodeId, qty: l.qty })),
    ...spec.gift.map((l) => ({ role: 'gift', baseCodeId: l.baseCodeId, qty: l.qty })),
  ];
  for (const l of (wh?.lines ?? []) as WarehouseLine[]) lines.push(l.role === 'labor' ? { role: 'labor', laborId: l.laborId, qty: l.qty } : { role: l.role, baseCodeId: l.baseCodeId, qty: l.qty });
  return lines;
}
export const effectiveSkuBrandId=(spec:SkuSpec,payload:Record<string,unknown>)=>spec.brandId??num(payload.brandId);

function mainIdentity(spec: SkuSpec) {
  const quantities = new Map<number, number>();
  for (const line of spec.main) quantities.set(line.baseCodeId, (quantities.get(line.baseCodeId) ?? 0) + line.qty);
  return spec.main.length ? JSON.stringify([...quantities].sort(([a], [b]) => a - b).map(([id, qty]) => [id, Number(qty.toFixed(6))])) : '';
}

/** 检查每个商品：存在、同公司、已验证、档案类型符合用途、主品赠品有成本 */
async function checkBaseCode(em: EntityManager, companyId: number, id: number, role: string, cache: Map<number, { bc: ResourceRecord; archive: string }>) {
  let hit = cache.get(id);
  if (!hit) {
    const bc = await em.findOne(ResourceRecord, { where: { id, companyId, type: 'finance-base-codes' } });
    if (!bc) throw new BadRequestException('选择的商品不存在，请重新选择');
    const prod = await em.findOne(ResourceRecord, { where: { id: Number(bc.data.productId), companyId, type: 'finance-products' } });
    hit = {bc,archive:bc.data.codeDictionaryCategoryId!=null?await skuCodeFamily(em,companyId,bc):str(prod?.data.archiveType)};
    cache.set(id, hit);
  }
  const { bc, archive } = hit;
  if (bc.status !== 'verified') throw new BadRequestException(`商品「${bc.title}」还没验证，验证通过后才能用于申请`);
  if (!ALLOWED_ARCHIVE[role].includes(archive)) throw new BadRequestException(`「${bc.title}」不能当作${ROLE_LABEL[role]}（档案类型不对）`);
  if ((role === 'main' || role === 'gift') && num(bc.data.cost) === null) throw new BadRequestException(`商品「${bc.title}」还没有有效成本，请先让财务维护成本`);
  return bc;
}

async function checkLabor(em: EntityManager, companyId: number, id: number,strict=false) {
  const labor = await em.findOne(ResourceRecord, { where: { id, companyId, type: 'finance-labor-costs' } });
  if (!labor) throw new BadRequestException('选择的人工项目不存在');
  if(strict){const version=typeof labor.data.versionId==='number'?await em.findOneBy(ResourceRecord,{companyId,type:'finance-labor-versions',id:labor.data.versionId}):null;if(!skuLaborIsCurrent(labor,version))throw new BadRequestException(`人工项目「${labor.title}」不在当前启用且有效的成本版本内`);await bundleLaborUnit(em,companyId,labor,true);}
  if (labor.status !== 'active') throw new BadRequestException(`人工项目「${labor.title}」已停用`);
}

interface PlanTarget { platformId: number; platformName: string; code: string; name: string; reuse: { id: number; code: string; status: string } | null; duplicates: { layer: string; label: string; hit: string }[]; ok: boolean }

/** 申请的整体检查：规格格式、商品、重复。strict = 发起/重新提交时（已有相同组合要写原因） */
export async function checkApplication(em: EntityManager, user: AuthUser, bundles: BundleToolsService, payload: Record<string, unknown>, opts: { strict: boolean; selfRunId?: number; warehouse?: WarehouseSpec[];requireBrand?:boolean;allowGeneratedDuplicates?:boolean; includeApplicationWarnings?:boolean }) {
  if(opts.requireBrand){const draft=normalizeSpecs(payload.specs,{quantityScale:6});if(draft.specs.some(spec=>[...spec.main,...spec.gift].some(line=>!Number.isSafeInteger(line.qty))))throw new BadRequestException('主商品和赠品数量必须是基础SKU的正整数件数');}
  const norm = normalizeSpecs(payload.specs,{quantityScale:opts.requireBrand?6:0});
  if (norm.errors.length) throw new BadRequestException(norm.errors.join('；'));
  payload.specs = norm.specs;
  const platformIds = platformIdsOf(payload);
  const scenarioId = num(payload.scenarioId);
  if (!scenarioId) throw new BadRequestException('请选择销售场景');
  if (platformIds.length === 0) throw new BadRequestException('请至少选一个销售平台');
  if (!Number.isInteger(payload.bundleCategoryId) || Number(payload.bundleCategoryId) <= 0) throw new BadRequestException('请选择组合分类');
  const category = await em.findOne(ResourceRecord, { where: { id: Number(payload.bundleCategoryId), companyId: user.companyId, type: 'finance-categories' } });
  if (!category || category.status !== 'active' || category.data.archiveType !== 'bundle') throw new BadRequestException('请选择启用的组合分类');
  const children = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-categories' } });
  if (children.some((c) => c.data.parentId === category.id)) throw new BadRequestException('组合分类必须选最末级');
  const cache = new Map<number, { bc: ResourceRecord; archive: string }>();
  const plan: { name: string; lines: LineInput[]; targets: PlanTarget[] }[] = [];
  for (const [i, spec] of norm.specs.entries()) {
    for (const l of spec.main) await checkBaseCode(em, user.companyId, l.baseCodeId, 'main', cache);
    for (const l of spec.gift) await checkBaseCode(em, user.companyId, l.baseCodeId, 'gift', cache);
    const wh = opts.warehouse?.[i];
    if(opts.requireBrand&&spec.main.length+spec.gift.length+(wh?.lines.filter(line=>line.role!=='labor').length??0)>100)throw new BadRequestException('组成项最多100项');
    if(opts.requireBrand&&(wh?.lines.filter(line=>line.role==='labor').length??0)>100)throw new BadRequestException('人工组成项最多100项');
    for (const l of wh?.lines ?? []) {
      if (l.role === 'labor') await checkLabor(em, user.companyId, l.laborId!,opts.requireBrand);
      else await checkBaseCode(em, user.companyId, l.baseCodeId!, l.role, cache);
    }
    const lines = specLines(spec, wh);
    const brandId=opts.requireBrand?await resolveSkuBrandId(em,user.companyId,spec,payload,true):effectiveSkuBrandId(spec,payload);
    const pre = await bundles.preview(asEngine(user), lines, platformIds.map((platformId): TargetInput => ({ platformId, scenarioId, brandId: brandId ?? undefined })), em);
    const targets = pre.targets.map((t): PlanTarget => ({ platformId: t.platformId, platformName: t.platformName, code: t.code, name: t.name, reuse: t.reuse, duplicates: t.duplicates, ok: t.ok }));
    // 编码被「本地组合编码」占用 = 系统里已经有主品、赠品相同的组合（编码只由主品、赠品、平台、场景决定）
    const sameBundle = (t: PlanTarget) => !t.reuse && t.duplicates.length > 0 && t.duplicates.every((d) => d.layer === 'bundle');
    const hardBad = targets.find((t) => !t.ok && !sameBundle(t));
    if (hardBad) throw new BadRequestException(`规格「${spec.name}」生成的编码「${hardBad.code}」重复：${hardBad.duplicates.map((d) => `${d.label}「${d.hit}」`).join('、')}`);
    const existing = targets.filter((t) => t.reuse || sameBundle(t));
    if (opts.strict) {
      if (existing.length && !spec.reuseReason&&!opts.allowGeneratedDuplicates) {
        throw new BadRequestException(`规格「${spec.name}」在系统里已经有主商品、赠品相同的组合编码（${existing.map((t) => t.reuse?.code ?? t.code).join('、')}），如果仍要申请，请在该规格里写明原因`);
      }
    } else {
      // 仓库配好之后：构成完全一样 → 沿用已有编码；只是包装、标签、人工不同 → 编码一样但内容不同，不能覆盖
      const clash = targets.find(sameBundle);
      if (clash) throw new BadRequestException(`规格「${spec.name}」的编码「${clash.code}」已被一个包装、标签或人工不同的组合占用（编码只由主商品、赠品、平台、场景决定，区分不了），不能覆盖。请改用已有组合，或联系财务调整命名规则后再申请`);
    }
    plan.push({ name: spec.name, lines, targets });
  }
  const applicationWarnings = await checkApplicationCodes(em, user, bundles, norm.specs, plan, opts.selfRunId, opts.includeApplicationWarnings);
  return { specs: norm.specs, platformIds, scenarioId, plan, cache, applicationWarnings };
}

type CodeReservation = { name: string; codes: string[] };
const reservationsOf = (plan: Array<{name:string; targets:PlanTarget[]}>): CodeReservation[] =>
  plan.map(({name,targets}) => ({name,codes:targets.map(t => t.reuse?.code || t.code).filter(Boolean)}));
const codeKey = (code: string) => code.trim().toLowerCase();

function savedReservations(payload: Record<string, unknown>): CodeReservation[] | undefined {
  if (Array.isArray(payload._skuCodeReservations)) return payload._skuCodeReservations as CodeReservation[];
  const review = payload._review as {specs?: Array<{name:string; targets:Array<{code:string}>}>} | undefined;
  return review?.specs?.map(({name,targets}) => ({name,codes:targets.map(t => t.code).filter(Boolean)}));
}

/** 老版只拦截实际占用的最终编码，主品相同和未提交草稿只作提醒。 */
async function checkApplicationCodes(em:EntityManager,user:AuthUser,bundles:BundleToolsService,specs:SkuSpec[],plan:Array<{name:string;targets:PlanTarget[]}>,selfRunId?:number,includeWarnings=false) {
  const wanted = new Map<string,{name:string;code:string}>();
  for (const {name,codes} of reservationsOf(plan)) for (const code of codes) {
    const key=codeKey(code), prior=wanted.get(key);
    if (prior) throw new BadRequestException(`规格「${name}」的最终编码「${code}」与本次申请中规格「${prior.name}」重复，请调整编码或合并规格`);
    wanted.set(key,{name,code});
  }
  const runs=await em.find(FlowRun,{where:{companyId:user.companyId,templateKey:SKU_TEMPLATE,status:includeWarnings?In(['running','draft']):'running'},select:['id','status','currentStepKey','payload']});
  const sameMain=new Set<string>();
  for (const run of runs) {
    if (run.id===selfRunId) continue;
    const p=run.payload, applicationDraft=p._applicationDraftOrigin===true;
    const other=normalizeSpecs(p.specs,{allowIncomplete:true,quantityScale:applicationDraft?6:0}).specs;
    if (includeWarnings) for (const spec of other) sameMain.add(mainIdentity(spec));
    if (run.status==='draft') continue;
    let reservations=savedReservations(p);
    // 兼容更新前已经提交、但没有保存编码快照的在办申请。
    // 退回到运营且没有快照的记录沿用旧版行为，不占码。
    if (!reservations && !applicationDraft && run.currentStepKey!=='apply') {
      const scenarioId=num(p.scenarioId), platformIds=platformIdsOf(p);
      reservations=[];
      if (scenarioId && platformIds.length) for (const [i,spec] of other.entries()) {
        if (!spec.main.length) continue;
        try {
          const brandId=effectiveSkuBrandId(spec,p);
          const {targets}=await bundles.preview(asEngine(user),specLines(spec,(p._warehouse as WarehouseSpec[]|undefined)?.[i]),platformIds.map(platformId=>({platformId,scenarioId,brandId:brandId??undefined})),em);
          reservations.push({name:spec.name,codes:targets.filter(t=>t.errors.length===0).map(t=>t.reuse?.code||t.code).filter(Boolean)});
        } catch (error) {
          // 已失效的旧申请可能无法重新命名；数据库等非业务错误必须中止校验。
          if (!(error instanceof BadRequestException)) throw error;
        }
      }
    }
    for (const {codes} of reservations??[]) for (const code of codes) {
      const hit=wanted.get(codeKey(code));
      if (hit) throw new BadRequestException(`规格「${hit.name}」的最终编码「${hit.code}」已被另一条在办申请占用，请调整编码或合并重复规格`);
    }
  }
  return includeWarnings ? specs.filter(spec=>spec.main.length&&sameMain.has(mainIdentity(spec))).map(spec=>spec.name) : [];
}

/** 仓库提交时算的“核对指纹”：编码、名称、各商品的验证快照和成本。财务通过时必须还是这个指纹 */
export async function reviewSignature(em: EntityManager, user: AuthUser, bundles: BundleToolsService, payload: Record<string, unknown>, warehouse: WarehouseSpec[], selfRunId?: number) {
  const r = await checkApplication(em, user, bundles, { ...payload }, { strict: false, warehouse, selfRunId,requireBrand:payload._applicationDraftOrigin===true });
  const parts: string[] = [];
  for (const p of r.plan) {
    parts.push(p.name, ...p.targets.map((t) => `${t.code}|${t.name}|${t.reuse?.id ?? ''}`));
    for (const l of p.lines) {
      if (l.role === 'labor') {
        const labor = await em.findOne(ResourceRecord, { where: { id: l.laborId!, companyId: user.companyId, type: 'finance-labor-costs' } });
        parts.push(`labor:${l.laborId}:${l.qty}:${labor?.status}:${labor?.data.unitPrice}`);
        if(payload._applicationDraftOrigin===true)parts.push(`unit:${labor?.data.unitId??''}:${labor?await bundleLaborUnit(em,user.companyId,labor):''}`);
        continue;
      }
      const hit = r.cache.get(l.baseCodeId!);
      parts.push(`${l.baseCodeId}:${hit?.bc.data.signature ?? ''}:${hit?.bc.data.cost ?? ''}:${hit?.bc.data.weightG ?? ''}`);
    }
  }
  return sigOf(...parts);
}

const notify = (em: EntityManager, companyId: number, userId: number, title: string, body: string, link: string) =>
  writeNotification(em, { companyId, userId, kind: 'result', title: title.slice(0, 200), body: body.slice(0, 500), link });

export interface CreatedBundle { spec: string; bundleId: number; code: string; reused: boolean }

async function validateDraftShared(em:EntityManager,user:AuthUser,payload:Record<string,unknown>){
    for(const [field,type] of [['scenarioId','finance-scenarios'],['brandId','finance-brands'],['bundleCategoryId','finance-categories']] as const){const id=payload[field];if(id!==undefined&&id!==null&&id!==''&&!await em.findOne(ResourceRecord,{where:{id:Number(id),companyId:user.companyId,type}}))throw new BadRequestException('申请公共资料不存在或不属于本公司');}
    for(const id of platformIdsOf(payload))if(!await em.findOne(ResourceRecord,{where:{id,companyId:user.companyId,type:'finance-platforms'}}))throw new BadRequestException('销售平台不存在或不属于本公司');
}

export const skuBatchApply: FlowAdapter = {
  key: SKU_TEMPLATE,
  async title(_em, _companyId, p) {
    const n = Array.isArray(p.specs) ? p.specs.length : 0;
    return `SKU 批量申请 · ${str(p.batchName)} · ${n} 个规格`.slice(0, 200);
  },
  async validateDraftShared({em,user,payload}){await validateDraftShared(em,user,payload);},
  editReturnedApplication:true,
  copyApplicationPayload(source,input){const spec=normalizeSpecs(source.specs,{allowIncomplete:true,quantityScale:6}).specs[0],name=normalizeSpecs(input.specs,{allowIncomplete:true}).specs[0]?.name;if(!spec||!name)throw new BadRequestException('复制规格名称必填');const {reuseReason:_reason,...sales}=spec;return {specs:[{...sales,name}]};},
  applicationDeletionIssue({run,steps}){
    const fail='仅可删除未提交仓库的草稿或仓库退回运营的申请；仍在办理、进入过财务或已有发布结果的规格不能删除';
    const first=(run.stepsSnapshot as Array<{key:string;type:string}>)[0];if(!first||first.type!=='submit'||run.payload._applicationDraftOrigin!==true||Object.hasOwn(run.payload,'_created')||!['draft','running','cancelled'].includes(run.status))return fail;
    const warehouse=steps.filter(step=>step.stepKey!==first.key);if(warehouse.some(step=>step.stepKey!=='warehouse'||step.stepType!=='execute'||step.action!=='return'||step.status==='active'))return fail;
    const active=steps.filter(step=>step.status==='active');if(run.status==='cancelled')return !active.length&&steps.some(step=>step.stepKey===first.key&&step.action==='cancel')?null:fail;
    if(active.length!==1||active[0].stepKey!==first.key||active[0].stepType!=='submit'||active[0].action!==null)return fail;
    return warehouse.length?run.status==='running'&&active[0].enteredVia==='return'?null:fail:run.status==='draft'&&steps.every(step=>step.action===null)?null:fail;
  },
  draftIdentity(payload){return normalizeSpecs(payload.specs,{allowIncomplete:true,quantityScale:6}).specs[0]?.name.trim().toLocaleLowerCase() ?? '';},
  async validateDraft({em,user,payload}){
    if(!str(payload.batchName).trim())throw new BadRequestException('请填写申请标题');
    const normalized=normalizeSpecs(payload.specs,{allowIncomplete:true,quantityScale:6});
    if(normalized.errors.length)throw new BadRequestException(normalized.errors.join('；'));
    if(normalized.specs.length!==1)throw new BadRequestException('每个草稿流程只保存一个规格');
    payload.specs=normalized.specs;
    for(const spec of normalized.specs)if(spec.brandId){const brand=await em.findOneBy(ResourceRecord,{id:spec.brandId,companyId:user.companyId,type:'finance-brands',status:'active'});if(!brand)throw new BadRequestException('规格组合品牌不存在或已停用');}
    for(const spec of normalized.specs)for(const line of [...spec.main,...spec.gift]){
      if(!await em.findOne(ResourceRecord,{where:{id:line.baseCodeId,companyId:user.companyId,type:'finance-base-codes'}}))throw new BadRequestException('所选商品不属于本公司或已删除');
    }
    await validateDraftShared(em,user,payload);
  },
  async validateStart({ em, user, payload, bundles,run,confirmation }) {
    if (!bundles) throw new BadRequestException('服务没有准备好');
    const name = str(payload.batchName).trim();
    if (!name) throw new BadRequestException('请填写申请名称');
    if (!num(payload.bundleCategoryId)) throw new BadRequestException('请选择组合分类');
    const warehouse=run?.payload._applicationDraftOrigin===true?run.payload._warehouse as WarehouseSpec[]|undefined:undefined;
    const checked=await checkApplication(em, user, bundles, payload, { strict: true,selfRunId:run?.id,warehouse,requireBrand:run?.payload._applicationDraftOrigin===true,allowGeneratedDuplicates:run?.payload._applicationDraftOrigin===true });
    if(run?.payload._applicationDraftOrigin===true)await confirmSkuDuplicates(em,user,run,payload,warehouse,checked.plan,confirmation);
    payload._skuCodeReservations=reservationsOf(checked.plan);
    if(run?.payload._applicationDraftOrigin===true)payload._review=await captureSkuInspection(em,user.companyId,'apply',checked.plan);
  },
  keepStateOnResubmit(run){return run.payload._applicationDraftOrigin===true;},
  async onDraftSave({run}){if(run.payload._applicationDraftOrigin===true&&Array.isArray(run.payload._warehouse))run.payload._warehouse=(run.payload._warehouse as WarehouseSpec[]).map(config=>({...config,notRequired:{}}));},
  initialStepDraft({em,run}){return initialSkuWarehouseDraft(em,run);},
  companyTransactionLock(){return true;},
  async publicApplicationState(run,user,em){
    if(run.payload._applicationDraftOrigin!==true)return {};
    const ids=((run.payload._created as CreatedBundle[]|undefined)??[]).map(item=>item.bundleId);
    const jobs=ids.length?await em.createQueryBuilder(OutboxJob,'job').where('job.companyId=:company AND job.resourceType=:type AND job.resourceId IN (:...ids)',{company:user.companyId,type:'finance-bundles',ids}).orderBy('job.id','DESC').getMany():[];
    const syncIntents=ids.map(bundleId=>{const job=jobs.find(item=>item.resourceId===bundleId);return {bundleId,state:job?(job.payloadJson.blockedIntent===true?'blocked_intent':job.status):'unrecorded'};});
    return {inspection:publicSkuInspection(run.payload._review,user),...(ids.length?{syncIntents}:{})};
  },
  async onReturn({em,run}){run.payload._skuCodeReservations=[];delete run.payload._review;delete run.payload._reviewSig;await em.save(FlowRun,run);},
  async onFinish({em,run},status){if(run.payload._applicationDraftOrigin===true&&status!=='completed'){delete run.payload._review;delete run.payload._reviewSig;await em.save(FlowRun,run);}},
  stepFields(run,key,fields){return run.payload._applicationDraftOrigin===true&&key==='warehouse'?fields.map(field=>field.key==='note'?{...field,maxLength:1000}:field):fields;},
  stepDraftEnabled({run,stepKey}){return stepKey==='warehouse'&&supportsSkuWarehouseDraft(run);},
  async validateStepDraft({em,user,run,payload,form},options){
    const applicationDraft = run.payload._applicationDraftOrigin === true;
    const specs = normalizeSpecs(payload.specs, { quantityScale: applicationDraft ? 6 : 0 }).specs;
    const normalized = normalizeWarehouse(form.config ?? specs.map(() => ({ lines: [], notRequired: {} })),
      specs.map(spec => spec.name), { quantityScale: applicationDraft ? 6 : 3, allowIncomplete: true });
    if(normalized.errors.length)throw new BadRequestException(normalized.errors.join('；'));
    const cache=new Map<number,{bc:ResourceRecord;archive:string}>();
    for(const config of normalized.config)for(const line of config.lines){
      if(line.role==='labor')await checkLabor(em,user.companyId,line.laborId!);
      else await checkBaseCode(em,user.companyId,line.baseCodeId!,line.role,cache);
    }
    form.config=normalized.config;
    const context=options.context??{};
    if(Object.keys(context).some(key=>key!=='reuseSourceId'))throw new BadRequestException('不支持的仓库复用上下文');
    if(context.reuseSourceId!==undefined){
      if(typeof context.reuseSourceId!=='string'||!/^[1-9][0-9]*:(0|[1-9][0-9]*)$/.test(context.reuseSourceId)||!context.reuseSourceId.split(':').every(value=>Number.isSafeInteger(Number(value))))throw new BadRequestException('复用来源无效');
      const library=await skuReuseLibrary(em,user,'',context.reuseSourceId),source=library.rows.find(row=>row.id===context.reuseSourceId);
      if(!source)throw new BadRequestException('复用来源不存在、未提交或不属于本公司');
      const actual=await costCompositionFacts(em,user.companyId,{},specs[0].main.map(line=>({role:'main',...line}))),targetWeightG=actual.weightG;
      const copied=source.config.lines.filter(line=>library.references.some(ref=>ref.id===(line.role==='labor'?line.laborId:line.baseCodeId)&&ref.kind===(line.role==='labor'?'labor':'base')&&ref.available));
      const groups=[{key:'package',roles:['package']},{key:'label',roles:['label','instruction']},{key:'other',roles:['other']},{key:'labor',roles:['labor']}];
      const statuses=Object.fromEntries(groups.map(group=>{const original=source.config.lines.filter(line=>group.roles.includes(line.role)),valid=copied.filter(line=>group.roles.includes(line.role));return [group.key,original.length!==valid.length?'unmatched':valid.length||source.config.notRequired[group.key as keyof WarehouseSpec['notRequired']]?.trim()?'copied':'unmatched'];}));
      const issues=copied.length===source.config.lines.length?[]:['来源中有物料已不可用，请补充核对'];
      if(targetWeightG==null||source.mainWeightG==null)issues.push('主商品重量缺失，无法比较重量，请人工核对全部配置');else if(targetWeightG!==source.mainWeightG)issues.push(`主商品重量不同：当前 ${targetWeightG/1000} kg，来源 ${source.mainWeightG/1000} kg，请核对包装容量、用量及人工`);
      form.reuseInfo={sourceId:source.id,sourceName:source.name,targetWeightG,sourceWeightG:source.mainWeightG,statuses,issues,lineKeys:copied.filter(line=>line.role!=='labor').map(line=>`${line.role}:${line.baseCodeId}`),laborKeys:copied.filter(line=>line.role==='labor').map(line=>String(line.laborId))};
    }else if(options.previousForm?.reuseInfo)form.reuseInfo=options.previousForm.reuseInfo;

    run.payload._skuCodeReservations=[];delete run.payload._reviewSig;delete run.payload._review;
  },
  async beforePass({ em, user, run, payload, stepKey, form, bundles,confirmation }) {
    if (!bundles) throw new BadRequestException('服务没有准备好');
    const specs = normalizeSpecs(payload.specs,{quantityScale:payload._applicationDraftOrigin===true?6:0}).specs;
    if (stepKey === 'warehouse') {
      const norm = normalizeWarehouse(form.config, specs.map((s) => s.name),{quantityScale:run.payload._applicationDraftOrigin===true?6:3});
      if (norm.errors.length) throw new BadRequestException(norm.errors.join('；'));
      form.config = norm.config; // 整理后的配置
      if(supportsSkuWarehouseDraft(run)){const step=await em.findOne(FlowStep,{where:{companyId:user.companyId,runId:run.id,stepKey:'warehouse',status:'active'}});const previous=step?.form??await initialSkuWarehouseDraft(em,run);if(previous?.reuseInfo)form.reuseInfo=previous.reuseInfo;}
      const checked=await checkApplication(em, user, bundles, { ...payload }, { strict: false, selfRunId: run.id, warehouse: norm.config,requireBrand:run.payload._applicationDraftOrigin===true });
      if(run.payload._applicationDraftOrigin===true)await confirmSkuDuplicates(em,user,run,payload,norm.config,checked.plan,confirmation);
      payload._skuCodeReservations=reservationsOf(checked.plan);
      if(run.payload._applicationDraftOrigin===true)payload._review=await captureSkuInspection(em,user.companyId,'warehouse',checked.plan);
    }
    if (stepKey === 'review') {
      const can = createChecker(user.permissions);
      // 生成并验证组合编码相当于改「商品组合编码」资料，办理人自己必须有这个权限
      if (!can('resource.finance-bundles.create') || !can('resource.finance-bundles.edit')) throw new BadRequestException('财务审核会生成并验证商品组合编码，你没有「商品组合编码」的新增和修改权限，请联系管理员');
      if (!can('product.cost.view')) throw new BadRequestException('财务审核需有成本查看权限，才能核对成本');
      if (form.confirmed !== true) throw new BadRequestException('请先勾选“我已核对规格、成本和编码”');
      if ((payload._applicationDraftOrigin===true||form.syncToJst === true) && !can(SPECIAL_PERMISSIONS.financeBundleSync)) throw new BadRequestException(payload._applicationDraftOrigin===true?'审核会登记聚水潭同步任务，你没有「组合装同步维护」权限':'你没有「组合装同步维护」的权限，不能勾选“加入聚水潭同步队列”');
      const wh = payload._warehouse as WarehouseSpec[] | undefined;
      if (!wh || !payload._reviewSig) throw new BadRequestException('仓库还没有提交配置，不能审核');
      if(run.payload._applicationDraftOrigin===true){const checked=await checkApplication(em,user,bundles,{...payload},{strict:false,selfRunId:run.id,warehouse:wh,requireBrand:true});await confirmSkuDuplicates(em,user,run,payload,wh,checked.plan,confirmation);}
      const now = await reviewSignature(em, user, bundles, payload, wh, run.id);
      if (now !== payload._reviewSig) throw new BadRequestException('仓库提交之后，商品、成本或编码发生了变化，请退回仓库重新确认');
    }
  },
  async onPass(ctx) {
    const { em, user, run, payload, stepKey, form, bundles, resources,outbox } = ctx;
    if (!bundles) throw new BadRequestException('服务没有准备好');
    if (stepKey === 'warehouse') {
      const wh = form.config as WarehouseSpec[];
      if(payload._applicationDraftOrigin===true)form._skuSource={specs:JSON.parse(JSON.stringify(payload.specs))};
      payload._warehouse = wh;
      delete payload._legacyWarehouseDraft;
      payload._reviewSig = await reviewSignature(em, user, bundles, payload, wh, run.id);
      return;
    }
    if (stepKey !== 'review') return;
    const specs = normalizeSpecs(payload.specs,{quantityScale:payload._applicationDraftOrigin===true?6:0}).specs;
    const wh = payload._warehouse as WarehouseSpec[];
    const platformIds = platformIdsOf(payload);
    const scenarioId = num(payload.scenarioId)!;
    const actor = asEngine(user);
    const created: CreatedBundle[] = [];
    for (const [i, spec] of specs.entries()) {
      const brandId=run.payload._applicationDraftOrigin===true?await resolveSkuBrandId(em,user.companyId,spec,payload,true):effectiveSkuBrandId(spec,payload);
      const generate=()=>bundles.generate(actor,specLines(spec,wh[i]),platformIds.map(platformId=>({platformId,scenarioId,brandId:brandId??undefined,bundleCategoryId:num(payload.bundleCategoryId)??undefined})),em);
      const res=await generate();
      for (const c of res.created) {
        const rec = await em.findOne(ResourceRecord, { where: { id: c.id, companyId: user.companyId, type: 'finance-bundles' } });
        if (!rec) continue;
        if (!c.reused) await resources.patchData(em, actor, 'finance-bundles', c.id, { sourceRunId: run.id }, `SKU 批量申请 #${run.id} 生成`);
        // 财务审核通过就是验证：新建的和“待验证/需重新验证”的一并验证；已验证的沿用
        if (rec.status === 'pending' || rec.status === 'reverify') {
          await resources.setStatusChecked(em, actor, 'finance-bundles', c.id, 'verified', `SKU 批量申请 #${run.id} 财务审核通过`);
          await registerCostSnapshots(em, user.companyId, user.id, [c.id], `SKU 批量申请 #${run.id} 财务审核通过`, 'workflow_publish');
        }
        created.push({ spec: spec.name, bundleId: c.id, code: c.code, reused: c.reused });
      }
    }
    payload._created = created;
    if(payload._applicationDraftOrigin===true){
      if(!outbox)throw new BadRequestException('同步队列服务没有准备好');
      await outbox.enqueue(user,'finance-bundles',[...new Set(created.map(item=>item.bundleId))],{em,approvalIntent:{runId:run.id}});
      payload._syncRequested=false;
    }else payload._syncRequested = form.syncToJst === true;
    await notify(em, run.companyId, run.requesterId, `SKU 申请已通过：${str(payload.batchName)}`,
      `共 ${specs.length} 个规格，生成 ${created.filter((c) => !c.reused).length} 个组合编码，沿用已有 ${created.filter((c) => c.reused).length} 个。到“财务 → 商品组合编码”查看。`, `/workbench/started?run=${run.id}`);
  },
  /** 事务提交后再加入聚水潭同步队列（队列用独立连接，必须等组合真正提交）；失败不影响已通过的申请，只提醒处理 */
  async afterCommit({ user, runId, companyId, requesterId, payload, outbox, db }) {
    if (payload._syncRequested !== true || !outbox) return;
    const ids = ((payload._created as CreatedBundle[] | undefined) ?? []).map((c) => c.bundleId);
    if (!ids.length) return;
    try {
      const r = await outbox.enqueue(asEngine(user), 'finance-bundles', ids);
      await notify(db, companyId, user.id, `SKU 申请 #${runId}：已加入聚水潭同步队列`, `新入队 ${r.queued} 个，跳过 ${r.skipped} 个。总开关打开并接入聚水潭后才会真正发送。`, `/workbench/started?run=${runId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '未知错误';
      for (const uid of new Set([user.id, requesterId])) await notify(db, companyId, uid, `SKU 申请 #${runId}：加入聚水潭同步队列失败`, `${msg}。申请本身已通过，请到“商品组合编码”页手工同步。`, `/workbench/started?run=${runId}`);
    }
  },
};

