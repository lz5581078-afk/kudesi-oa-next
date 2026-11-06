import {deriveBundleReferenceDetail} from './bundle-reference-detail';
import {captureBomVersion,listBomVersions} from './bundle-bom-versions';
import {codeCategoryRuleSet} from './bundle-naming-source';
import {bundleGenerationProfile,type BundleGenerationProfile} from './bundle-generation-profile';
import {costCompositionFacts} from './cost-components';
import {normalizeBundleComponent} from './bundle-component-validation';
import {bundleLaborUnit} from './bundle-component-validation';
import {bundleCompositionToken,readRevisionPayload,revisionWeightPatch,type RevisionWeight} from './bundle-revision-facts';
import { codeLifecycleCounts, codeVerificationState } from './finance-code-lifecycle';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { createChecker, getResourceDef, multiplyUnitCents, sumUnitCents,restrictedFieldKeys,scaledDecimal } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Company, ResourceRecord } from '../entities';
import { OutboxService } from '../outbox/outbox.service';
import { COST_FIELDS, sigOf } from './base-code-support';
import { composeBundle, resolvedMainStyleCode } from './bundle-naming';
import { bundleIssues, pickLine } from './bundle-checks';
import { registerCostSnapshots } from './cost-snapshot';
import { unfinishedApplications } from './bundle-guards';
import { buildBundleLines, bundleSnapshotJson, composeBundleFor, findNamingRule, namingInputFor, refreshBundle } from './finance-rules';
import { ResourcesService } from './resources.service';
import { CostService } from './cost.service';
import { loadUnitLists, unitLabelFor } from './unit-options';

const TYPE = 'finance-bundles';
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface LineInput { sortOrder?: number; effectiveFrom?: string; effectiveTo?: string; role: string; baseCodeId?: number; productId?: number; laborId?: number; qty: number; unit?: string; lossRate?: number; isRequired?: boolean; includeInJst?: boolean; costBucket?: string; costTreatment?: string; note?: string }
export interface TargetInput extends BundleGenerationProfile { sourceBundleId?:number;sourceToken?:string; platformId: number; scenarioId: number; configNo?: string; bundleCategoryId?: number; brandId?: number; manualCode?: string; manualName?: string; manualShortName?: string; manualReason?: string }
interface SnapLine { role: string; ref: string; qty: number; weightG: number | null; cost: number | null; [key: string]: unknown }
interface BundleSnap { profile: Record<string, unknown>; lines: SnapLine[] }

const lineKey = (l: LineInput) => `${l.role}:${l.role === 'labor' ? `L${l.laborId}` : l.productId ? `P${l.productId}` : l.baseCodeId}:${l.qty}`;

