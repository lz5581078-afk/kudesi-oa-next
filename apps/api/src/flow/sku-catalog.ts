import type {EntityManager} from 'typeorm';
import {In} from 'typeorm';
import {createChecker,todayInChina} from '@kudesi/shared';
import type {AuthUser} from '../common/auth.decorators';
import {ResourceRecord} from '../entities';
const families:Record<string,string>={'原料档案':'raw','原装采购成品':'purchased','供应商OEM成品':'purchased','产品包装档案':'package','发货物料档案':'shipping_material'};
export const SKU_ROLE_ARCHIVES:Record<string,readonly string[]>={main:['raw','purchased'],gift:['raw','purchased','shipping_material'],package:['package','oem_package'],label:['shipping_material'],other:['shipping_material']};
const text=(value:unknown)=>typeof value==='string'?value:'';
function pathOf(index:Map<number,ResourceRecord>,id:unknown,includeInactive=false){const path:ResourceRecord[]=[],seen=new Set<number>();let row=index.get(Number(id));while(row){if(seen.has(row.id)||(!includeInactive&&row.status!=='active')||row.archivedAt)return [];seen.add(row.id);path.unshift(row);if(row.data.parentId==null)return path;row=index.get(Number(row.data.parentId));if(!row)return [];}return path;}
export function skuCodeSource(base:ResourceRecord,records:ResourceRecord[]){
 const codes=new Map(records.filter(row=>row.type==='finance-base-codes').map(row=>[row.id,row])),real=typeof base.data.canonicalId==='number'?codes.get(base.data.canonicalId):base;
 if(!real||real.archivedAt||real.status!=='verified')return {family:'',path:[] as ResourceRecord[],categoryKey:''};
 const product=records.find(row=>row.type==='finance-products'&&row.id===Number(real.data.productId));
 if(base.data.codeDictionaryCategoryId!=null){const index=new Map(records.filter(row=>row.type==='finance-code-dictionaries'&&row.data.kind==='product_category').map(row=>[row.id,row])),path=pathOf(index,base.data.codeDictionaryCategoryId);return {family:families[text(path[0]?.data.name).replace(/\s/g,'').toUpperCase()]??'',path,categoryKey:path.length?`code:${path.at(-1)!.id}`:'',product,real};}
 const index=new Map(records.filter(row=>row.type==='finance-categories').map(row=>[row.id,row])),path=pathOf(index,product?.data.categoryId??base.data.categoryId);
 return {family:text(product?.data.archiveType),path,categoryKey:path.length?`archive:${path.at(-1)!.id}`:'',product,real};
}
export async function skuCodeFamily(em:EntityManager,companyId:number,base:ResourceRecord){const records=await em.find(ResourceRecord,{where:{companyId,type:In(['finance-base-codes','finance-products','finance-code-dictionaries','finance-categories'])}});return skuCodeSource(base,records).family;}
/** Eligibility for new source SKU selections; historical cost facts are not rewritten. */
export function skuLaborIsCurrent(labor:ResourceRecord,version:ResourceRecord|null|undefined,day=todayInChina()){
 if(labor.type!=='finance-labor-costs'||labor.status!=='active'||labor.archivedAt||!version||version.companyId!==labor.companyId||version.type!=='finance-labor-versions'||version.id!==labor.data.versionId||version.status!=='active'||version.archivedAt)return false;
 const from=version.data.effectiveFrom,to=version.data.effectiveTo;
 if(from!=null&&from!==''&&(typeof from!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(from)||from>day))return false;
 if(to!=null&&to!==''&&(typeof to!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(to)||to<day))return false;
 return true;
}
export async function skuCatalog(em:EntityManager,user:AuthUser,kind:string,query:{keyword?:string;category?:string;page?:number;pageSize?:number}){
 const records=await em.find(ResourceRecord,{where:{companyId:user.companyId,type:In(['finance-base-codes','finance-products','finance-code-dictionaries','finance-categories','finance-labor-costs','finance-labor-units','finance-labor-versions','finance-brands'])},order:{updatedAt:'DESC',id:'DESC'}}),canCost=createChecker(user.permissions)('product.cost.view'),page=query.page??1,pageSize=query.pageSize??30,keyword=(query.keyword??'').trim().toLocaleLowerCase();
 const categories=new Map<string,{id:string;parentId:string|null;name:string;count:number;order:number}>();
 // The source merges loaded products by ID before counting: keyword filters rows, not tree counts.
 // Directory membership comes from the real tree, not from whether a product exists.
 if(kind!=='labor')for(const [type,prefix]of [['finance-code-dictionaries','code'],['finance-categories','archive']]as const){
  const index=new Map(records.filter(row=>row.type===type&&(prefix!=='code'||row.data.kind==='product_category')).map(row=>[row.id,row]));
  for(const category of index.values()){
   const path=pathOf(index,category.id,true),root=path[0];if(!root)continue;
   const family=prefix==='code'?families[text(root.data.name).replace(/\s/g,'').toUpperCase()]:text(root.data.archiveType),allowedFamily=['original_purchase','supplier_oem'].includes(family)?'purchased':family;
   if(!SKU_ROLE_ARCHIVES[kind]?.includes(allowedFamily))continue;
   categories.set(`${prefix}:${category.id}`,{id:`${prefix}:${category.id}`,parentId:path.length>1?`${prefix}:${path[path.length-2].id}`:null,name:category.title,count:0,order:Number(category.data.sortOrder)||0});
  }
 }
 const rows=kind==='labor'?records.filter(row=>row.type==='finance-labor-costs'&&skuLaborIsCurrent(row,records.find(version=>version.type==='finance-labor-versions'&&version.id===row.data.versionId))).map(row=>({id:row.id,code:text(row.data.workCode),name:text(row.data.workName)||row.title,spec:records.find(unit=>unit.type==='finance-labor-units'&&unit.id===row.data.unitId)?.title??(!row.data.unitId?text(row.data.unitName):''),categoryKey:'',...(canCost?{costCents:typeof row.data.unitPrice==='number'?row.data.unitPrice:null}:{})})):records.filter(row=>row.type==='finance-base-codes'&&row.status==='verified'&&!row.archivedAt).flatMap(row=>{
  const source=skuCodeSource(row,records);if(!SKU_ROLE_ARCHIVES[kind]?.includes(source.family))return [];
  const name=text(row.data.name)||row.title,code=text(row.data.code)||row.title;
  const prefix=source.categoryKey.split(':')[0];for(const [index,category]of source.path.entries()){const id=`${prefix}:${category.id}`,current=categories.get(id)??{id,parentId:index?`${prefix}:${source.path[index-1].id}`:null,name:category.title,count:0,order:Number(category.data.sortOrder)||0};current.count++;categories.set(id,current);}
  return [{id:row.id,code,name,spec:text(row.data.spec)||`${row.data.codeSpecQty??''}${row.data.codeSpecUnit??''}`,categoryKey:source.categoryKey,...(canCost?{costCents:typeof source.real?.data.cost==='number'?source.real.data.cost:null}:{})}];
 });
 const allowedKeys=new Set<string>();if(query.category){allowedKeys.add(query.category);let changed=true;while(changed){changed=false;for(const category of categories.values())if(category.parentId&&allowedKeys.has(category.parentId)&&!allowedKeys.has(category.id)){allowedKeys.add(category.id);changed=true;}}}
 const filtered=rows.filter(row=>(!query.category||allowedKeys.has(row.categoryKey))&&(!keyword||`${row.name} ${row.code}`.toLocaleLowerCase().includes(keyword)));
 if(kind==='labor'){
  // The original work_name column uses unicode_ci, not browser pinyin collation.
  const ordered:Array<{id:number}>=await em.query("SELECT id FROM resource_records WHERE company_id=? AND type='finance-labor-costs' ORDER BY JSON_UNQUOTE(JSON_EXTRACT(data,'$.workName')) COLLATE utf8mb4_unicode_ci ASC,id ASC",[user.companyId]);
  const order=new Map(ordered.map((row,index)=>[Number(row.id),index]));filtered.sort((a,b)=>(order.get(a.id)??0)-(order.get(b.id)??0));
 }
 return {categories:[...categories.values()].sort((a,b)=>a.order-b.order||Number(a.id.split(':')[1])-Number(b.id.split(':')[1])).map(({order:_order,...row})=>row),items:filtered.slice((page-1)*pageSize,page*pageSize),total:filtered.length,page,pageSize,canCost};
}
