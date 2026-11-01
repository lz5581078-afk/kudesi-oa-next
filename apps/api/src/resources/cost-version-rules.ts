import { randomBytes } from 'crypto';
import { costVersionActivationPlan } from './cost-version-dates';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { createChecker, todayInChina, validUnitCents } from '@kudesi/shared';
import { Company, ResourceRecord } from '../entities';
import type { BeforeSaveContext } from './resource-rules';
import { CostService } from './cost.service';
import { computeVersion, describeCostVersion, COST_BUCKET_FIELDS, COST_GLOBAL_TYPES, loadVersionRecords } from './cost-version-engine';

const fail = (message: string): never => { throw new BadRequestException(message); };
export async function beforeCostVersionSave(ctx: BeforeSaveContext, type: string) {
  const { em, user, data, existing, host } = ctx;
  const can = createChecker(user.permissions);
  if (!can('product.cost.edit') || !can('product.cost.view')) throw new ForbiddenException('维护成本版本需要成本查看和修改权限');
  // 同一公司所有版本写入与启用串行，防止边启用边修改子项。
  await em.findOne(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
  if (existing) {
    const fresh = await em.findOneOrFail(ResourceRecord,{where:{id:existing.id,companyId:user.companyId,type},lock:{mode:'pessimistic_write'}});
    if (JSON.stringify(fresh.data) !== JSON.stringify(existing.data) || fresh.status !== existing.status) throw new ConflictException('成本资料已被其他操作修改，请刷新');
  }
  const records = await loadVersionRecords(em,user.companyId,true);
  if (type === 'finance-cost-versions') {
    if(!data.versionCode)data.versionCode=`CB-${todayInChina().replace(/-/g,'')}-${randomBytes(3).toString('hex').toUpperCase()}`;
    if(existing && data.versionCode!==existing.data.versionCode)fail('版本编号由系统生成，创建后不能修改');
    if (data.effectiveFrom && data.effectiveTo && String(data.effectiveFrom) > String(data.effectiveTo)) fail('生效结束不能早于生效开始');
    if (typeof data.defaultMarkupPercent !== 'number' || data.defaultMarkupPercent < 0 || data.defaultMarkupPercent > 10000) fail('默认加价率必须在 0 到 10000% 之间');
    if (!existing && ctx.status !== 'draft') fail('新成本版本必须先创建为草稿');
    if (ctx.status === 'inactive') data.isDefault = false;
    if (data.isDefault && ctx.status !== 'active') fail('只有启用版本能设为默认');
    if (existing?.data.lockedAt && (data.defaultMarkupPercent !== existing.data.defaultMarkupPercent || ctx.status === 'draft')) fail('启用后的版本成本已锁定，请复制新版本调整');
    if(existing && ctx.status==='active' && existing.status!=='active') {
      const cost=new CostService(em.connection),{d,seeds}=await cost.versionSeeds(user,em,String(data.effectiveFrom || todayInChina()));
      const preview=describeCostVersion({...existing,data},records,seeds,w=>cost.freightFor(d,w/1000)?.cents ?? null);
      if(!preview.ready)fail(preview.issues.slice(0,8).join('；') || '版本没有SKU成本，不能启用');
      if(data.activationSignature!==preview.activationSignature)throw new ConflictException('成本或版本数据已变化，请重新预检后启用');
      if(preview.transition)await host.patchData(em,user,type,preview.transition.id,{effectiveTo:preview.transition.effectiveTo},`启用新版本「${String(data.versionName)}」，衔接前一默认版本截止日期`);
      if(!existing.data.lockedAt)for(const row of preview.rows)await host.patchData(em,user,'finance-cost-skus',row.settingId,{snapshot:row},'成本版本启用：锁定成本快照');
      data.lockedAt=existing.data.lockedAt || new Date().toISOString();
      data.isDefault=true;delete data.activationSignature;
    } else if(existing && ctx.status==='active' && (data.effectiveFrom!==existing.data.effectiveFrom || data.effectiveTo!==existing.data.effectiveTo)) {
      const plan=costVersionActivationPlan({...existing,data},records,false);
      if(plan.issues.length)fail(plan.issues.join('；'));
    }
    if (data.isDefault) for (const v of records.filter(r => r.type === type && r.id !== existing?.id && r.data.isDefault)) await host.patchData(em,user,type,v.id,{isDefault:false},'切换默认成本版本');
    return;
  }
  const version = records.find(r => r.type === 'finance-cost-versions' && r.id === data.versionId);
  const global = COST_GLOBAL_TYPES.includes(type);
  if (!global && (!version || version.status !== 'draft' || version.data.lockedAt)) fail('所属成本版本不是可编辑的草稿，请复制新版本');
  if (existing && existing.data.versionId !== data.versionId) fail('不能移动到其他成本版本');
  for (const [key,value] of Object.entries(data)) {
    if (key.endsWith('Cost') || ['amount','fixedAmount','unitAmount'].includes(key)) if (value != null && (!validUnitCents(value) || Number(value) < 0)) fail('金额最多保留元小数点后 6 位且不得为负数');
  }
  const requireSameVersion = (field: string, refType: string) => {
    const ref = records.find(r => r.id === data[field] && r.type === refType);
    if (!ref || (!COST_GLOBAL_TYPES.includes(refType) && ref.data.versionId !== data.versionId)) fail('引用的成本资料必须属于同一成本版本');
    return ref!;
  };
  if (type === 'finance-cost-skus') {
    const refType = data.skuType === 'base_code' ? 'finance-base-codes' : 'finance-bundles';
    const field = data.skuType === 'base_code' ? 'baseCodeId' : 'bundleId';
    if (!Number.isSafeInteger(data[field]) || Number(data[field]) <= 0) fail('请选择有效的来源SKU');
    const source = await em.findOneBy(ResourceRecord,{id:Number(data[field]),companyId:user.companyId,type:refType});
    if (!source) fail('请选择有效的来源SKU');
    if(existing && (data.skuType!==existing.data.skuType || data[field]!==existing.data[field]))fail('已有SKU成本不能更换来源，请新增SKU计算设置');
    data[data.skuType === 'base_code' ? 'bundleId' : 'baseCodeId'] = null;
    data.skuName = source!.data.name || source!.title; data.skuCode = source!.data.code;
    if (records.some(r => r.type === type && r.id !== existing?.id && r.data.versionId === data.versionId && r.data.skuType === data.skuType && r.data[field] === data[field])) fail('这个SKU已在当前版本中');
    if (data.estimatedWeightG != null && Number(data.estimatedWeightG) < 0) fail('预估重量不能为负数');
    const recalculating=em.queryRunner?.data.costVersionRecalculating===true;
    if(!existing)data.weightManual=!recalculating && data.estimatedWeightG!=null;
    else if(!recalculating && data.estimatedWeightG!==existing.data.estimatedWeightG)data.weightManual=data.estimatedWeightG!=null;
    if (data.markupPercent != null && (Number(data.markupPercent) < 0 || Number(data.markupPercent) > 10000)) fail('单品加价率必须在 0 到 10000% 之间');
    for (const field of Object.values(COST_BUCKET_FIELDS)) if (data[field] != null && Number(data[field]) < 0) fail('成本不能为负数');
    if(ctx.status==='active' && (data.estimatedWeightG==null || Object.values(COST_BUCKET_FIELDS).some(field=>data[field]==null))) {
      const cost=new CostService(em.connection),{d,seeds}=await cost.versionSeeds(user,em,String(version!.data.effectiveFrom || todayInChina()));
      const seed=seeds.find(s=>s.skuType===data.skuType && s.skuId===data[field]);
      if(data.estimatedWeightG==null && seed?.row.weightG)data.estimatedWeightG=seed.row.weightG;
      const candidate=Object.assign(new ResourceRecord(),{id:existing?.id ?? -1,companyId:user.companyId,type,status:ctx.status,title:String(data.skuName),data});
      const row=computeVersion(version!,[...records.filter(r=>r.id!==existing?.id),candidate],seeds,w=>cost.freightFor(d,w/1000)?.cents ?? null).rows.find(r=>r.settingId===candidate.id);
      if(row)for(const [bucket,field]of Object.entries(COST_BUCKET_FIELDS))if(data[field]==null && row.buckets[bucket]!=null)data[field]=row.buckets[bucket];
    }
  }
  if(data.effectiveFrom && data.effectiveTo && String(data.effectiveFrom)>String(data.effectiveTo))fail('生效结束不能早于生效开始');
  const codeField = ({'finance-cost-aux-types':'typeCode','finance-cost-production-rates':'rateCode'} as Record<string,string>)[type];
  if (codeField && records.some(r=>r.type===type && r.id!==existing?.id && r.data.versionId===data.versionId && r.data[codeField]===data[codeField])) fail('当前成本版本内编码不能重复');
  if (type === 'finance-cost-auxiliary') {
    const kind = requireSameVersion('auxTypeId','finance-cost-aux-types');
    if (!kind.data.allowBucketOverride && kind.data.costBucket !== data.costBucket) fail('该辅助类型不允许改变成本科目');
  }
  if (type === 'finance-cost-assignments' || type === 'finance-cost-overrides') requireSameVersion('skuSettingId','finance-cost-skus');
  if (type === 'finance-cost-assignments') {
    const aux = requireSameVersion('auxiliaryId','finance-cost-auxiliary'); data.name = aux.title;
    if(data.unitAmount==null)data.unitAmount=Number(aux.data.amount || 0);
    if (!(Number(data.qty) > 0)) fail('分摊数量必须大于 0');
  }
  if (type === 'finance-cost-production-rates') {
    if (data.effectiveFrom && data.effectiveTo && String(data.effectiveFrom) > String(data.effectiveTo)) fail('结束日期不能早于开始日期');
    if (data.minWeightG != null && Number(data.minWeightG) < 0) fail('起始重量不能为负数');
    if (data.maxWeightG != null && Number(data.maxWeightG) <= Number(data.minWeightG ?? 0)) fail('截止重量必须大于起始重量');
    const field = ({base_code:'baseCodeId',product:'productId',category:'categoryId'} as Record<string,string>)[String(data.targetType)];
    if (field && !data[field]) fail('请选择成本标准的适用对象');
  }
}

export async function beforeCostVersionDelete(ctx: { em: BeforeSaveContext['em']; user: BeforeSaveContext['user']; record: ResourceRecord }) {
  const {em,user,record} = ctx;
  if (!createChecker(user.permissions)('product.cost.edit')) throw new ForbiddenException('需要成本修改权限');
  await em.findOne(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
  const fresh=await em.findOne(ResourceRecord,{where:{id:record.id,companyId:user.companyId,type:record.type},lock:{mode:'pessimistic_write'}});
  if(!fresh || fresh.status!==record.status || JSON.stringify(fresh.data)!==JSON.stringify(record.data))throw new ConflictException('成本资料已被其他操作修改，请刷新');
  if (COST_GLOBAL_TYPES.includes(record.type)) return;
  const version = record.type === 'finance-cost-versions' ? fresh : await em.findOne(ResourceRecord,{where:{companyId:user.companyId,type:'finance-cost-versions',id:Number(record.data.versionId)},lock:{mode:'pessimistic_write'}});
  if (!version || version.status !== 'draft' || version.data.lockedAt) fail('已启用的成本版本及成本明细不能删除');
}
