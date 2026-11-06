import {initialSkuWarehouseDraft} from './sku-warehouse-draft';
import {skuDuplicateState} from './sku-duplicate-confirmation';
import {bundleLaborUnit} from '../resources/bundle-component-validation';
import {costCompositionFacts} from '../resources/cost-components';
import {skuReuseLibrary} from './sku-reuse';
import {SKU_ROLE_ARCHIVES,skuCatalog} from './sku-catalog';
import {inheritedSkuBrandId} from './sku-brand';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In,type EntityManager } from 'typeorm';
import { createChecker, getResourceDef, normalizeSpecs, normalizeWarehouse, sumUnitCents, multiplyUnitCents, WAREHOUSE_ROLE_LABEL, type SkuSpec, type WarehouseSpec } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Company, FlowRun, FlowStep, ResourceRecord,WorkItem } from '../entities';
import { BundleToolsService } from '../resources/bundle-tools.service';
import {codeEnabledState} from '../resources/finance-code-lifecycle';
import { FlowService } from './flow.service';
import { CreatedBundle, SKU_TEMPLATE, checkApplication, specLines, platformIdsOf } from './sku-apply';
import { createHash } from 'crypto';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export type SkuOptionKind = 'main' | 'gift' | 'package' | 'label' | 'other' | 'labor' | 'names';
const ARCHIVE_BY_KIND = SKU_ROLE_ARCHIVES;

