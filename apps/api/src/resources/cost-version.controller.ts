import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { DataSource } from 'typeorm';
import { getResourceDef, todayInChina } from '@kudesi/shared';
import { CurrentUser, RequirePermission, type AuthUser } from '../common/auth.decorators';
import { Company, ResourceRecord } from '../entities';
import { ResourcesService } from './resources.service';
import { CostService } from './cost.service';
import { computeVersion, costVersionAtDate, describeCostVersion, COST_VERSION_TYPES, loadVersionRecords, recalculationPreview, versionSignature } from './cost-version-engine';
import { buildXlsx } from './xlsx-lite';

class CopyVersionDto { @IsString() @MaxLength(80) versionCode!: string; @IsString() @MaxLength(200) versionName!: string }
class SourcePreviewDto { @IsString() @MaxLength(64) signature!: string }
class ClearVersionDto extends SourcePreviewDto { @IsString() @MaxLength(80) confirmCode!: string; @IsString() @MaxLength(500) reason!: string }
class EffectiveVersionDto { @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) businessDate?:string }
class SkuOptionsDto {
  @IsOptional() @IsIn(['base_code','bundle']) skuType?:string;
  @IsOptional() @IsString() @MaxLength(200) keyword?:string;
  @IsOptional() @Type(()=>Number) @IsInt() @Min(1) page?:number;
  @IsOptional() @Type(()=>Number) @IsInt() @Min(1) @Max(200) pageSize?:number;
}

