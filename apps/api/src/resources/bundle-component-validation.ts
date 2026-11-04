import {BadRequestException} from '@nestjs/common';
import {BUNDLE_ROLES,FINANCE_RESOURCE_DEFS,scaledDecimal,todayInChina} from '@kudesi/shared';
import {EntityManager} from 'typeorm';
import {AuthUser} from '../common/auth.decorators';
import {ResourceRecord} from '../entities';
import type {RuleHost} from './resource-rules';
import {buildSnapshot} from './base-code-support';
import {normalizeLineExtras,pickLine} from './bundle-checks';
import {assertLaborUsable} from './labor-rules';
import {allowedValues,loadUnitLists,unitValueFromText} from './unit-options';
type Data=Record<string,unknown>;
const str=(v:unknown)=>typeof v==='string'?v:'';
const one=(em:EntityManager,companyId:number,type:string,id:unknown)=>typeof id==='number'&&Number.isSafeInteger(id)&&id>0?em.findOne(ResourceRecord,{where:{companyId,type,id}}):Promise.resolve(null);
function positive(value:unknown,label:string){if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw new BadRequestException(`${label}必须大于0`);try{scaledDecimal(value,6);}catch{throw new BadRequestException(`${label}最多保留六位小数`);}}
/** 正常人工档案以unitId为准；仅没有引用的旧记录可读取既存单位文本。 */
export async function bundleLaborUnit(em:EntityManager,companyId:number,labor:ResourceRecord,strict=false):Promise<string>{
 if(labor.data.unitId!=null){const unit=await one(em,companyId,'finance-labor-units',labor.data.unitId);if(unit&&!unit.archivedAt&&unit.status==='active')return str(unit.data.name)||unit.title;if(strict)throw new BadRequestException('人工项目计价单位不存在或已停用');return '';}
 const legacy=str(labor.data.unitName);if(!legacy&&strict)throw new BadRequestException('人工项目缺少计价单位');return legacy;
}
/** 同一真实档案校验供修订与直接BOM保存复用；不创建镜像基础码，不读取客户端价格。 */
export async function normalizeBundleComponent(em:EntityManager,host:RuleHost,user:AuthUser,input:Data,legacyImport=false):Promise<Data>{
 const line=pickLine(input),role=str(line.role);
 if(!BUNDLE_ROLES.some(option=>option.value===role))throw new BadRequestException('组成用途无效');
 const targets=['baseCodeId','productId','laborId'].filter(key=>line[key]!=null);
 if(targets.length!==1||role==='labor'&&targets[0]!=='laborId'||role!=='labor'&&targets[0]==='laborId')throw new BadRequestException('每行只能选择一种组件来源');
 positive(line.qty,'数量');
 let product:ResourceRecord|null=null,base:ResourceRecord|null=null,realBase:ResourceRecord|null=null;
 if(role==='labor'){
  const labor=await one(em,user.companyId,'finance-labor-costs',line.laborId);if(!labor)throw new BadRequestException('请选择当前公司的人工项目');
  if(!legacyImport){await assertLaborUsable(em,user.companyId,labor);const version=await one(em,user.companyId,'finance-labor-versions',labor.data.versionId),day=todayInChina();if(!version||version.archivedAt||str(version.data.effectiveFrom)&&str(version.data.effectiveFrom)>day||str(version?.data.effectiveTo)&&str(version?.data.effectiveTo)<day)throw new BadRequestException('人工项目不在当前有效成本版本内');const price=labor.data.unitPrice;if(typeof price!=='number'||!Number.isFinite(price)||price<0)throw new BadRequestException('人工成本无效');if(price===0&&!str(labor.data.zeroReason).trim())throw new BadRequestException('零人工成本尚未明确确认');await bundleLaborUnit(em,user.companyId,labor,true);}
 }else if(line.productId!=null){
  product=await one(em,user.companyId,'finance-products',line.productId);
  if(!product||product.status!=='active'||product.archivedAt)throw new BadRequestException('档案组件不存在或已停用');
  const category=await one(em,user.companyId,'finance-categories',product.data.categoryId);
  if(!category||category.status!=='active'||category.archivedAt||(await host.findWhere(em,user.companyId,'finance-categories','parentId',category.id)).length)throw new BadRequestException('档案组件必须属于有效的末级分类');
  const family=product.data.archiveType==='purchased'?String(product.data.supplyMode||'original_purchase'):String(product.data.archiveType||'');
  const compatible=(data:Data)=>data.archiveType===family||['original_purchase','supplier_oem'].includes(family)&&data.archiveType==='original_purchase'&&data.importArchiveType==='purchased';
  const seen=new Set<number>();let parent:ResourceRecord|null=category;
  while(parent){if(seen.has(parent.id)||parent.status!=='active'||parent.archivedAt||!compatible(parent.data))throw new BadRequestException('档案组件分类类型或父级无效');seen.add(parent.id);const id=parent.data.parentId;if(id==null)break;parent=await one(em,user.companyId,'finance-categories',id);if(!parent)throw new BadRequestException('档案组件分类父级不存在或不属于当前公司');}
  if(!legacyImport){
   const units=await loadUnitLists(em,user.companyId),field=FINANCE_RESOURCE_DEFS.find(def=>def.key==='finance-products')!.fields.find(field=>field.key==='archiveType')!;
   const types=allowedValues(units,field,product.data)||field.options?.map(option=>option.value)||[];if(!types.includes(String(product.data.archiveType)))throw new BadRequestException('档案组件的归档类型无效');
   const probe=Object.assign(new ResourceRecord(),{type:'finance-base-codes',data:{productId:product.id}});const quality=await buildSnapshot(em,user.companyId,probe);
   if(quality.issues.length)throw new BadRequestException(`档案组件「${product.title}」资料不完整：${quality.issues[0].message}`);
   if(typeof product.data.totalCost!=='number'||!Number.isFinite(product.data.totalCost)||product.data.totalCost<0)throw new BadRequestException('档案组件缺少有效总成本');
  }
 }else{
  base=await one(em,user.companyId,'finance-base-codes',line.baseCodeId);if(!base)throw new BadRequestException('请选择当前公司的基础编码');
  if(base.status!=='verified'&&!legacyImport)throw new BadRequestException(`基础编码「${base.title}」还没验证，验证通过后才能加入组合`);
  const real=base.data.canonicalId==null?base:await one(em,user.companyId,'finance-base-codes',base.data.canonicalId);realBase=real;
  if(!real||real.archivedAt||real.status!=='verified'&&!legacyImport)throw new BadRequestException('真实基础编码不存在、已停用或尚未验证');
  product=await one(em,user.companyId,'finance-products',real.data.productId);
  if(!legacyImport){const quality=await buildSnapshot(em,user.companyId,base);if(quality.issues.length)throw new BadRequestException('基础编码来源资料需要核对：'+quality.issues[0].message);}
  if(['main','gift'].includes(role)&&!Number.isInteger(line.qty)&&!legacyImport)throw new BadRequestException('主品和赠品的数量必须是整数');
 }
 const normalized={...line};normalizeLineExtras(normalized,base,product);try{scaledDecimal(Number(normalized.lossRate||0),6);}catch{throw new BadRequestException('损耗率最多保留六位小数');}
 if(role!=='labor'){
  const sourceUnit=str(base?.data.baseUnit)||str(base?.data.codeSpecUnit)||str(realBase?.data.codeSpecUnit)||str(product?.data.specUnit)||str(product?.data.purchaseSpec);
  if(!sourceUnit&&!legacyImport)throw new BadRequestException('组成来源缺少计量单位，请先维护资料');
  if(sourceUnit){const lists=await loadUnitLists(em,user.companyId);normalized.unit=['spec_unit','shipping_unit','archive_unit'].map(kind=>unitValueFromText(lists,kind,sourceUnit)).find(Boolean)||sourceUnit;}
  if(normalized.includeInJst===true&&line.productId!=null&&!legacyImport)throw new BadRequestException('需上传的组成必须关联已验证的商品基础编码');
 }
 return pickLine(normalized);
}