/** 商品组合编码页面用的辅助接口：批量生成、重复检查、核对验证、构成修订、删除/归档。 */
@Injectable()
export class BundleToolsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly resources: ResourcesService,
    private readonly outbox: OutboxService,
  ) {}

  private canCost(user: AuthUser) { return createChecker(user.permissions)('product.cost.view'); }

  private async load(em: EntityManager, user: AuthUser, id: number) {
    const b = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type: TYPE } });
    if (!b) throw new NotFoundException('组合不存在');
    return b;
  }

  private async lineRecords(em: EntityManager, user: AuthUser, bundleId: number) {
    return (await this.resources.findWhere(em, user.companyId, 'finance-bundle-lines', 'bundleId', bundleId)).sort((a, b) => a.id - b.id);
  }

  /** 各状态的数量（页面的状态页签用） */
  async overview(user: AuthUser) {
    const rows = await this.ds.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: TYPE }, select: ['id', 'type', 'status', 'data'] });
    const status: Record<string, number> = {};
    for (const r of rows) status[r.status] = (status[r.status] ?? 0) + 1;
    return { status, ...codeLifecycleCounts(rows) };
  }

  /** 主表整页摘要：目录/组成只加载一次，使用与成本表一致的计算及权限。 */
  async summaries(user: AuthUser, ids: number[]) {
    if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) throw new BadRequestException('组合ID必须是不重复的正整数，最多200个');
    if (!ids.length) return { rows: [] };
    const can = createChecker(user.permissions);
    if (!can('resource.finance-bundles.view')) throw new ForbiddenException('没有权限查看组合编码');
    const pricing = new CostService(this.ds), em = this.ds.manager;
    const d = await pricing.load(user.companyId, em);
    const mirrors = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-jst-skus' } });
    const salePrices = new Map(mirrors.filter(row=>row.data.goodsType==='normal').map(row=>[str(row.data.skuId),num(row.data.salePrice)]));
    const bundles = new Map(d.bundles.map(bundle => [bundle.id, bundle]));
    if (ids.some(id => !bundles.has(id))) throw new NotFoundException('组合不存在');
    return { rows: await Promise.all(ids.map(async id => {
      const b = bundles.get(id)!, values = pricing.row(d, b);
      const lines = d.lines.filter(line => line.data.bundleId === id).sort((a,b) => Number(a.data.sortOrder || 0) - Number(b.data.sortOrder || 0) || a.id-b.id);
      const packages: string[] = [], saleParts: number[] = [];
      let saleMissing = false;
      for (const line of lines) {
        const selected = d.baseCodes.get(Number(line.data.baseCodeId));
        const base = selected?.data.canonicalId ? d.baseCodes.get(Number(selected.data.canonicalId)) : selected;
        const product = d.products.get(Number(line.data.productId ?? base?.data.productId));
        const componentCode = str(selected?.data.code) || str(product?.data.code), componentName = str(selected?.data.name) || selected?.title || product?.title || '资料暂不可读';
        if (line.data.role === 'package' || componentCode.startsWith('BZ-') || ['package','oem_package'].includes(str(product?.data.archiveType))) packages.push(`${componentCode} ${componentName} ×${str(line.data.qty)}`.trim());
        // 售价只取同公司普通商品真实镜像；缺失不填成0，赠品按原口径不计销售价。
        if (line.data.role !== 'gift') {
          const price = salePrices.get(str(selected?.data.code)) ?? null, qty = num(line.data.qty);
          if (price === null || qty === null) saleMissing = true;
          else saleParts.push(multiplyUnitCents(price, qty,0,6));
        }
      }
      return { id, issueCount:(await this.report(user,id,em,{pricing,pricingData:d})).issues.length, mainStyleCode: str(b.data.mainStyleCode) || null,
        weightG: values.weightG, componentCount: lines.length, packageCount: packages.length, packageSummary: packages.join('；'),
        ...(can('product.cost.view') ? { cost: values.preShipCostCents } : {}),
        ...(can('product.price.view') ? { salePrice: saleMissing || !lines.length ? null : sumUnitCents(saleParts) } : {}),
      };
    })) };
  }

  private async resolveLines(em: EntityManager, user: AuthUser, lines: LineInput[]) {
    if (!lines.length) throw new BadRequestException('请先添加组合构成');
    const mains: { bc: ResourceRecord; qty: number }[] = [];
    const gifts: { bc: ResourceRecord; qty: number }[] = [];
    for (const l of lines) {
      if (!(l.qty > 0)) throw new BadRequestException('数量必须大于 0');
      if (l.role === 'labor') continue;
      if(l.productId!=null){if(['main','gift'].includes(l.role))throw new BadRequestException('主商品和赠品必须选择已验证基础编码');await normalizeBundleComponent(em,this.resources,user,l as unknown as Record<string,unknown>);continue;}
      const bc = await em.findOne(ResourceRecord, { where: { id: Number(l.baseCodeId), companyId: user.companyId, type: 'finance-base-codes' } });
      if (!bc) throw new BadRequestException('构成里有基础编码不存在');
      if (bc.status !== 'verified') throw new BadRequestException(`基础编码「${bc.title}」还没验证，验证通过后才能加入组合`);
      if (l.role === 'main') mains.push({ bc, qty: l.qty });
      if (l.role === 'gift') gifts.push({ bc, qty: l.qty });
    }
    if (!mains.length) throw new BadRequestException('至少要有一个主品');
    return { mains, gifts };
  }

  /** 跨平台复用绑定同公司当前源BOM，客户端组成不能替换实际来源。 */
  private async reuseSource(em:EntityManager,user:AuthUser,lines:LineInput[],targets:TargetInput[],lock=false){
    const sourced=targets.filter(target=>target.sourceBundleId!==undefined);if(!sourced.length)return{lines,targets};
    if(sourced.length!==targets.length||new Set(sourced.map(target=>target.sourceBundleId)).size!==1)throw new BadRequestException('一次只能复用同一源组合');
    if(!createChecker(user.permissions)('resource.finance-bundles.view'))throw new ForbiddenException('没有查看源组合的权限');
    const id=sourced[0].sourceBundleId;if(!Number.isSafeInteger(id)||!id||id<=0)throw new BadRequestException('源组合无效');
    if(lock)await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
    const source=await em.findOne(ResourceRecord,{where:{companyId:user.companyId,type:TYPE,id},...(lock?{lock:{mode:'pessimistic_write' as const}}:{})});
    if(!source||source.archivedAt||source.status==='archived')throw new NotFoundException('源组合不存在或已归档');
    const records=await this.lineRecords(em,user,source.id),token=bundleCompositionToken(source,records);
    if(sourced.some(target=>target.sourceToken!==token))throw new ConflictException('原组合或BOM已变化，请重新打开跨平台复用');
    return{lines:records.map(record=>pickLine(record.data) as unknown as LineInput),targets:targets.map(target=>({...target,bundleCategoryId:num(source.data.bundleCategoryId)??target.bundleCategoryId,brandId:num(source.data.brandId)??target.brandId,baseUnit:str(source.data.baseUnit)||target.baseUnit,...(str(source.data.manualPropertiesValue)?{manualPropertiesValue:str(source.data.manualPropertiesValue),manualReason:target.manualReason||str(source.data.manualReason)}:{}),...(source.data.weightMode==='manual'?{weightMode:'manual' as const,manualWeightG:num(source.data.manualWeightG)??undefined,overrideReason:str(source.data.overrideReason)}:{})}))};
  }

  /**
   * 保存前检查：每个“平台 + 场景”算出编码和名称，并做重复检查。
   * 同一构成、同平台同场景已有的组合直接复用；编码撞上本地组合、本地基础编码、聚水潭普通商品、聚水潭组合装任何一层都算重复。
   */
  async preview(user: AuthUser, lines: LineInput[], targets: TargetInput[], em: EntityManager = this.ds.manager) {
    ({lines,targets}=await this.reuseSource(em,user,lines,targets));
    if (!targets.length) throw new BadRequestException('请至少选一个销售平台和销售场景');
    const seen = new Set<string>();
    for (const t of targets) {
      const k = `${t.platformId}:${t.scenarioId}:${t.configNo || '01'}`;
      if (seen.has(k)) throw new BadRequestException('同一个销售平台和销售场景不能重复选');
      seen.add(k);
    }
    const { mains, gifts } = await this.resolveLines(em, user, lines);
    const facts=await costCompositionFacts(em,user.companyId,{weightMode:'auto'},lines as unknown as Record<string,unknown>[]);
    const productId = num(mains[0].bc.data.productId);
    const source = productId !== null && Number.isSafeInteger(productId) && productId > 0 ? await em.findOne(ResourceRecord, { where: { id: productId, companyId: user.companyId, type: 'finance-products' } }) : null;
    const independent=mains[0].bc.data.codeDictionaryCategoryId;
    const sourceRules=await codeCategoryRuleSet(this.resources,em,user.companyId,[...mains,...gifts].map(row=>row.bc),true);
    const rule=independent!=null?sourceRules?.[mains[0].bc.id]??null:await findNamingRule(this.resources,em,user.companyId,source?.data.categoryId);
    const mySig = sigOf(...lines.map(lineKey).sort());
    const allBundles = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: TYPE } });
    const allLines = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-bundle-lines' } });
    const linesOf = new Map<number, LineInput[]>();
    for (const l of allLines) {
      const arr = linesOf.get(Number(l.data.bundleId)) ?? [];
      arr.push({ role: str(l.data.role), baseCodeId: num(l.data.baseCodeId) ?? undefined, productId:num(l.data.productId)??undefined, laborId: num(l.data.laborId) ?? undefined, qty: Number(l.data.qty) });
      linesOf.set(Number(l.data.bundleId), arr);
    }
    const out = [];
    for (const t of targets) {
      const platform = await em.findOne(ResourceRecord, { where: { id: t.platformId, companyId: user.companyId, type: 'finance-platforms' } });
      const scenario = await em.findOne(ResourceRecord, { where: { id: t.scenarioId, companyId: user.companyId, type: 'finance-scenarios' } });
      if (!platform || !scenario) throw new BadRequestException('销售平台或销售场景不存在');
      if (platform.status !== 'active') throw new BadRequestException('销售平台已停用');
      if (scenario.status !== 'active') throw new BadRequestException('销售场景已停用');
      if (t.brandId !== undefined) {
        const brand = await em.findOne(ResourceRecord, { where: { id: t.brandId, companyId: user.companyId, type: 'finance-brands' } });
        if (!brand || brand.status !== 'active') throw new BadRequestException('组合品牌不存在或已停用');
      }
      const profile=bundleGenerationProfile(user,t);
      const configNo = t.configNo || '01';
      const naming=await namingInputFor(em,user.companyId,mains,gifts,platform,scenario,configNo,t.brandId);
      naming.itemRules=sourceRules;
      const auto = composeBundle(rule,naming);
      // 新建时手填的编码/名称/简称覆盖自动生成的值（和“改码/改名”同一套规则：必须写原因）
      const manualCode = (t.manualCode ?? '').trim().toUpperCase(), manualName = (t.manualName ?? '').trim(), manualShort = (t.manualShortName ?? '').trim();
      const manualErrors = (manualCode || manualName || manualShort) && (t.manualReason ?? '').trim().length < 2 ? ['手填编码、名称或简称必须写明原因'] : [];
      const composed = { ...auto, code: manualCode || auto.code, name: manualName || auto.name, styleCode:str(profile.manualStyleCode)||auto.styleCode, mainStyleCode:resolvedMainStyleCode(auto,str(profile.manualStyleCode)), propertiesValue:str(profile.manualPropertiesValue)||auto.propertiesValue, shortName: manualShort || auto.shortName, errors: [...auto.errors, ...manualErrors] };
      if(sourceRules){for(const [value,label,limit] of [[composed.code,'组合品编码',48],[composed.styleCode,'组合品款式编码',48],[composed.name,'组合品名称',255],[composed.shortName,'组合品简称',160],[composed.propertiesValue,'组合品规格',255]] as const)if(value.length>limit)composed.errors.push(`${label}不能超过${limit}个字符`);}
      const reuse = allBundles.find((b) => b.status !== 'archived' && b.data.platformId === platform.id && b.data.scenarioId === scenario.id && str(b.data.configNo || '01') === configNo
        && (num(b.data.brandId) ?? null) === (t.brandId ?? null)
        && Object.entries(profile).filter(([key])=>!['manualReason','overrideReason'].includes(key)).every(([key,value])=>b.data[key]===value)
        && sigOf(...(linesOf.get(b.id) ?? []).map(lineKey).sort()) === mySig);
      const layers: { layer: string; label: string; hit: string }[] = [];
      if (!reuse) {
        const key = composed.code.toLowerCase();
        const byCode = async (type: string) => em.findOne(ResourceRecord, { where: { companyId: user.companyId, type, uniqueKey: key } });
        const b = await byCode(TYPE);
        if (b) layers.push({ layer: 'bundle', label: '本地组合编码', hit: b.title });
        const bc = await byCode('finance-base-codes');
        if (bc) layers.push({ layer: 'baseCode', label: '本地基础编码', hit: bc.title });
        const jst = await byCode('finance-jst-skus');
        if (jst) layers.push(jst.data.goodsType === 'combine' ? { layer: 'jstCombine', label: '聚水潭组合装', hit: jst.title } : { layer: 'jstNormal', label: '聚水潭普通商品', hit: jst.title });
      }
      out.push({
        platformId: platform.id, platformName: platform.title, scenarioId: scenario.id, scenarioName: scenario.title, configNo,
        code: composed.code, name: composed.name, styleCode: composed.styleCode, mainStyleCode:composed.mainStyleCode, shortName: composed.shortName, propertiesValue:composed.propertiesValue, baseUnit:str(profile.baseUnit)||naming.mains[0]?.unitName||'', weightG:profile.weightMode==='manual'?profile.manualWeightG:facts.weightG, ...(this.canCost(user)?{cost:facts.preShipCostCents}:{}),
        reuse: reuse ? { id: reuse.id, code: str(reuse.data.code), status: reuse.status } : null,
        duplicates: layers,
        errors: composed.errors,
        ok: (!!reuse || layers.length === 0) && composed.errors.length === 0,
      });
    }
    return { targets: out, namingRule: !!rule };
  }

  /** 一次生成多个平台的组合：全部通过检查才保存，保存在同一个事务里，要么全成要么全不成。已有同构成同平台的直接复用。 */
  async generate(user: AuthUser, lines: LineInput[], targets: TargetInput[], outer?: EntityManager) {
    // 传入 outer 表示已经在别人的事务里（如流程引擎），和它同成同败；不传则自己开事务
    const run = <T>(fn: (em: EntityManager) => Promise<T>) => (outer ? fn(outer) : this.ds.transaction(fn));
    return run(async (em) => {
      await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
      ({lines,targets}=await this.reuseSource(em,user,lines,targets,true));
      const pre = await this.preview(user, lines, targets, em);
      const bad = pre.targets.find((t) => !t.ok);
      if (bad?.errors.length) throw new BadRequestException(bad.errors.join('；'));
      if (bad) throw new ConflictException(`「${bad.code}」重复：${bad.duplicates.map((d) => `${d.label}「${d.hit}」`).join('、')}`);
      let definitionSource:number|undefined=targets[0]?.sourceBundleId;
      const created: { id: number; code: string; reused: boolean }[] = [];
      for (const t of pre.targets) {
        if (t.reuse) { created.push({ id: t.reuse.id, code: t.reuse.code, reused: true }); continue; }
        const src = targets.find((x) => x.platformId === t.platformId && x.scenarioId === t.scenarioId);
        const manual=src?bundleGenerationProfile(user,src):{};
        const b = await this.resources.createRecord(em, user, TYPE, { platformId: t.platformId, scenarioId: t.scenarioId, configNo: t.configNo, bundleCategoryId: src?.bundleCategoryId, brandId: src?.brandId, ...manual }, '批量生成组合');
        await buildBundleLines(this.resources as never, em, user, b.id, async () => {
          for (const l of lines) await this.resources.createRecord(em, user, 'finance-bundle-lines', { bundleId: b.id, ...pickLine(l as never), sortOrder: undefined }, '批量生成组合');
        });
        if(definitionSource){const source=await this.load(em,user,definitionSource),bom=await captureBomVersion(this.resources,em,user,source.id,{unknown:!source.data.bomVersionId});if(bom)await this.resources.patchData(em,user,TYPE,b.id,{bomDefinitionKey:bom.data.definitionKey,bomVersionId:bom.id,bomVersion:bom.data.versionNo||null},'同一真实来源复用BOM',true);}else{await captureBomVersion(this.resources,em,user,b.id,{initial:true});definitionSource=b.id;}
        const fresh = await this.load(em, user, b.id);
        created.push({ id: b.id, code: str(fresh.data.code), reused: false });
      }
      return { created };
    });
  }

  /** 命名草稿只读预览上下文：只返回现有白名单命名字段，不含成本、价格或验证快照。 */
  async namingSample(user:AuthUser,baseCodeId:number,qty:number){
    if(!createChecker(user.permissions)('resource.finance-base-codes.view'))throw new ForbiddenException('没有查看商品基础编码的权限');
    if(!Number.isSafeInteger(baseCodeId)||baseCodeId<=0||!Number.isFinite(qty)||qty<=0)throw new BadRequestException('预览商品或件数无效');
    try{scaledDecimal(qty,6);}catch{throw new BadRequestException('预览件数最多六位小数');}
    const base=await this.ds.manager.findOne(ResourceRecord,{where:{id:baseCodeId,companyId:user.companyId,type:'finance-base-codes'}});
    if(!base||base.archivedAt||base.status!=='verified')throw new NotFoundException('预览商品不存在或尚未验证');
    const productId=num(base.data.productId),product=productId?await this.ds.manager.findOne(ResourceRecord,{where:{id:productId,companyId:user.companyId,type:'finance-products'}}):null;
    const brandId=['composed','external_import'].includes(str(base.data.origin))?num(base.data.codeBrandId):num(product?.data.brandId);
    return{input:await namingInputFor(this.ds.manager,user.companyId,[{bc:base,qty}],[],null,null,'01'),brandId,platformId:num(base.data.platformId)};
  }

  // ---------- 构成修订 ----------

  async composition(user:AuthUser,id:number){
    return this.ds.transaction(async em=>{
      const bundle=await this.load(em,user,id),records=await this.lineRecords(em,user,id),lines=records.map(row=>pickLine(row.data));
      const {costCompositionFacts}=await import('./cost-components');const current=await costCompositionFacts(em,user.companyId,bundle.data,lines);
      const units=await loadUnitLists(em,user.companyId),unitField=getResourceDef('finance-bundle-lines')!.fields.find(field=>field.key==='unit')!;
      const baseUnits:Record<number,{unit:string;label:string;available:boolean}>={};
      if(createChecker(user.permissions)('resource.finance-base-codes.view')){
        const bases=await em.find(ResourceRecord,{where:{companyId:user.companyId,type:'finance-base-codes'}}),byId=new Map(bases.map(row=>[row.id,row]));
        const products=await em.createQueryBuilder(ResourceRecord,'p').select('p.id','id').addSelect("COALESCE(NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p.data,'$.specUnit')),'null'),''),NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p.data,'$.purchaseSpec')),'null'))",'unit').where('p.companyId=:companyId AND p.type=:type',{companyId:user.companyId,type:'finance-products'}).getRawMany<{id:number;unit:string|null}>(),productUnits=new Map(products.map(row=>[Number(row.id),row.unit||'']));
        for(const row of bases.filter(row=>row.status==='verified'&&!row.archivedAt)){const real=typeof row.data.canonicalId==='number'?byId.get(row.data.canonicalId):row;const unit=str(row.data.baseUnit)||str(row.data.codeSpecUnit)||(['composed','external_import'].includes(str(real?.data.origin))?str(real?.data.codeSpecUnit):productUnits.get(Number(real?.data.productId))||'');baseUnits[row.id]={unit,label:unitLabelFor(units,unitField,{},unit),available:!!real&&real.status==='verified'&&!real.archivedAt&&!!unit};}
      }
      const facts:Record<string,{title:string;code:string;unit:string;weightG:number|null;available:boolean}>={};
      for(const [index,line]of lines.entries()){
        const kind=line.laborId?'labor':line.productId?'archive':'base',type=kind==='labor'?'finance-labor-costs':kind==='archive'?'finance-products':'finance-base-codes',sourceId=Number(line.laborId??line.productId??line.baseCodeId);
        const source=await em.findOne(ResourceRecord,{where:{companyId:user.companyId,type,id:sourceId}});
        facts[`${kind}:${sourceId}`]={title:source?(kind==='base'?str(source.data.name)||source.title:kind==='labor'?str(source.data.workName)||source.title:str(source.data.name)||source.title):records[index].title,code:str(source?.data.code)||str(source?.data.workCode),unit:kind==='labor'?source?await bundleLaborUnit(em,user.companyId,source):'':unitLabelFor(units,unitField,line,line.unit||(kind==='base'?baseUnits[sourceId]?.unit:source?.data.specUnit)),weightG:current.lines[index]?.unitWeightG??null,available:!!source&&!source.archivedAt&&source.status===(kind==='base'?'verified':'active')};
      }
      const revisions=(await this.resources.findWhere(em,user.companyId,'finance-bundle-revisions','bundleId',id)).sort((a,b)=>b.id-a.id),pending=revisions.find(row=>row.id===bundle.data.pendingRevisionId&&row.status==='pending');
      const parsed=pending?readRevisionPayload(pending.data.payload):null;
      return {referenceDetail:await deriveBundleReferenceDetail(em,user,bundle,records),baseUnits,sourceToken:bundleCompositionToken(bundle,records),profile:Object.fromEntries(['code','name','shortName','bomVersion','weightMode'].map(key=>[key,bundle.data[key]])),lines:lines.map((line,index)=>({...line,label:facts[`${line.laborId?'labor':line.productId?'archive':'base'}:${line.laborId??line.productId??line.baseCodeId}`]?.title||records[index].title})),facts,weightG:current.weightG,weightMode:bundle.data.weightMode==='manual'?'manual':'auto',canManualWeight:createChecker(user.permissions)('product.cost.edit'),pending:pending&&parsed?{id:pending.id,reason:str(pending.data.reason),lines:parsed.lines,...(parsed.weight?{weightG:parsed.weight.grams,weightMode:parsed.weight.mode}:{})}:null,history:revisions.map(row=>({id:row.id,status:row.status,reason:str(row.data.reason),createdAt:row.createdAt}))};
    });
  }

  async bomVersions(user:AuthUser,id:number){const bundle=await this.load(this.ds.manager,user,id);return listBomVersions(this.ds.manager,user,bundle,this.resources);}

  async createRevision(user: AuthUser, bundleId: number, reason: string, lines: LineInput[], facts?:{sourceToken:string;weight?:RevisionWeight}) {
    if (await this.pendingJobs(user, bundleId)) throw new ConflictException('这个组合还有没发送完的聚水潭同步任务，请等它发完再改构成');
    const cur = await this.load(this.ds.manager, user, bundleId);
    const app = await unfinishedApplications(this.ds.manager, user.companyId, cur, await this.lineRecords(this.ds.manager, user, bundleId));
    if (app) throw new ConflictException(`有还没办完的 SKU 批量申请（#${app.runId}）用到了这个组合，请等申请办完或撤销后再改构成`);
    return this.ds.transaction(async (em) => {
      await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
      const locked=await em.findOne(ResourceRecord,{where:{id:bundleId,type:TYPE,companyId:user.companyId},lock:{mode:'pessimistic_write'}});if(!locked)throw new NotFoundException('组合不存在');
      const current=await this.lineRecords(em,user,bundleId);
      const payload={version:1,lines,sourceToken:facts?.sourceToken??bundleCompositionToken(locked,current),...(facts?.weight?{weight:facts.weight}:{})};
      const r = await this.resources.createRecord(em, user, 'finance-bundle-revisions', { bundleId, reason, payload: JSON.stringify(payload) }, '提交构成修订');
      return { id: r.id };
    });
  }

  async cancelRevision(user: AuthUser, bundleId: number, reason: string) {
    if (reason.trim().length < 2) throw new BadRequestException('取消修订必须写明原因');
    const b = await this.load(this.ds.manager, user, bundleId);
    const id = num(b.data.pendingRevisionId);
    if (!id) throw new BadRequestException('这个组合没有待发布的修订');
    await this.resources.changeStatus(user, 'finance-bundle-revisions', id, 'cancelled', reason.trim());
    return { ok: true };
  }

  // ---------- 核对与验证 ----------

  private async currentLines(em: EntityManager, user: AuthUser, b: ResourceRecord): Promise<{ lines: LineInput[]; revision: ResourceRecord | null }> {
    const revId = num(b.data.pendingRevisionId);
    const revision = revId ? await em.findOne(ResourceRecord, { where: { id: revId, companyId: user.companyId, type: 'finance-bundle-revisions' } }) : null;
    if (revision && revision.status === 'pending') return { lines: readRevisionPayload(revision.data.payload).lines as unknown as LineInput[], revision };
    const lines = (await this.lineRecords(em, user, b.id)).map((l) => pickLine(l.data) as unknown as LineInput);
    return { lines, revision: null };
  }

  async report(user: AuthUser, id: number, em: EntityManager = this.ds.manager, context?:{pricing:CostService;pricingData:Awaited<ReturnType<CostService['load']>>}) {
    const b = await this.load(em, user, id);
    const cost = this.canCost(user);
    const { lines, revision } = await this.currentLines(em, user, b);
    const prospective=Object.assign(new ResourceRecord(),b,{data:{...b.data,...(revision?revisionWeightPatch(readRevisionPayload(revision.data.payload),revision.data.reason):{})}});
    const pricing = context?.pricing??new CostService(this.ds);
    const pricingData = context?.pricingData??await pricing.load(user.companyId, em);
    const values = pricing.row({ ...pricingData, lines: lines.map((l, i) => em.create(ResourceRecord, { id: i + 1, companyId: user.companyId, type: 'finance-bundle-lines', data: { ...l, bundleId: b.id } })) }, prospective);
    const units = await loadUnitLists(em, user.companyId);
    const unitField = getResourceDef('finance-bundle-lines')!.fields.find(f => f.key === 'unit')!;
    const issues: string[] = [];
    if (!lines.some((l) => l.role === 'main')) issues.push('还没有主品');
    const components: Array<Record<string, unknown>> = [];
    const totalWeight = values.weightG ?? 0, totalCost = values.preShipCostCents;
    for (const [index, l] of lines.entries()) {
      const priced = values.lines[index];
      if (l.role === 'labor') {
        const lab = pricingData.labor.get(Number(l.laborId));
        components.push({ role: l.role, code: '', name: lab?.title ?? '已删除的人工项目', qty: l.qty, weightG: null, cost: cost ? priced.unitCostCents : undefined, unit: lab?await bundleLaborUnit(em,user.companyId,lab):'', includeInJst: false, isRequired: l.isRequired !== false, costTreatment: str(l.costTreatment) || 'include' });
        continue;
      }
      if (typeof l.productId === 'number') {
        const product=pricingData.products.get(l.productId);
        if(!product)issues.push('构成里的商品档案已被删除');
        components.push({role:l.role,productId:l.productId,sourceType:'product_archive',code:str(product?.data.code),name:product?.title || '已删除的商品档案',qty:l.qty,weightG:priced.unitWeightG,cost:cost?priced.unitCostCents:undefined,unit:unitLabelFor(units,unitField,l as unknown as Record<string,unknown>,l.unit),includeInJst:l.includeInJst===true,isRequired:l.isRequired!==false,lossRate:l.lossRate??0,costBucket:str(l.costBucket),costTreatment:str(l.costTreatment)||'include'});
        continue;
      }
      const bc = pricingData.baseCodes.get(num(l.baseCodeId) ?? -1);
      if (!bc) { issues.push('构成里有基础编码已被删除'); continue; }
      if (bc.status !== 'verified') issues.push(`基础编码「${bc.title}」还没验证`);
      components.push({ role: l.role, code: str(bc.data.code), name: str(bc.data.name) || bc.title, qty: l.qty, weightG: priced.unitWeightG, cost: cost ? priced.unitCostCents : undefined, unit: unitLabelFor(units, unitField, l as unknown as Record<string, unknown>, l.unit), includeInJst: l.includeInJst === true, isRequired: l.isRequired !== false, lossRate: l.lossRate ?? 0, costBucket: str(l.costBucket), costTreatment: str(l.costTreatment) || 'include' });
    }
    // 旧系统验证问题清单：分类、必填文本、单位、成本、重量、进聚水潭行等一次列全
    const platformId = num(b.data.platformId);
    const platform = platformId === null ? null : await em.findOne(ResourceRecord, { where: { id: platformId, companyId: user.companyId, type: 'finance-platforms' } });
    for (const m of await bundleIssues(em, user.companyId, prospective.data, lines as never, platform?.status)) if (!issues.includes(m)) issues.push(m);
    const snapJson = await bundleSnapshotJson(em, user.companyId, prospective.data, lines as never);
    const stored = this.parse(b.data.snapshot);
    const now = JSON.parse(snapJson) as BundleSnap;
    let changes = stored ? this.diff(stored, now) : [];
    const restricted=restrictedFieldKeys(getResourceDef(TYPE)!,createChecker(user.permissions));
    changes=changes.filter(change=>!restricted.has(change.field)&&(cost||!COST_FIELDS.has(change.field)));
    const uploaded = str(b.data.jstUploadedCode);
    const outbound = { sku_id: str(b.data.code), i_id: str(b.data.styleCode), name: str(b.data.name), short_name: str(b.data.shortName), weight: Math.round(totalWeight * 1000) / 1_000_000, cost_price: cost ? totalCost == null ? null : totalCost / 100 : undefined };
    return {
      id: b.id, code: str(b.data.code), name: str(b.data.name), styleCode: str(b.data.styleCode), shortName: str(b.data.shortName), status: b.status,
      components, totalWeightG: Math.round(totalWeight * 1e6) / 1e6, totalCost: cost ? totalCost : undefined,
      pendingRevision: revision ? { id: revision.id, reason: str(revision.data.reason) } : null,
      signature: sigOf(snapJson, b.status),
      issues, secondVerification: codeVerificationState(b) === 'reverify', baselineMissing: codeVerificationState(b) === 'reverify' && !stored, changes,
      outbound, uploadSignature: sigOf(JSON.stringify({ ...outbound, cost_price: undefined, lines: lines.map(lineKey).sort() })),
      uploadedCode: uploaded || null, replacing: !!uploaded && uploaded !== str(b.data.code), jstStatus: str(b.data.jstStatus) || 'not_synced',
    };
  }

  private parse(text: unknown): BundleSnap | null {
    if (typeof text !== 'string' || !text) return null;
    try { const s = JSON.parse(text) as BundleSnap; return s && Array.isArray(s.lines) ? s : null; } catch { return null; }
  }

  private diff(before: BundleSnap, after: BundleSnap) {
    const out: { source: string; field: string; label: string; before: unknown; after: unknown }[] = [];
    const push = (source: string, field: string, label: string, b: unknown, a: unknown) => { if (JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)) out.push({ source, field, label, before: b ?? null, after: a ?? null }); };
    const labels: Record<string, string> = { code: '组合编码', name: '组合名称', styleCode: '款式编码', shortName: '简称', weightMode: '重量方式', manualWeightG: '手工重量(克)', propertiesValue: '规格', baseUnit: '计量单位', bundleCategoryId: '组合分类', brandId: '品牌', varietyName: '品种', configNo: '配置号', bomVersion: '构成版本号', bomEffectiveFrom: '构成生效日', bomEffectiveTo: '构成失效日' };
    for (const k of Object.keys(labels)) push('组合', k, labels[k], before.profile[k], after.profile[k]);
    const key = (l: SnapLine) => `${l.role}|${l.ref}`;
    const was = new Map(before.lines.map((l) => [key(l), l]));
    const now = new Map(after.lines.map((l) => [key(l), l]));
    for (const [k, a] of now) {
      const b = was.get(k);
      if (!b) { out.push({ source: a.ref, field: 'line', label: '新增的构成', before: null, after: `${a.ref} ×${a.qty}` }); continue; }
      push(a.ref, 'qty', '数量', b.qty, a.qty);
      push(a.ref, 'weightG', '重量(克)', b.weightG, a.weightG);
      push(a.ref, 'cost', '成本', b.cost, a.cost);
      for (const [field, label] of Object.entries({ unit: '单位', lossRate: '损耗率', isRequired: '必需', includeInJst: '进入聚水潭组合装', costBucket: '成本归集', costTreatment: '成本处理', sortOrder: '排序', effectiveFrom: '生效日', effectiveTo: '失效日', note: '备注' })) push(a.ref, field, label, b[field], a[field]);
    }
    for (const [k, b] of was) if (!now.has(k)) out.push({ source: b.ref, field: 'line', label: '去掉的构成', before: `${b.ref} ×${b.qty}`, after: null });
    return out;
  }

  async verify(user: AuthUser, items: { id: number; signature: string; uploadSignature?: string }[], opts: { confirmed: boolean; syncToJst: boolean; replaceConfirmed?: boolean }) {
    if (!opts.confirmed) throw new BadRequestException('请先勾选“已核对”');
    if (!items.length) throw new BadRequestException('没有要验证的组合');
    if (opts.syncToJst) this.outbox.needBundles(user);
    const results: { id: number; ok: boolean; error?: string; queued?: boolean }[] = [];
    for (const it of items) {
      try {
        const rep = await this.report(user, it.id);
        if (!['pending', 'reverify'].includes(rep.status)) throw new BadRequestException('这条已经验证过了');
        if (rep.signature !== it.signature) throw new ConflictException('核对之后资料又变了，请重新核对');
        if (rep.issues.length) throw new BadRequestException(rep.issues[0]);
        if (rep.pendingRevision) {
          // 发布构成修订：有还没办完的 SKU 申请用到旧构成时拦住，避免申请办到一半构成变了
          const cur = await this.load(this.ds.manager, user, it.id);
          const app = await unfinishedApplications(this.ds.manager, user.companyId, cur, await this.lineRecords(this.ds.manager, user, it.id));
          if (app) throw new ConflictException(`有还没办完的 SKU 批量申请（#${app.runId}）用到了这个组合，请等申请办完或撤销后再发布修订`);
        }
        if (opts.syncToJst && rep.uploadSignature !== it.uploadSignature) throw new ConflictException('要上传的内容在核对之后变了，请重新核对');
        await this.ds.transaction(async em => {
          await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
          const locked = await em.findOne(ResourceRecord, { where: { id: it.id, companyId: user.companyId, type: TYPE }, lock: { mode: 'pessimistic_write' } });
          if (!locked || !['pending', 'reverify'].includes(locked.status)) throw new ConflictException('组合状态已变化，请刷新后核对');
          const fresh = await this.report(user, it.id, em);
          if (fresh.signature !== it.signature || opts.syncToJst && fresh.uploadSignature !== it.uploadSignature) throw new ConflictException('核对之后资料又变了，请重新核对');
          if (fresh.issues.length) throw new BadRequestException(fresh.issues[0]);
          await this.resources.setStatusChecked(em, user, TYPE, it.id, 'verified');
          await registerCostSnapshots(em, user.companyId, user.id, [it.id], '验证通过', 'workflow_publish');
        });
        let queued = false;
        if (opts.syncToJst) queued = (await this.outbox.enqueue(user, TYPE, [it.id], { replaceConfirmed: opts.replaceConfirmed })).queued > 0;
        results.push({ id: it.id, ok: true, queued });
      } catch (e) { results.push({ id: it.id, ok: false, error: (e as Error).message }); }
    }
    return { results, verified: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }

  // ---------- 删除与归档 ----------

  private async deletable(em: EntityManager, user: AuthUser, b: ResourceRecord) {
    if (b.data.verifiedAt || b.data.snapshot || b.data.jstUploadedCode || ['synced', 'pending', 'failed'].includes(str(b.data.jstStatus)) || ['verified', 'reverify', 'archived'].includes(b.status)) return '验证过或同步过聚水潭的组合不能直接删除，请改为“失效归档”';
    const [{ n }] = await em.query('SELECT COUNT(*) AS n FROM finance_cost_snapshots WHERE company_id = ? AND bundle_id = ?', [user.companyId, b.id]);
    if (Number(n) > 0) return '这个组合已有成本历史记录，不能直接删除，请改为“失效归档”';
    return '';
  }

  async deletionPreview(user: AuthUser, id: number, em: EntityManager = this.ds.manager) {
    const b = await this.load(em, user, id);
    const reason = await this.deletable(em, user, b);
    const lines = await this.lineRecords(em, user, id);
    const revisionId = num(b.data.pendingRevisionId);
    const revision = revisionId ? await em.findOne(ResourceRecord, { where: { id: revisionId, companyId: user.companyId, type: 'finance-bundle-revisions' } }) : null;
    const token = sigOf('bundle-del', b.id, b.status, b.updatedAt ? new Date(b.updatedAt).getTime() : 0, JSON.stringify(b.data),
      JSON.stringify(lines.map(line => [line.id, line.status, line.data])), JSON.stringify(revision ? [revision.id, revision.status, revision.data] : null));
    return { id, code: str(b.data.code), name: str(b.data.name), canDelete: !reason, reason, token };
  }

  async deletionExecute(user: AuthUser, id: number, token: string, confirmCode: string, reason: string) {
    if (reason.trim().length < 2) throw new BadRequestException('必须写明删除原因');
    return this.ds.transaction(async em => {
      await em.findOneOrFail(Company, { where: { id: user.companyId }, lock: { mode: 'pessimistic_write' } });
      const bundle = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type: TYPE }, lock: { mode: 'pessimistic_write' } });
      if (!bundle) throw new NotFoundException('组合不存在');
      const pre = await this.deletionPreview(user, id, em);
      if (pre.token !== token) throw new ConflictException('资料在预览之后变了，请重新预览');
      if (!pre.canDelete) throw new BadRequestException(pre.reason);
      if (confirmCode.trim().toUpperCase() !== pre.code.toUpperCase()) throw new BadRequestException('请完整输入要删除的组合编码来确认');
      for (const line of await this.lineRecords(em, user, id)) await this.resources.removeRecord(em, user, 'finance-bundle-lines', line.id, reason.trim(), [], true);
      const pend = num((await this.load(em, user, id)).data.pendingRevisionId);
      if (pend) await this.resources.removeRecord(em, user, 'finance-bundle-revisions', pend, reason.trim(), [], true);
      await this.resources.removeRecord(em, user, TYPE, id, reason.trim(), [], true);
      return { ok: true };
    });
  }

  /** 失效归档：组合不再使用。上传过聚水潭的，同时把“停用旧编码”加入出站队列（需要确认，且只有管理员能做）。 */
  /** 还在队列里（待发送/发送中）的上传任务：这时改构成、归档都会和队列里的内容打架 */
  private async pendingJobs(user: AuthUser, id: number, em = this.ds.manager) {
    const [{ n }] = await em.query("SELECT COUNT(*) AS n FROM outbox_jobs WHERE company_id = ? AND resource_type = ? AND resource_id = ? AND status IN ('pending', 'sending')", [user.companyId, TYPE, id]);
    return Number(n);
  }

  async archive(user: AuthUser, id: number, reason: string, disableConfirmed: boolean) {
    if (reason.trim().length < 2) throw new BadRequestException('必须写明归档原因');
    return this.ds.transaction(async em => {
      await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
      const b = await em.findOne(ResourceRecord,{where:{id,companyId:user.companyId,type:TYPE},lock:{mode:'pessimistic_write'}});
      if (!b) throw new NotFoundException('组合编码不存在');
      if (b.status === 'archived') throw new BadRequestException('已经归档了');
      if (await this.pendingJobs(user, id, em)) throw new ConflictException('这个组合还有没发送完的聚水潭同步任务，请先等它发完或在同步队列里取消');
      if (b.data.jstPriceStatus==='confirming' || (b.data.jstStatus==='failed' && str(b.data.jstMessage).startsWith('结果未知：'))) {
        throw new ConflictException('这个组合还有待确认的聚水潭写入结果，请先核对后再归档');
      }
      if (num(b.data.pendingRevisionId)) throw new ConflictException('这个组合有待发布的构成修订，请先发布或取消修订');
      const synced = !!str(b.data.jstUploadedCode);
      if (synced && !disableConfirmed) throw new BadRequestException('这个组合上传过聚水潭，需要确认“同时在聚水潭停用它”');
      if (synced && !this.outbox.canBundles(user)) throw new ForbiddenException('上传过聚水潭的组合，只有公司管理员或有「组合装同步维护」权限的人能归档');
      const app = await unfinishedApplications(em, user.companyId, b, await this.lineRecords(em, user, id));
      if (app) throw new ConflictException(`有还没办完的 SKU 批量申请（#${app.runId}）用到了这个组合，请等申请办完或撤销后再归档`);
      const disable = synced ? await this.outbox.enqueueDisable(user, TYPE, id, reason.trim(), em) : null;
      if (disable && !disable.jobId) throw new ConflictException('聚水潭停用任务无法关联，请重新核对后再归档');
      await this.resources.changeStatusRecord(em, user, TYPE, id, 'archived', reason.trim());
      if (disable) await this.outbox.recordArchiveJob(user, { id, code: str(b.data.jstUploadedCode), name: str(b.data.name) }, reason.trim(), disable, em);
      return { ok: true, disableQueued: disable?.queued ?? false };
    });
  }

  // ---------- 改了命名规则后：按新规则批量重生成编码（要预览、要写原因、要确认，不会自动改） ----------

  /** 现在的命名规则下，哪些组合的编码/名称和已有的不一样（只算，不写） */
  async regeneratePreview(user: AuthUser) {
    const em = this.ds.manager;
    const all = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: TYPE } });
    const rows: Array<{ id: number; status: string; oldCode: string; newCode: string; oldName: string; newName: string; uploadedCode: string | null; token: string; error: string | null; blocked: string | null }> = [];
    for (const b of all.filter((x) => ['pending', 'verified', 'reverify'].includes(x.status)).sort((a, c) => a.id - c.id)) {
      let out: Awaited<ReturnType<typeof composeBundleFor>> = null;
      let error: string | null = null;
      try { out = await composeBundleFor(this.resources, em, user, b); } catch (e) { error = (e as Error).message; }
      if (!error && !out) continue;
      const oldCode = str(b.data.code), oldName = str(b.data.name);
      const newCode = out ? str(out.patch.code) : oldCode, newName = out ? str(out.patch.name) : oldName;
      if (!error && newCode === oldCode && newName === oldName) continue;
      const blocked = (await this.pendingJobs(user, b.id)) ? '还有没发送完的聚水潭同步任务' : num(b.data.pendingRevisionId) ? '有待发布的构成修订' : (await unfinishedApplications(em, user.companyId, b, await this.lineRecords(em, user, b.id))) ? '有还没办完的 SKU 批量申请用到它' : null;
      rows.push({ id: b.id, status: b.status, oldCode, newCode, oldName, newName, uploadedCode: str(b.data.jstUploadedCode) || null, token: sigOf('bundle-regen', b.id, oldCode, newCode, oldName, newName), error, blocked });
    }
    return { rows };
  }

  async regenerateExecute(user: AuthUser, items: { id: number; token: string }[], reason: string, confirmed: boolean) {
    if (reason.trim().length < 2) throw new BadRequestException('批量重生成编码必须写明原因');
    if (confirmed !== true) throw new BadRequestException('请先确认要按新规则重新生成这些组合的编码');
    const current = new Map((await this.regeneratePreview(user)).rows.map((r) => [r.id, r]));
    const results: { id: number; ok: boolean; error?: string; code?: string }[] = [];
    for (const it of items) {
      const row = current.get(it.id);
      try {
        if (!row) throw new ConflictException('这个组合的编码已经和新规则一致，或不在可重生成的范围里');
        if (row.token !== it.token) throw new ConflictException('预览之后命名规则或构成又变了，请重新预览');
        if (row.error) throw new BadRequestException(row.error);
        if (row.blocked) throw new ConflictException(row.blocked);
        await this.ds.transaction((em) => refreshBundle(this.resources, em, user, it.id, `按新命名规则批量重生成编码：${reason.trim()}`));
        results.push({ id: it.id, ok: true, code: row.newCode });
      } catch (e) { results.push({ id: it.id, ok: false, error: (e as Error).message }); }
    }
    return { results, done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }
}
