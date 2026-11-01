import type { FieldDef } from '@kudesi/shared';

type Shape=true|{[key:string]:Shape}|readonly [Shape];
const line={baseCodeId:true,componentType:true,displayName:true,includeInJstBundle:true,isRequired:true,lossRate:true,quantity:true,role:true,sortOrder:true,sourceCode:true} as const;
const payload:Shape={note:true,lines:[line],status:true,baseUnit:true,specName:true,shortName:true,versionNo:true,bundleName:true,laborLines:[{laborItemId:true,quantity:true}],notRequired:{label:true,other:true,package:true,labor:true},platformCodes:[{platformId:true}],salesScenario:true,warehouseNote:true,propertiesCode:true,weighingWeight:true,propertiesValue:true,brandManual:true,brandDictionaryId:true,configurationCode:true,productCategoryDictionaryId:true,reuseInfo:{issues:true,laborKeys:true,lineKeys:true,sourceId:true,sourceName:true,sourceWeight:true,statuses:{label:true,labor:true,other:true,package:true},targetWeight:true}};
const inspection:Shape={labor:[{laborItemId:true,quantity:true,source:{code:true,cost:true,id:true,name:true,unit:true,versionId:true}}],platforms:[{conflict:true,existing:true,finalCode:true,platformId:true,productName:true}],sources:[true],totalCost:true,weight:true};
const code={finalCode:true,finalStyleCode:true,id:true,mainStyleCode:true,platformId:true,platformName:true,productName:true,shortName:true} as const;
const result:Shape={id:true,bomId:true,codes:[code],finalCode:true,syncStatus:true,definitionId:true,existingCodes:true,costTable:{entries:[{id:true,skuCode:true}]} };
const sync:Shape=[{canonicalId:true,id:true,message:true,status:true}];
const confirmation:Shape={actorId:true,confirmedAt:true,matches:[{code:true,id:true,name:true}],reason:true,token:true};
const parsed=(v:unknown):unknown=>v==null?null:typeof v==='string'?JSON.parse(v):v;
/** Closed SKU schemas were inventoried from the original source. Reject new
 * fields instead of dumping arbitrary JSON (which could contain credentials).
 * Unknown nonempty structures must be reviewed before exposing them. */
function check(value:unknown,shape:Shape,path:string):void{
  if(value==null)return;
  if(shape===true){
    if(['string','number','boolean'].includes(typeof value))return;
    if(Array.isArray(value)&&value.every(v=>v==null||['string','number','boolean'].includes(typeof v)))return;
    // Old unused collections are empty. A newly populated structure is unknown.
    if(typeof value==='object'&&Object.keys(value).length===0)return;
    throw Error('旧历史流程表单存在未核对结构：'+path);
  }
  if(Array.isArray(shape)){
    if(!Array.isArray(value))throw Error('旧历史流程表单集合结构不符：'+path);
    for(const item of value)check(item,shape[0],path+'[]');return;
  }
  if(typeof value!=='object'||Array.isArray(value))throw Error('旧历史流程表单对象结构不符：'+path);
  for(const [key,v] of Object.entries(value)){
    if(!Object.prototype.hasOwnProperty.call(shape,key))throw Error('旧历史流程表单存在未核对字段：'+path+'.'+key);
    check(v,(shape as Record<string,Shape>)[key],path+'.'+key);
  }
}
const field=(key:string,label:string,permission?:string):FieldDef=>({key,label,type:'textarea',group:'原SKU快照',readonly:true,...(permission?{permission}:{})});
export const CLOSED_SKU_FIELDS:FieldDef[]=[field('legacySkuPayload','原SKU申请资料')];
export const CLOSED_SKU_STEP_FIELDS:FieldDef[]=[
  field('legacySkuPayload','原节点申请资料'),
  field('legacySkuInspection','原核对结果','product.cost.view'),
  field('legacySkuResult','原编码结果'),
  field('legacySkuSync','原同步结果','finance.bundle-sync.manage'),
  field('legacyDuplicateConfirmation','原重复编码确认'),
];
const text=(v:unknown)=>JSON.stringify(v,null,2);
export function closedSkuPayload(value:unknown):Record<string,string>{
  const v=parsed(value);check(v,payload,'payload');return v==null?{}:{legacySkuPayload:text(v)};
}
export function closedSkuForm(value:unknown):Record<string,string>{
  const v=parsed(value);
  if(v==null)return {};
  check(v,{payload,result:{...(result as Record<string,Shape>),sync},inspection,duplicateConfirmation:confirmation},'form');
  const src=v as Record<string,any>,out:Record<string,string>={...closedSkuPayload(src.payload)};
  if(src.inspection!=null)out.legacySkuInspection=text(src.inspection);
  if(src.result!=null){
    const {sync:oldSync,...rest}=src.result;out.legacySkuResult=text(rest);
    if(oldSync!=null)out.legacySkuSync=text(oldSync);
  }
  if(src.duplicateConfirmation!=null){
    // The original confirmation token stays in the encrypted evidence, never in
    // the public historical form or in a new authorization mechanism.
    const {token:_,...rest}=src.duplicateConfirmation;out.legacyDuplicateConfirmation=text(rest);
  }
  return out;
}