/** 版本组合操作复用统一资源校验、关联和日志；普通 CRUD 仍走资源接口。 */
@Controller('finance/cost-versions')
export class CostVersionController {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly resources: ResourcesService, private readonly cost: CostService) {}

  private async version(user: AuthUser, id: number, em = this.ds.manager) {
    const version = await em.findOneBy(ResourceRecord,{companyId:user.companyId,type:'finance-cost-versions',id});
    if (!version) throw new NotFoundException('成本版本不存在');
    return version;
  }

  @RequirePermission('finance.cost-table.view','resource.finance-cost-versions.view','product.cost.view')
  @Get('effective')
  async effective(@CurrentUser() user:AuthUser,@Query() query:EffectiveVersionDto) {
    const day=query.businessDate || todayInChina();
    const parsed=new Date(`${day}T00:00:00Z`);
    if(!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==day)throw new BadRequestException('业务日期无效');
    return this.ds.transaction('REPEATABLE READ',em=>costVersionAtDate(em,user.companyId,day));
  }

  @RequirePermission('finance.cost-table.view','resource.finance-cost-versions.view','product.cost.view')
  @Get(':id/preview')
  async preview(@CurrentUser() user: AuthUser,@Param('id',ParseIntPipe) id: number) {
    return this.ds.transaction('REPEATABLE READ',async em => {
      const version = await this.version(user,id,em);
      const records = await loadVersionRecords(em,user.companyId);
      const {d,seeds} = await this.cost.versionSeeds(user,em,String(version.data.effectiveFrom || todayInChina()));
      return describeCostVersion(version,records,seeds,w=>this.cost.freightFor(d,w/1000)?.cents ?? null);
    });
  }

  @RequirePermission('finance.cost-table.view','resource.finance-cost-versions.view','product.cost.view')
  @Get(':id/sku-options')
  async skuOptions(@CurrentUser() user:AuthUser,@Param('id',ParseIntPipe) id:number,@Query() query:SkuOptionsDto) {
    return this.ds.transaction('REPEATABLE READ',async em=>{
      const version=await this.version(user,id,em),{seeds}=await this.cost.versionSeeds(user,em,String(version.data.effectiveFrom || todayInChina()));
      const keyword=(query.keyword || '').trim().toLowerCase();
      const all=seeds.filter(s=>(!query.skuType || s.skuType===query.skuType) && (!keyword || `${s.row.code} ${s.row.name}`.toLowerCase().includes(keyword)));
      const page=query.page || 1,pageSize=query.pageSize || 30;
      return {total:all.length,page,pageSize,rows:all.slice((page-1)*pageSize,page*pageSize).map(s=>({skuType:s.skuType,skuId:s.skuId,code:s.row.code,name:s.row.name,weightG:s.row.weightG,buckets:s.buckets,warnings:s.warnings}))};
    });
  }

  @RequirePermission('finance.cost-table.view','resource.finance-cost-versions.view','product.cost.view')
  @Get(':id/sources')
  async sources(@CurrentUser() user: AuthUser,@Param('id',ParseIntPipe) id: number) {
    return this.ds.transaction('REPEATABLE READ',async em => {
      const version = await this.version(user,id,em);
      const {seeds} = await this.cost.versionSeeds(user,em,String(version.data.effectiveFrom || todayInChina()));
      const records = await loadVersionRecords(em,user.companyId);
      const missing = seeds.filter(s => !records.some(r => r.type === 'finance-cost-skus' && r.data.versionId === id && r.data.skuType === s.skuType && r.data[s.skuType === 'base_code' ? 'baseCodeId' : 'bundleId'] === s.skuId));
      const rows = missing.map(s => ({skuType:s.skuType,skuId:s.skuId,code:s.row.code,name:s.row.name}));
      return {rows,signature:versionSignature([version.id,version.status,version.data,rows])};
    });
  }

  @RequirePermission('finance.cost-table.view','resource.finance-cost-versions.view','product.cost.view')
  @Get(':id/recalculate-preview')
  async recalculatePreview(@CurrentUser() user:AuthUser,@Param('id',ParseIntPipe) id:number) {
    return this.ds.transaction('REPEATABLE READ',async em=>{
      const version=await this.version(user,id,em),records=await loadVersionRecords(em,user.companyId),{d,seeds}=await this.cost.versionSeeds(user,em,String(version.data.effectiveFrom || todayInChina()));
      const {writes,...preview}=recalculationPreview(version,records,seeds,w=>this.cost.freightFor(d,w/1000)?.cents ?? null);
      return preview;
    });
  }

  @RequirePermission('finance.cost-table.view','resource.finance-cost-versions.edit','resource.finance-cost-versions.create','product.cost.view','product.cost.edit')
  @Post(':id/recalculate')
  async recalculate(@CurrentUser() user:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() body:SourcePreviewDto) {
    return this.ds.transaction(async em=>{
      await em.findOne(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
      const version=await this.version(user,id,em);
      if(version.status!=='draft' || version.data.lockedAt)throw new ConflictException('只有草稿成本版本可以重算');
      const records=await loadVersionRecords(em,user.companyId),{d,seeds}=await this.cost.versionSeeds(user,em,String(version.data.effectiveFrom || todayInChina()));
      const preview=recalculationPreview(version,records,seeds,w=>this.cost.freightFor(d,w/1000)?.cents ?? null);
      if(!preview.ready)throw new ConflictException(preview.issues.slice(0,8).join('；') || '没有可更新的SKU成本');
      if(preview.signature!==body.signature)throw new ConflictException('来源成本或规则已变化，请重新预检差异');
      const state=em.queryRunner!.data;
      state.costVersionRecalculating=true;
      try {
      for(const write of preview.writes) {
        if(write.id)await this.resources.updateRecord(em,user,'finance-cost-skus',write.id,write.data,'按已确认预检结果更新成本快照');
        else await this.resources.createRecord(em,user,'finance-cost-skus',write.data,'按已确认预检结果登记SKU成本快照');
      }
      } finally { delete state.costVersionRecalculating; }
      return {updated:preview.writes.filter(w=>w.id).length,created:preview.writes.filter(w=>!w.id).length};
    });
  }

  @RequirePermission('finance.cost-table.view','resource.finance-cost-versions.create','product.cost.view','product.cost.edit')
  @Post(':id/register-sources')
  async register(@CurrentUser() user: AuthUser,@Param('id',ParseIntPipe) id: number,@Body() body: SourcePreviewDto) {
    return this.ds.transaction(async em => {
      await em.findOne(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
      const version = await this.version(user,id,em);
      const {seeds} = await this.cost.versionSeeds(user,em,String(version.data.effectiveFrom || todayInChina()));
      const records = await loadVersionRecords(em,user.companyId);
      const rows = seeds.filter(s => !records.some(r => r.type === 'finance-cost-skus' && r.data.versionId === id && r.data.skuType === s.skuType && r.data[s.skuType === 'base_code' ? 'baseCodeId' : 'bundleId'] === s.skuId)).map(s => ({skuType:s.skuType,skuId:s.skuId,code:s.row.code,name:s.row.name}));
      if (body.signature !== versionSignature([version.id,version.status,version.data,rows])) throw new ConflictException('来源或版本已变化，请重新预检');
      for (const row of rows) await this.resources.createRecord(em,user,'finance-cost-skus',{versionId:id,skuType:row.skuType,[row.skuType === 'base_code' ? 'baseCodeId' : 'bundleId']:row.skuId},'自动重算预检：补齐已验证SKU');
      return {created:rows.length};
    });
  }

  @RequirePermission('finance.cost-table.view','resource.finance-cost-versions.create','product.cost.view','product.cost.edit')
  @Post(':id/copy')
  async copy(@CurrentUser() user: AuthUser,@Param('id',ParseIntPipe) id: number,@Body() body: CopyVersionDto) {
    return this.ds.transaction(async em => {
      await em.findOne(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
      const source = await this.version(user,id,em);
      const original = await loadVersionRecords(em,user.companyId);
      const version = await this.resources.createRecord(em,user,'finance-cost-versions',{...source.data,...body,isDefault:false,lockedAt:undefined,activationSignature:undefined},`复制成本版本 ${source.title}`);
      const ids = new Map<number,number>();
      for (const type of COST_VERSION_TYPES.slice(1)) for (const old of original.filter(r => r.type === type && r.data.versionId === id)) {
        const def = getResourceDef(type)!;
        const values: Record<string,unknown> = {versionId:version.id};
        for (const field of def.fields.filter(f => !f.readonly && f.key !== 'versionId')) {
          const value = old.data[field.key];
          values[field.key] = field.type === 'ref' && field.ref?.startsWith('finance-cost-') && typeof value === 'number' ? ids.get(value) ?? value : value;
        }
        const created = await this.resources.createRecord(em,user,type,values,`复制成本版本明细 #${old.id}`);
        ids.set(old.id,created.id);
        if(type==='finance-cost-skus')await this.resources.patchData(em,user,type,created.id,{weightManual:old.data.weightManual===true},'复制单品重量设置');
        if (old.status === 'inactive') await this.resources.changeStatusRecord(em,user,type,created.id,'inactive','保留原版本停用状态');
      }
      return {id:version.id};
    });
  }

  @RequirePermission('finance.cost-table.view','resource.finance-cost-versions.edit','product.cost.view','product.cost.edit')
  @Post(':id/activate')
  async activate(@CurrentUser() user: AuthUser,@Param('id',ParseIntPipe) id: number,@Body() body: SourcePreviewDto) {
    return this.ds.transaction(async em => {
      await em.findOne(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
      const version = await this.version(user,id,em);
      if (version.status==='active') throw new ConflictException('该版本已经启用');
      await this.resources.patchData(em,user,'finance-cost-versions',id,{activationSignature:body.signature},'确认成本版本启用预检');
      await this.resources.changeStatusRecord(em,user,'finance-cost-versions',id,'active','预检通过，启用并锁定成本版本');
      return {id};
    });
  }

  @RequirePermission('finance.cost-table.view','resource.finance-cost-versions.delete','product.cost.view','product.cost.edit')
  @Post(':id/clear')
  async clear(@CurrentUser() user: AuthUser,@Param('id',ParseIntPipe) id: number,@Body() body: ClearVersionDto) {
    return this.ds.transaction(async em => {
      await em.findOne(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
      const version = await this.version(user,id,em);
      if (version.status !== 'draft' || version.data.lockedAt || body.confirmCode !== version.data.versionCode) throw new ConflictException('只能清空草稿版本，且必须输入正确的版本编号');
      const records = await loadVersionRecords(em,user.companyId);
      const {d,seeds} = await this.cost.versionSeeds(user,em,String(version.data.effectiveFrom || todayInChina()));
      const preview = computeVersion(version,records,seeds,w=>this.cost.freightFor(d,w/1000)?.cents ?? null);
      if (preview.signature !== body.signature) throw new ConflictException('版本成本已变化，请重新预览清空范围');
      let deleted = 0;
      for (const type of [...COST_VERSION_TYPES.slice(1)].reverse()) for (const record of records.filter(r=>r.type===type && r.data.versionId===id)) {
        await this.resources.removeRecord(em,user,type,record.id,body.reason); deleted++;
      }
      return {deleted};
    });
  }

  @RequirePermission('finance.cost-table.view','resource.finance-cost-versions.view','product.cost.view')
  @Get(':id/export')
  async export(@CurrentUser() user: AuthUser,@Param('id',ParseIntPipe) id: number) {
    const preview = await this.preview(user,id);
    const rows = preview.rows;
    const columns = [{header:'SKU类型'},{header:'SKU编码'},{header:'SKU名称'},{header:'预估重量(g)'},{header:'发货前成本(元)'},{header:'快递成本(元)'},{header:'含快递成本(元)'},{header:'加价率(%)'},{header:'公司底价(元)'}];
    const yuan = (v: unknown) => typeof v === 'number' ? v/100 : null;
    const file = buildXlsx('版本成本',columns.map(c=>({...c,width:22})),rows.map(r => [r.skuType==='base_code'?'商品基础编码':'商品组合编码',r.code,r.name,r.weightG,yuan(r.preShipCostCents),yuan(r.freightCents),yuan(r.costIncludingFreightCents),r.markupPercent,yuan(r.minPriceCents)]));
    return {fileName:`成本版本-${id}.xlsx`,fileBase64:file.toString('base64'),rowCount:rows.length};
  }
}
