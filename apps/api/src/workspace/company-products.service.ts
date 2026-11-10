import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { getResourceDef } from '@kudesi/shared';
import { DataSource, In, IsNull } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { FlowRun, ResourceFile, ResourceRecord, User } from '../entities';
import { FilesService } from '../integrations/files.service';
import { INVENTORY_UNIT_SQL } from '../resources/finance-inventory-units';
import { activeGrants, familyMembers, productBaseIds, EXCLUSIVE_KEY, EXCLUSIVE_TYPE, EXCLUSIVE_TEMPLATE, parsePeriodDays } from '../resources/product-exclusive';
import { ResourcesService } from '../resources/resources.service';
import { loadUnitLists, unitLabelFor } from '../resources/unit-options';

const PRODUCT = 'finance-products';
const states = In(['active', 'pending', 'verified', 'reverify']);
const unitField = getResourceDef(PRODUCT)!.fields.find(f => f.key === 'specUnit')!;
const str = (v: unknown) => typeof v === 'string' ? v : '';
const aliases = (r: ResourceRecord) => [...new Set(str(r.data.rawFinishedNames).split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
const visible = (r: ResourceRecord) => r.data.archiveType !== 'raw' || aliases(r).length > 0;
type CatalogEntry = { row: ResourceRecord; categoryId: number; name: string; alias: string | null; imagePosition: string };
const imagePosition = (seed: number) => `${(seed * 37) % 101}% ${(seed * 61) % 101}%`;
function pathOf(row: ResourceRecord, byId: Map<number, ResourceRecord>) {
  const names: string[] = [], seen = new Set<number>();
  for (let current: ResourceRecord | undefined = row; current && !seen.has(current.id); current = byId.get(Number(current.data.parentId))) {
    seen.add(current.id); names.unshift(current.title.trim());
  }
  return names.join(' / ');
}

@Injectable()
export class CompanyProductsService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly resources: ResourcesService, private readonly files: FilesService) {}

  private async catalog(companyId: number) {
    const em = this.ds.manager;
    const [dictionary, archives, products, bases, parts] = await Promise.all([
      em.findBy(ResourceRecord, { companyId, type: 'finance-code-dictionaries', status: 'active', archivedAt: IsNull() }),
      em.findBy(ResourceRecord, { companyId, type: 'finance-categories', archivedAt: IsNull() }),
      em.find(ResourceRecord, { where: { companyId, type: PRODUCT, archivedAt: IsNull(), status: states }, order: { updatedAt: 'DESC', id: 'DESC' } }),
      em.findBy(ResourceRecord, { companyId, type: 'finance-base-codes', archivedAt: IsNull() }),
      em.findBy(ResourceRecord, { companyId, type: 'finance-base-code-lines', archivedAt: IsNull() }),
    ]);
    const cats = dictionary.filter(r => r.data.kind === 'product_category').sort((a,b) => Number(a.data.sort || 0) - Number(b.data.sort || 0) || a.id - b.id);
    const byCat = new Map(cats.map(r => [r.id,r])), byArchive = new Map(archives.map(r => [r.id,r])), byBase = new Map(bases.map(r => [r.id,r]));
    const categories = cats.map(r => ({ id:r.id, name:r.title, parentId:byCat.has(Number(r.data.parentId)) ? Number(r.data.parentId) : null, path:pathOf(r,byCat) }));
    const links = new Map<number, Set<number>>();
    const link = (productId:number, categoryId:number) => {
      if (!byCat.has(categoryId)) return;
      const set = links.get(productId) ?? new Set<number>(); set.add(categoryId); links.set(productId,set);
    };
    for (const base of bases) {
      const canonical = byBase.get(Number(base.data.canonicalId)) ?? base;
      const categoryId = Number(base.data.codeDictionaryCategoryId ?? canonical.data.codeDictionaryCategoryId);
      if (canonical.data.productId) link(Number(canonical.data.productId),categoryId);
      // A composed base may include packaging/gifts: only its main archive identifies the product.
      for (const part of parts.filter(p => Number(p.data.baseCodeId) === canonical.id && p.data.role === 'main')) link(Number(part.data.productId),categoryId);
    }
    const categoryLinks = new Map<number, Set<number>>();
    for (const product of products) {
      const archiveId = Number(product.data.categoryId);
      if (!byArchive.has(archiveId)) continue;
      const mapped = categoryLinks.get(archiveId) ?? new Set<number>();
      for (const id of links.get(product.id) ?? []) mapped.add(id);
      categoryLinks.set(archiveId, mapped);
    }
    const entries = products.filter(visible).map(row => {
      const archive = byArchive.get(Number(row.data.categoryId));
      const path = archive ? pathOf(archive,byArchive) : '';
      const matches = categories.filter(c => c.path === path);
      const linked = categoryLinks.get(Number(row.data.categoryId)) ?? links.get(row.id);
      const categoryId = matches.length === 1 ? matches[0].id : linked?.size === 1 ? [...linked][0] : 0;
      return { row, categoryId };
    }).filter(entry => entry.categoryId !== 0).flatMap(({row, categoryId}): CatalogEntry[] =>
      row.data.archiveType === 'raw'
        ? aliases(row).map((alias, index) => ({row, categoryId, name: alias, alias, imagePosition: imagePosition(row.id + index)}))
        : [{row, categoryId, name: str(row.data.name) || row.title, alias: null, imagePosition: imagePosition(row.id)}]);
    return { categories, entries };
  }

  async list(user:AuthUser, query:{category?:number;keyword?:string;page?:number}) {
    const { categories, entries } = await this.catalog(user.companyId);
    const counts:Record<number,number> = {};
    for (const entry of entries) counts[entry.categoryId] = (counts[entry.categoryId] ?? 0) + 1;
    const descendant = (id:number) => {
      const seen = new Set<number>();
      for (let current = categories.find(c => c.id === id); current && !seen.has(current.id); current = categories.find(c => c.id === current!.parentId)) {
        if (current.id === query.category) return true; seen.add(current.id);
      }
      return false;
    };
    const keyword = (query.keyword ?? '').trim().toLocaleLowerCase();
    const selected = entries.filter(({row,categoryId,name}) => (query.category === undefined || (query.category === 0 ? categoryId === 0 : descendant(categoryId)))
      && (!keyword || [name,row.data.code,row.data.specQty,row.data.specUnit].join(' ').toLocaleLowerCase().includes(keyword)));
    const page=query.page ?? 1,pageSize=24;
    const rows=selected.slice((page-1)*pageSize,page*pageSize);
    return { items:(await this.summaries(user.companyId,rows,categories)).map(({photos,...item})=>({...item,photo:photos[0]??null})),
      total:selected.length,page,pageSize,categories,counts };
  }

  async detail(user:AuthUser,id:number,alias?:string) {
    const {categories,entries}=await this.catalog(user.companyId),entry=entries.find(e=>e.row.id===id && (alias === undefined || e.alias === alias));
    if(!entry)throw new NotFoundException('产品不存在');
    const [item]=await this.summaries(user.companyId,[entry],categories,true);
    return {...item,weightG:typeof entry.row.data.weightG==='number'?entry.row.data.weightG:null};
  }

  async setAttributes(user:AuthUser,id:number,values:{priceRestricted:boolean;tags:string[];minimumPriceCents?:number|null}) {
    if(!user.permissions.isCompanyAdmin)throw new ForbiddenException('只有公司管理员可以设置产品属性');
    if (values.minimumPriceCents != null && (!Number.isSafeInteger(values.minimumPriceCents) || values.minimumPriceCents < 1 || values.minimumPriceCents > 99999999999)) throw new BadRequestException('最低销售价必须大于0且最多两位小数');
    const { entries } = await this.catalog(user.companyId);
    if (!entries.some(entry => entry.row.id === id)) throw new NotFoundException('产品不存在');
    const tags=[...new Set(values.tags.map(tag=>tag.trim()).filter(tag=>tag&&tag!=='限价品'))];
    const minimumPriceCents = await this.ds.transaction(async em=>{
      const row=await em.findOne(ResourceRecord,{where:{id,companyId:user.companyId,type:PRODUCT,archivedAt:IsNull(),status:states},lock:{mode:'pessimistic_write'}});
      if(!row||!visible(row))throw new NotFoundException('产品不存在');
      const amount = values.priceRestricted ? (values.minimumPriceCents === undefined ? row.data.catalogMinimumPriceCents ?? null : values.minimumPriceCents) : null;
      await this.resources.patchData(em,user,PRODUCT,id,{catalogPriceRestricted:values.priceRestricted,catalogTags:tags,catalogMinimumPriceCents:amount},'设置公司产品属性',false,true);
      return typeof amount === 'number' ? amount : null;
    });
    return {priceRestricted:values.priceRestricted,tags,minimumPriceCents};
  }

  async setExclusive(user:AuthUser,id:number,values:{ownerId:number|null;periodDays?:number;reason:string}) {
    if(!user.permissions.isCompanyAdmin)throw new ForbiddenException('只有公司管理员可以设置专属人');
    if(values.ownerId!==null&&(!Number.isSafeInteger(values.ownerId)||values.ownerId<1))throw new BadRequestException('请选择本公司在职成员');
    const reason=values.reason.trim();
    if(!reason || reason.length>500)throw new BadRequestException('请填写修改原因（最多500字）');
    const days=values.ownerId===null?null:parsePeriodDays(values.periodDays);
    return this.ds.transaction('READ COMMITTED',async em=>{
      // 与审批通过共用公司锁；READ COMMITTED 防止等待锁后读取旧归属。
      await em.query('SELECT id FROM companies WHERE id = ? FOR UPDATE',[user.companyId]);
      const row=await em.findOne(ResourceRecord,{where:{id,companyId:user.companyId,type:PRODUCT,archivedAt:IsNull(),status:states}});
      if(!row||!visible(row))throw new NotFoundException('产品不存在');
      const owner=values.ownerId===null?null:await em.findOne(User,{where:{id:values.ownerId,companyId:user.companyId,status:'active'}});
      if(values.ownerId!==null&&!owner)throw new BadRequestException('请选择本公司在职成员');
      const [codes,lines,members,grants,runs]=await Promise.all([
        em.findBy(ResourceRecord,{companyId:user.companyId,type:'finance-base-codes',archivedAt:IsNull()}),
        em.findBy(ResourceRecord,{companyId:user.companyId,type:'finance-base-code-lines',archivedAt:IsNull()}),
        familyMembers(em,user.companyId,true),activeGrants(em,user.companyId,true),
        em.findBy(FlowRun,{companyId:user.companyId,templateKey:EXCLUSIVE_TEMPLATE,status:'running'}),
      ]);
      const baseIds=productBaseIds(id,codes,lines);
      const families=new Set(baseIds.map(baseId=>members.get(baseId)?.familyKey).filter((f):f is string=>!!f));
      const archiveGrants=await em.findBy(ResourceRecord,{companyId:user.companyId,type:EXCLUSIVE_TYPE});
      for(const g of archiveGrants)if(Number(g.data.archiveProductId)===id)families.add(String(g.data.familyKey));
      if(!families.size)families.add(`archive:${id}`);
      if(runs.some(run=>families.has(members.get(Number(run.payload.baseCodeId))?.familyKey??'')))throw new ConflictException('该商品有正在审批的专属领取申请，请先处理申请再修改');
      for(const grant of grants.filter(g=>families.has(String(g.data.familyKey)))) {
        await this.resources.changeStatusRecord(em,user,EXCLUSIVE_TYPE,grant.id,'cancelled',`管理员手工调整：${reason}`);
      }
      if(owner)for(const familyKey of families){
        const family=[...members.values()].filter(m=>m.familyKey===familyKey);
        const now=new Date();
        em.queryRunner!.data[EXCLUSIVE_KEY]={
          label:`${row.title} · ${owner.name}`.slice(0,200),productName:row.title.slice(0,180),
          ...(family.length?{baseCodeId:family[0].id}:{archiveProductId:id}),
          ownerId:owner.id,ownerName:owner.name,approverId:user.id,approverName:user.name,
          startsAt:now.toISOString(),endsAt:new Date(now.getTime()+days!*86400000).toISOString(),
          familyKey,memberIds:family.map(m=>m.id),source:'manual',sourceProductId:id,manualReason:reason,
        };
        try{await this.resources.createRecord(em,user,EXCLUSIVE_TYPE,{},`管理员手工设置专属：${reason}`);}
        finally{delete em.queryRunner!.data[EXCLUSIVE_KEY];}
      }
      return {owners:owner?[owner.name]:[]};
    });
  }

  private async summaries(companyId:number,entries:CatalogEntry[],categories:Array<{id:number;path:string}>,allPhotos=false) {
    if(!entries.length)return [];
    const em=this.ds.manager,productIds=[...new Set(entries.map(e=>e.row.id))];
    const [units,stock,photos,bases,grants,members,baseLines]=await Promise.all([
      loadUnitLists(em,companyId),
      em.query<Array<{productId:number;stockUnit:string;qty:string}>>(`SELECT e.account_id AS productId, ${INVENTORY_UNIT_SQL} AS stockUnit, SUM(e.qty) AS qty FROM finance_entries e WHERE e.company_id=? AND e.kind='inventory' AND e.account_id IN (?) AND e.qty IS NOT NULL GROUP BY e.account_id,stockUnit`,[companyId,productIds]),
      em.find(ResourceFile,{where:{companyId,resourceType:PRODUCT,fieldKey:'photos',resourceId:In(productIds)},order:{id:'ASC'}}),
      em.findBy(ResourceRecord,{companyId,type:'finance-base-codes',archivedAt:IsNull()}),activeGrants(em,companyId),familyMembers(em,companyId),
      em.findBy(ResourceRecord,{companyId,type:'finance-base-code-lines',archivedAt:IsNull()}),
    ]);
    return Promise.all(entries.map(async({row,categoryId,name,alias,imagePosition})=>{
      const stockByUnit=stock.filter(s=>Number(s.productId)===row.id);
      const baseIds=productBaseIds(row.id,bases,baseLines);
      const families=new Set(baseIds.map(id=>members.get(id)?.familyKey));
      const available=photos.filter(p=>p.resourceId===row.id&&p.mime.startsWith('image/'));
      const ordered=Array.isArray(row.data.photos)?row.data.photos.flatMap(id=>available.filter(p=>p.id===Number(id))):available;
      const signed:Array<{url:string;name:string}>=[];
      for(const file of ordered){try{const {url,name}=await this.files.urlOf(companyId,file.id,PRODUCT);signed.push({url,name});if(!allPhotos)break;}catch{/* Missing files do not hide the archive. */}}
      const unit=unitLabelFor(units,unitField,row.data,row.data.specUnit)||str(row.data.purchaseSpec);
      return {id:row.id,name,alias,imagePosition,code:str(row.data.code),category:categories.find(c=>c.id===categoryId)?.path??'未分类',
        specification:[row.data.specQty,unit].filter(v=>v!==undefined&&v!=='').join(' '),photos:signed,
        stock:stockByUnit.length===1?Number(stockByUnit[0].qty):null,stockUnit:stockByUnit.length===1?stockByUnit[0].stockUnit:unit,
        stockBalances:stockByUnit.map(s=>({unit:s.stockUnit,qty:Number(s.qty)})),
        owners:[...new Set(grants.filter(g=>families.has(str(g.data.familyKey))||Number(g.data.archiveProductId)===row.id).map(g=>str(g.data.ownerName)).filter(Boolean))],
        minimumPriceCents:row.data.catalogPriceRestricted===true && typeof row.data.catalogMinimumPriceCents==='number' ? row.data.catalogMinimumPriceCents : null,
        priceRestricted:row.data.catalogPriceRestricted===true,tags:Array.isArray(row.data.catalogTags)?row.data.catalogTags.filter((v):v is string=>typeof v==='string'):[]};
    }));
  }
}