/** SKU 批量申请的辅助接口：给申请表单提供可选项（不要求有财务资料的查看权限），给详情页提供「会生成什么编码」的预览。 */
@Injectable()
export class SkuApplyService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly flow: FlowService, private readonly bundles: BundleToolsService) {}

  private async optionsAllowed(user:AuthUser,kind:string,runId?:number){
    if(!createChecker(user.permissions)('flow.apply.view')){if(!runId)throw new ForbiddenException('没有读取SKU申请选项的权限');const run=await this.flow.detail(user,runId),step=run.activeStep?.key;if(run.templateKey!==SKU_TEMPLATE)throw new ForbiddenException('这不是可读取的SKU申请');if(['meta','names'].includes(kind))return run;const allowed=step==='warehouse'&&['package','label','other','labor'].includes(kind);if(!run.me.canPass||!allowed)throw new ForbiddenException('当前SKU步骤不允许读取这些选项');return run;}
  }
  async catalogNames(user:AuthUser,requestedIds:string,runId?:number){const query={ids:requestedIds,runId};const ordinary=await this.options(user,'names','',query.ids??'',{runId:query.runId}),canCost=createChecker(user.permissions)('product.cost.view'),ids=ordinary.items?.map(item=>item.id)??[],records=ids.length?await this.ds.manager.find(ResourceRecord,{where:{companyId:user.companyId,type:'finance-base-codes',id:In(ids)}}):[];return {items:ordinary.items?.map(item=>({...item,...(canCost?{costCents:typeof records.find(record=>record.id===item.id)?.data.cost==='number'?Number(records.find(record=>record.id===item.id)!.data.cost):null}:{})}))??[],canCost};}
  async catalogOptions(user:AuthUser,kind:string,query:{ids?:string;runId?:number;keyword?:string;category?:string;page?:number;pageSize?:number}){await this.optionsAllowed(user,kind,query.runId);if(!['main','gift','package','label','other','labor'].includes(kind))throw new BadRequestException('不支持此目录类型');return skuCatalog(this.ds.manager,user,kind,query);}

  /** 申请表单的下拉：销售场景、销售平台，以及按用途搜索商品（最多 30 条）。只返回编码、名称、规格，没有成本价格。 */
  async options(user: AuthUser, kind: SkuOptionKind | 'meta', keyword = '', ids = '',query:{catalog?:boolean;runId?:number;category?:string;page?:number;pageSize?:number}={}) {
    const em = this.ds.manager;
    const context=await this.optionsAllowed(user,kind,query.runId);
    if (kind === 'meta') {
      const selected=(type:string)=>new Set<number>(type==='finance-scenarios'?[Number(context?.payload.scenarioId)]:type==='finance-platforms'?platformIdsOf(context?.payload??{}):type==='finance-brands'?[Number(context?.payload.brandId),...((context?.payload.specs as SkuSpec[]|undefined)??[]).map(spec=>Number(spec.brandId))]:[]);
      const rows = async (type: string) => (await em.find(ResourceRecord, { where: { companyId: user.companyId, type }, order: { title: 'ASC' } })).filter(r=>context?selected(type).has(r.id):r.status==='active').map(r=>({id:r.id,name:r.title,code:str(r.data.code)}));
      return { scenarios: await rows('finance-scenarios'), platforms: await rows('finance-platforms'), brands: await rows('finance-brands'), bundleCategories: (await this.bundleCategoryLeaves(user.companyId)).filter(row=>!context||row.id===Number(context.payload.bundleCategoryId)) };
    }
    if (kind === 'names') {
      // 重新提交时按编号回填商品名称（只给编码、名称、规格）
      const list = [...new Set(ids.split(',').map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
      if (!list.length) return { items: [] };
      if(context){const allowed=new Set((context.payload.specs as SkuSpec[]|undefined)?.flatMap(spec=>[...spec.main,...spec.gift].map(row=>row.baseCodeId))??[]);for(const spec of ([...(context.stepDraft?.form.config as WarehouseSpec[]|undefined)??[],...context.steps.filter(step=>step.key==='warehouse').flatMap(step=>(step.form?.config as WarehouseSpec[]|undefined)??[])]))for(const row of spec.lines)if(row.baseCodeId)allowed.add(row.baseCodeId);for(let i=list.length-1;i>=0;i--)if(!allowed.has(list[i]))list.splice(i,1);if(!list.length)return {items:[]};}
      const rows = await em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t AND r.id IN (:...ids)', { c: user.companyId, t: 'finance-base-codes', ids: list }).getMany();
      return { items: await Promise.all(rows.map(async bc => ({ id:bc.id,code:bc.title,name:str(bc.data.name),spec:str(bc.data.spec),brandId:await inheritedSkuBrandId(em,user.companyId,bc.id) }))) };
    }
    const kw = keyword.trim().slice(0, 50);
    if (kind === 'labor') {
      const q = em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t AND r.status = :s', { c: user.companyId, t: 'finance-labor-costs', s: 'active' });
      if (kw) q.andWhere('r.searchText LIKE :kw', { kw: `%${kw}%` });
      return { items: (await q.orderBy('r.title', 'ASC').limit(30).getMany()).map((r) => ({ id: r.id, code: str(r.data.workCode), name: str(r.data.workName) || r.title })) };
    }
    if (!ARCHIVE_BY_KIND[kind]) throw new BadRequestException('不认识的选项类型');
    const q = em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t AND r.status = :s', { c: user.companyId, t: 'finance-base-codes', s: 'verified' });
    if (kw) q.andWhere('r.searchText LIKE :kw', { kw: `%${kw}%` });
    const out: { id: number; code: string; name: string; spec: string }[] = [];
    // 档案类型在商品档案上，先多取一些再按用途过滤
    const cands = await q.orderBy('r.title', 'ASC').limit(300).getMany();
    const prods = new Map<number, string>();
    for (const bc of cands) {
      if (out.length >= 30) break;
      const pid = Number(bc.data.productId);
      if (!prods.has(pid)) prods.set(pid, str((await em.findOne(ResourceRecord, { where: { id: pid, companyId: user.companyId, type: 'finance-products' }, select: ['id', 'data'] }))?.data.archiveType));
      if (ARCHIVE_BY_KIND[kind].includes(prods.get(pid)!)) out.push({ id: bc.id, code: bc.title, name: str(bc.data.name), spec: str(bc.data.spec) });
    }
    return { items: out };
  }

  /** 原新建申请第一步的只读商品查询：仅编码/名称/规格与可见使用记录，不返回成本。 */
  async draftReferences(user:AuthUser,keyword:string){
    if(!createChecker(user.permissions)('flow.apply.view'))throw new ForbiddenException('没有查询申请商品的权限');
    const term=keyword?.trim();if(!term)throw new BadRequestException('请输入商品名称或基本编码');
    const em=this.ds.manager,states=getResourceDef('finance-base-codes')!.statuses.filter(status=>codeEnabledState({type:'finance-base-codes',status:status.value})==='active').map(status=>status.value),candidates=(await em.createQueryBuilder(ResourceRecord,'r').where('r.companyId=:company AND r.type=:type AND r.archivedAt IS NULL',{company:user.companyId,type:'finance-base-codes'}).andWhere('r.status IN (:...states)',{states}).andWhere('r.searchText LIKE :keyword',{keyword:`%${term.slice(0,100)}%`}).orderBy('r.updatedAt','DESC').addOrderBy('r.id','DESC').take(30).getMany()).filter(row=>codeEnabledState(row)==='active').slice(0,30),baseIds=new Set(candidates.map(row=>row.id));
    if(!candidates.length)return {items:[]};
    const links=await em.createQueryBuilder(ResourceRecord,'r').where('r.companyId=:company AND r.type=:type',{company:user.companyId,type:'finance-bundle-lines'}).andWhere("JSON_EXTRACT(r.data,'$.baseCodeId') IN (:...ids)",{ids:[...baseIds]}).getMany(),bundleIds=[...new Set(links.map(row=>Number(row.data.bundleId)).filter(id=>Number.isSafeInteger(id)&&id>0))];
    const bundles=bundleIds.length?(await em.find(ResourceRecord,{where:{companyId:user.companyId,type:'finance-bundles',id:In(bundleIds)}})).filter(row=>!row.archivedAt&&codeEnabledState(row)==='active'):[];
    const pending=await em.find(FlowRun,{where:{companyId:user.companyId,templateKey:SKU_TEMPLATE,status:In(['draft','running'])},order:{id:'DESC'},take:1000});
    const usages=new Map<number,Array<Record<string,unknown>>>(),restricted=new Set<number>();
    for(const run of pending){
      const specs=normalizeSpecs(run.payload.specs,{allowIncomplete:true,quantityScale:run.payload._applicationDraftOrigin===true?6:0}).specs,matching=specs.filter(spec=>[...spec.main,...spec.gift].some(line=>baseIds.has(line.baseCodeId)));if(!matching.length)continue;
      if(!await this.flow.canSeeRun(em,user,run)){for(const spec of matching)for(const line of [...spec.main,...spec.gift])if(baseIds.has(line.baseCodeId))restricted.add(line.baseCodeId);continue;}
      const active=await em.findOne(FlowStep,{where:{companyId:user.companyId,runId:run.id,status:'active'},order:{seq:'DESC'}}),names=await this.flow.userNames(em,user.companyId,[run.requesterId,...(active?.recipients??[])]);
      for(const [index,spec] of matching.entries())for(const id of baseIds){const lines=[...spec.main.map(line=>({...line,role:'main'})),...spec.gift.map(line=>({...line,role:'gift'}))].filter(line=>line.baseCodeId===id);if(!lines.length)continue;const rows=usages.get(id)??[];rows.push({runId:run.id,itemId:`${run.id}:${index}`,batchRef:str(run.payload._batchKey)||`run-${run.id}`,title:str(run.payload.batchName)||run.title,specName:spec.name,status:run.status,requesterName:names.get(run.requesterId)??'',createdAt:run.createdAt,nodeName:active?.stepName??'',ownerName:(active?.recipients??[]).map(id=>names.get(id)??'').join('、'),matchedLines:lines.map(line=>({role:line.role,quantity:line.qty}))});usages.set(id,rows);}
    }
    return {items:candidates.map(base=>{const successful=bundles.filter(bundle=>links.some(line=>Number(line.data.baseCodeId)===base.id&&Number(line.data.bundleId)===bundle.id)).map(bundle=>({id:bundle.id,code:str(bundle.data.code)||bundle.title,name:str(bundle.data.name)||bundle.title})),inProgress=usages.get(base.id)??[];return {id:base.id,code:str(base.data.code)||base.title,name:str(base.data.name)||base.title,spec:str(base.data.spec),successful,inProgress,restrictedUsage:restricted.has(base.id),clear:!successful.length&&!inProgress.length&&!restricted.has(base.id)};})};
  }

  /** 组合分类树里的最末级分类（带路径名），申请表单里必选一个 */
  private async bundleCategoryLeaves(companyId: number) {
    const all = (await this.ds.manager.find(ResourceRecord, { where: { companyId, type: 'finance-categories' } })).filter((r) => r.status === 'active' && r.data.archiveType === 'bundle');
    const byId = new Map(all.map((r) => [r.id, r]));
    const parents = new Set(all.map((r) => Number(r.data.parentId)).filter((n) => n > 0));
    const pathOf = (r: ResourceRecord): string => { const names: string[] = []; let cur: ResourceRecord | undefined = r; for (let i = 0; cur && i < 8; i += 1) { names.unshift(cur.title); cur = byId.get(Number(cur.data.parentId)); } return names.join(' / '); };
    return all.filter((r) => !parents.has(r.id)).map((r) => ({ id: r.id, name: pathOf(r) })).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  /** 这张申请会生成（或已经生成）哪些编码：每个规格 × 平台一行，带重复提示；成本只给有 product.cost.view 的人。 */
  async preview(user: AuthUser, runId: number,checkRevision?:number) {
    if(checkRevision!==undefined)return this.ds.transaction(async em=>{
      const run=await this.flow.lockRun(em,user,runId,checkRevision);
      if (run.templateKey !== SKU_TEMPLATE) throw new BadRequestException('这不是 SKU 批量申请');
      const step=await em.findOne(FlowStep,{where:{companyId:user.companyId,runId,status:'active'},order:{seq:'DESC'}});
      const ownDraft=run.status==='draft'&&run.requesterId===user.id&&createChecker(user.permissions)('flow.apply.view');
      const mine=run.status==='running'&&step&&await em.findOne(WorkItem,{where:{companyId:user.companyId,runId,stepId:step.id,assigneeId:user.id,status:'open'}});
      if(!ownDraft&&!mine)throw new ForbiddenException('只有当前节点处理人可以校验申请资料');
      return this.previewIn(em,user,run);
    });
    await this.flow.detail(user,runId);
    const run=await this.ds.manager.findOne(FlowRun,{where:{id:runId,companyId:user.companyId}});if(!run)throw new NotFoundException('流程不存在');
    return this.previewIn(this.ds.manager,user,run);
  }
  private async previewIn(em:EntityManager,user:AuthUser,run:FlowRun){
    const runId=run.id;
    if (run.templateKey !== SKU_TEMPLATE) throw new BadRequestException('这不是 SKU 批量申请');
    const canCost = createChecker(user.permissions)('product.cost.view');
    const applicationDraft = run.payload._applicationDraftOrigin === true;
    const activeWarehouse = run.currentStepKey === 'warehouse' ? await em.findOne(FlowStep, {
      where: { companyId: user.companyId, runId, status: 'active', stepKey: 'warehouse' },
    }) : null;
    const warehouse = activeWarehouse
      ? (activeWarehouse.form ?? await initialSkuWarehouseDraft(em, run)).config
      : run.payload._warehouse;
    const wh = Array.isArray(warehouse) ? warehouse as WarehouseSpec[] : undefined;
    const created = (run.payload._created as CreatedBundle[] | undefined) ?? null;
    const specs = normalizeSpecs(run.payload.specs,{quantityScale:run.payload._applicationDraftOrigin===true?6:0}).specs;
    const label = async (type: string, id: number | null | undefined) => (id ? (await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type }, select: ['id', 'title'] }))?.title ?? '' : '');
    const platforms = await Promise.all(platformIdsOf(run.payload).map(async (id) => ({ id, name: await label('finance-platforms', id) })));
    const info = async (baseCodeId: number) => {
      const bc = await em.findOne(ResourceRecord, { where: { id: baseCodeId, companyId: user.companyId, type: 'finance-base-codes' } });
      return { code: bc?.title ?? '已删除', name: str(bc?.data.name),spec:str(bc?.data.spec), weightG: num(bc?.data.weightG), cost: canCost ? num(bc?.data.cost) : undefined };
    };
    let plan: Awaited<ReturnType<typeof checkApplication>>['plan'] | null = null;
    let planError = '';
    let applicationWarnings: string[] = [];
    // 已完成的申请不再做检查（编码已经生成，再预览会显示成“已有”）
    if (run.status === 'running'||run.status==='draft') {
      try {
        const checkingApplication = run.status === 'draft' || run.currentStepKey === 'apply';
        if (activeWarehouse && !wh) throw new BadRequestException('请先保存仓库配置，再查重与校验');
        if (wh && !checkingApplication) {
          const validation = normalizeWarehouse(wh, specs.map(spec => spec.name), { quantityScale: applicationDraft ? 6 : 3 });
          if (validation.errors.length) throw new BadRequestException(validation.errors.join('；'));
        }
        const checked = await checkApplication(em, user, this.bundles, { ...run.payload }, {
          strict: checkingApplication, selfRunId: run.id,
          warehouse: !applicationDraft && checkingApplication ? undefined : wh,
          requireBrand: applicationDraft, allowGeneratedDuplicates: applicationDraft, includeApplicationWarnings: true,
        });
        plan = checked.plan;
        applicationWarnings = checked.applicationWarnings;
      } catch (e) { planError = (e as Error).message; }
    }
    const rows = [];
    for (const [i, s] of specs.entries()) {
      const lineView = async (baseCodeId: number, qty: number, role: string) => ({ baseCodeId, role, roleLabel: role === 'main' ? '主商品' : role === 'gift' ? '赠品' : WAREHOUSE_ROLE_LABEL[role as keyof typeof WAREHOUSE_ROLE_LABEL] ?? role, qty, ...(await info(baseCodeId)) });
      const lines = [...(await Promise.all(s.main.map((l) => lineView(l.baseCodeId, l.qty, 'main')))), ...(await Promise.all(s.gift.map((l) => lineView(l.baseCodeId, l.qty, 'gift'))))];
      const whLines = [];
      for (const l of wh?.[i]?.lines ?? []) {
        if (l.role === 'labor') {
          const rec = await em.findOne(ResourceRecord, { where: { id: l.laborId!, companyId: user.companyId, type: 'finance-labor-costs' } });
          whLines.push({ laborId:l.laborId, role: 'labor', roleLabel: '人工', qty: l.qty, code: str(rec?.data.workCode), name: str(rec?.data.workName) || rec?.title || '已删除',spec:rec?await bundleLaborUnit(em,user.companyId,rec):'', weightG: null, cost: canCost ? (num(rec?.data.unitPrice) ?? 0) : undefined });
        } else whLines.push(await lineView(l.baseCodeId!, l.qty, l.role));
      }
      const all = [...lines, ...whLines];
      let totalCost:number|null|undefined = canCost ? sumUnitCents(all.map((l) => multiplyUnitCents(l.cost ?? 0,l.qty,0,run.payload._applicationDraftOrigin===true?6:4))) : undefined;
      let weightG:number|null = Math.round(all.reduce((sum, l) => sum + (l.weightG ?? 0) * l.qty, 0) * 1e6) / 1e6;
      if(run.payload._applicationDraftOrigin===true){const facts=await costCompositionFacts(em,user.companyId,{},specLines(s,wh?.[i]) as unknown as Record<string,unknown>[]);totalCost=canCost?facts.preShipCostCents:undefined;weightG=facts.weightG;for(const [index,line] of all.entries()){line.cost=canCost?facts.lines[index]?.unitCostCents??undefined:undefined;line.weightG=facts.lines[index]?.unitWeightG??null;}}
      rows.push({
        name: s.name, brandName:await label('finance-brands',s.brandId??num(run.payload.brandId)??await inheritedSkuBrandId(em,user.companyId,s.main[0]?.baseCodeId)), note: s.note ?? '', reuseReason: s.reuseReason ?? '', lines, warehouse: whLines, notRequired: wh?.[i]?.notRequired ?? {}, weightG, totalCost,
        targets: plan ? plan[i].targets : [], created: created ? created.filter((c) => c.spec === s.name) : [],
      });
    }
    return {
      batch: run.payload._batchKey ? { key: str(run.payload._batchKey), index: num(run.payload._splitIndex), total: num(run.payload._splitTotal) } : null,
      runId, status: run.status, batchName: str(run.payload.batchName), scenario: await label('finance-scenarios', num(run.payload.scenarioId)), platforms,
      ...(run.payload._applicationDraftOrigin===true&&plan&&!planError?await skuDuplicateState(em,user.companyId,run,run.payload,wh,plan):{generatedDuplicates:undefined,duplicateToken:undefined}),
      warehouseDone: !!run.payload._warehouse&&!activeWarehouse, canCost, planError, applicationWarnings, specs: rows, costNote: '物料成本含人工，不含运费',
    };
  }

  /**
   * 复用历史仓库配置（旧系统“复用仓库配置”）：按主商品找以前办过的申请里，同样主商品的规格填过的包装、标签、打包材料、人工。
   * 只返回配置本身和商品名称，不带成本；用的时候由办理人逐项核对，提交时仍按现在的规则完整校验。
   */
  async reuseLibrary(user:AuthUser,runId:number|undefined,keyword=''){
    if(!runId)throw new BadRequestException('请选择当前待办规格');
    const detail=await this.flow.detail(user,runId);
    if(detail.templateKey!==SKU_TEMPLATE||detail.activeStep?.key!=='warehouse'||!detail.me.canPass)throw new ForbiddenException('只有当前仓库处理人可以复用配置');
    return skuReuseLibrary(this.ds.manager,user,keyword.trim().slice(0,100));
  }

  async historyConfigs(user: AuthUser, mainIds: number[], keyword = '',runId?:number) {
    await this.optionsAllowed(user,'package',runId);
    const em = this.ds.manager;
    const want = new Set(mainIds);
    const kw = keyword.trim().toLowerCase().slice(0, 50);
    const runs = await em.find(FlowRun, { where: { companyId: user.companyId, templateKey: SKU_TEMPLATE }, order: { id: 'DESC' }, take: 300 });
    const hits: Array<{ runId: number; title: string; specName: string; main: Array<{ baseCodeId: number; qty: number }>; config: WarehouseSpec; score: number; status: string }> = [];
    for (const r of runs) {
      const wh = r.payload._warehouse as WarehouseSpec[] | undefined;
      if (!Array.isArray(wh)) continue;
      const specs: SkuSpec[] = normalizeSpecs(r.payload.specs,{quantityScale:r.payload._applicationDraftOrigin===true?6:0}).specs;
      specs.forEach((sp, i) => {
        const cfg = wh[i];
        if (!cfg || (!cfg.lines.length && !Object.keys(cfg.notRequired ?? {}).length)) return;
        const ids = sp.main.map((l) => l.baseCodeId);
        const same = want.size > 0 && ids.length === want.size && ids.every((x) => want.has(x));
        const overlap = ids.some((x) => want.has(x));
        if (want.size > 0 && !overlap) return;
        if (kw && !`${sp.name} ${str(r.payload.batchName)}`.toLowerCase().includes(kw)) return;
        hits.push({ runId: r.id, title: r.title, specName: sp.name, main: sp.main, config: cfg, score: same ? 2 : overlap ? 1 : 0, status: r.status });
      });
    }
    hits.sort((a, b) => b.score - a.score || b.runId - a.runId);
    const top = hits.slice(0, 20);
    const baseIds = [...new Set(top.flatMap((h) => [...h.main.map((m) => m.baseCodeId), ...h.config.lines.filter((l) => l.role !== 'labor').map((l) => l.baseCodeId!)]))];
    const laborIds = [...new Set(top.flatMap((h) => h.config.lines.filter((l) => l.role === 'labor').map((l) => l.laborId!)))];
    const find = async (type: string, ids: number[]) => (ids.length ? em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t AND r.id IN (:...ids)', { c: user.companyId, t: type, ids }).getMany() : []);
    const names: Record<string, string> = {};
    for (const b of await find('finance-base-codes', baseIds)) names[`b${b.id}`] = `${b.title} ${str(b.data.name)}`.trim();
    for (const l of await find('finance-labor-costs', laborIds)) names[`l${l.id}`] = `${str(l.data.workCode)} ${str(l.data.workName) || l.title}`.trim();
    return { items: top.map(({ score, ...h }) => ({ ...h, exact: score === 2 })), names };
  }

  /** 每个规格独立办理：一次填完，拆成一个规格一条流程（各自走仓库、财务），同一批用 batchKey 关联；先整体检查，再逐条发起 */
  async startSplit(user: AuthUser, payloadIn: Record<string, unknown>, requestKey: string) {
    if(!createChecker(user.permissions)('flow.apply.view'))throw new ForbiddenException('没有发起流程的权限');
    if(typeof requestKey!=='string'||!/^[A-Za-z0-9_-]{12,60}$/.test(requestKey))throw new BadRequestException('requestKey 要12到60位字母数字');
    const payload={...payloadIn};delete payload.splitSpecs;
    const norm=normalizeSpecs(payload.specs),specs=norm.specs;
    if(norm.errors.length)throw new BadRequestException(norm.errors.join('；'));
    if(specs.length<2)throw new BadRequestException('只有一个规格不用拆开办理，直接发起即可');
    if(specs.length>100)throw new BadRequestException('一次最多100个规格');
    const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):value;
    const inputOf=(p:Record<string,unknown>,sp:unknown)=>({batchName:String(p.batchName??'').trim(),scenarioId:p.scenarioId??null,brandId:p.brandId||null,platformIds:platformIdsOf(p).sort((a,b)=>a-b),bundleCategoryId:p.bundleCategoryId??null,note:String(p.note??'').trim(),specs:sp});
    const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
    const hash=fingerprint(inputOf(payload,specs)),keys=specs.map((_,i)=>`${requestKey}-${i}`);
    return this.ds.transaction(async em=>{
      await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
      const previous=await em.find(FlowRun,{where:{companyId:user.companyId,requestKey:In(keys)},lock:{mode:'pessimistic_write'}});
      for(const run of previous){
        const index=keys.indexOf(run.requestKey!);
        if(run.requesterId!==user.id || run.templateKey!==SKU_TEMPLATE)throw new ConflictException('请求标识已被其他申请使用');
        if(run.payload._splitRequestHash ? run.payload._splitRequestHash!==hash : fingerprint(inputOf(run.payload,normalizeSpecs(run.payload.specs,{quantityScale:run.payload._applicationDraftOrigin===true?6:0}).specs))!==fingerprint(inputOf(payload,[specs[index]])) || run.payload._splitTotal!==undefined && Number(run.payload._splitTotal)!==specs.length || run.payload._splitIndex!==undefined && Number(run.payload._splitIndex)!==index+1)throw new ConflictException('同一请求标识的申请内容已变化，请核对原申请');
      }
      const oldKeys=[...new Set(previous.map(run=>str(run.payload._batchKey)).filter(Boolean))];
      if(oldKeys.length>1 || oldKeys.some(key=>!/^B[0-9a-z]{1,19}$/.test(key)))throw new ConflictException('原申请的批次归组不一致，请先核对原申请');
      const batchKey=oldKeys[0] ?? `B${fingerprint([user.companyId,user.id,requestKey]).slice(0,19)}`;
      const missing=specs.filter((_,i)=>!previous.some(run=>run.requestKey===keys[i]));
      // 重放已提交事实不重新拿当前商品资料覆盖；只有尚未创建的规格需要再次严格检查。
      if(missing.length)await checkApplication(em,user,this.bundles,{...payload,specs:missing},{strict:true});
      const runs:Array<{id:number;specName:string}>=[],failed:Array<{specName:string;message:string}>=[];
      for(const [i,spec] of specs.entries()){
        const point=`sku_split_${i}`;await em.query(`SAVEPOINT ${point}`);
        try{
          const old=previous.find(run=>run.requestKey===keys[i]);
          const started=old ?? await this.flow.startIn(em,user,SKU_TEMPLATE,{...payload,specs:[spec]},keys[i]);
          // 原有归组绝不改写；新入场与标记同事务，失败不会留下无归组的流程或待办。
          if(!old?.payload._batchKey){
            const record=await em.findOneByOrFail(FlowRun,{id:started.id,companyId:user.companyId});
            await em.update(FlowRun,{id:record.id,companyId:user.companyId},{payload:{...record.payload,_batchKey:batchKey,_splitIndex:i+1,_splitTotal:specs.length,_splitRequestHash:hash}});
          }
          runs.push({id:started.id,specName:spec.name});await em.query(`RELEASE SAVEPOINT ${point}`);
        }catch(error){await em.query(`ROLLBACK TO SAVEPOINT ${point}`);await em.query(`RELEASE SAVEPOINT ${point}`);failed.push({specName:spec.name,message:(error as Error).message});}
      }
      return {batchKey,runs,failed};
    });
  }

  /** 同一批拆开办理的申请：每个规格现在到哪一步了（只列你能看到的） */
  async batch(user: AuthUser, batchKey: string) {
    const em = this.ds.manager;
    const runs = await em.createQueryBuilder(FlowRun, 'r')
      .where('r.companyId = :c AND r.templateKey = :t AND JSON_UNQUOTE(JSON_EXTRACT(r.payload, :p)) = :k', { c: user.companyId, t: SKU_TEMPLATE, p: '$._batchKey', k: batchKey })
      .orderBy('r.id', 'ASC').limit(100).getMany();
    const out = [];
    for (const r of runs) {
      try {
        const d = await this.flow.detail(user, r.id);
        const spec = normalizeSpecs(r.payload.specs,{quantityScale:r.payload._applicationDraftOrigin===true?6:0}).specs[0];
        out.push({ id: r.id, specName: spec?.name ?? '', status: r.status, currentStep: d.activeStep?.name ?? '' });
      } catch { /* 看不到的不列 */ }
    }
    return { batchKey, total: runs.length, items: out };
  }
}
