import {getSourceProductImportProfile} from './source-product-import-profiles';
export * from './source-product-import-profiles';
/** Workbook layouts are data. Every write is performed by the normal resource rules. */
export type ImportCellTransform = 'text' | 'upper' | 'number' | 'money' | 'kg-to-g' | 'boolean' | 'unit' | 'weight-to-g' | 'semicolon-lines';
export interface ImportValue {
  column?: string;
  aliases?: readonly string[];
  literal?: string | number | boolean | null;
  fallback?: string | number | boolean | null;
  transform?: ImportCellTransform;
  unitKind?:string;
  unitColumn?:string;
  map?: Readonly<Record<string, string>>;
  required?: boolean;
  today?: boolean;
  firstOf?: readonly ImportValue[];
  when?: { column: string; equals?: string; nonEmpty?: boolean; then: ImportValue; otherwise: ImportValue };
  related?: { sheet: string; ownerColumn: string; childColumn: string; value: ImportValue; prefer?: { column: string; in: readonly string[] } };
  reference?: { resource: string; fields?: Readonly<Record<string, ImportValue>>; anyFields?: readonly string[]; value?: ImportValue; namespace?: string; aliasValue?:ImportValue; activeOnly?: boolean; optionalMissing?:boolean; importedOwner?:boolean; returnField?:string; pathSeparator?:string; pathField?:string };
}
export interface ResourceImportStep {
  id: string;
  sheet: string;
  resource: string;
  fields: Readonly<Record<string, ImportValue>>;
  status?: ImportValue;
  statusReason?: ImportValue;
  where?: readonly { column: string; in?: readonly string[]; nonEmpty?: boolean; empty?: boolean }[];
  matchFields?: readonly string[];
  deduplicate?: readonly string[];
  rejectDuplicate?:readonly string[];
  conflictingRows?:readonly {field:string;values:readonly [string,string];identityFields:readonly string[];equalFields:readonly string[];message:string}[];
  namespace?: { name: string; columns: readonly string[]; savedFields?:readonly string[]; uniqueSource?:boolean };
  createOnly?: boolean;
  identity?:'product-code';
  rejectReferencedBy?: readonly { resource: string; field: string }[];
  replaceChildren?: { parentField: string; ownerNamespace: string };
  aggregate?: { groupBy: readonly string[]; sumMoney: readonly string[]; descriptions?: { target: string; name: string; amount: string } };
}
export interface ResourceImportSheet {
  name: string;
  headers: readonly string[];
  optional?: boolean;
  examples: readonly Readonly<Record<string,string>>[];
}
export interface ResourceImportProfile {
  id: string;
  label: string;
  sheets: readonly ResourceImportSheet[];
  steps: readonly ResourceImportStep[];
  maxRows: number;
  notes?: readonly string[];
  finalize?:'base-import';
  requiredChildren?:readonly {ownerNamespace:string;resource:string;parentField:string;field:string;equals:string;message:string}[];
}
const column=(name:string,extra:Partial<ImportValue>={}):ImportValue=>({column:name,...extra});
const literal=(value:string | number | boolean | null):ImportValue=>({literal:value});
const ref=(resource:string,fields:Record<string,ImportValue>,namespace?:string):ImportValue=>({reference:{resource,fields,namespace}});
export const IMPORT_ARCHIVE_ALIASES: Readonly<Record<string,string>> = {
  raw:'raw',原料:'raw',原料档案:'raw',self_made:'self_made',自产成品:'self_made',自产成品档案:'self_made',purchased:'purchased',外购成品:'purchased',外购成品档案:'purchased',原装采购成品:'purchased',供应商OEM成品:'purchased',package:'package',产品包装:'package',产品包装档案:'package',shipping_material:'shipping_material',发货物料:'shipping_material',发货物料档案:'shipping_material',oem_package:'oem_package',OEM包装:'oem_package',OEM包装档案:'oem_package',
};
const archive=column('档案类型',{map:IMPORT_ARCHIVE_ALIASES,required:true});
const categoryArchive:ImportValue={when:{column:'供货方式',equals:'supplier_oem',then:literal('supplier_oem'),otherwise:{when:{column:'供货方式',equals:'供应商OEM',then:literal('supplier_oem'),otherwise:column('档案类型',{required:true,map:{...IMPORT_ARCHIVE_ALIASES,purchased:'original_purchase',外购成品:'original_purchase',外购成品档案:'original_purchase',原装采购成品:'original_purchase',供应商OEM成品:'supplier_oem'}})}}}};
const active:ImportValue=column('状态',{fallback:'active',map:{启用:'active',正常:'active',active:'active',normal:'active',停用:'inactive',禁用:'inactive',inactive:'inactive'}});
const profileStatus:ImportValue=column('状态',{fallback:'active',map:{启用:'active',正常:'active',active:'active',normal:'active',停用:'inactive',禁用:'inactive',inactive:'inactive'}});
const category=(kind:ImportValue):ImportValue=>({when:{column:'二级分类',nonEmpty:true,then:ref('finance-categories',{archiveType:kind,name:column('二级分类',{required:true}),parentId:ref('finance-categories',{archiveType:kind,name:column('一级分类',{required:true}),parentId:literal(null)})}),otherwise:ref('finance-categories',{archiveType:kind,name:column('一级分类',{required:true}),parentId:literal(null)})}});
const codeCategory=():ImportValue=>({when:{column:'二级分类',nonEmpty:true,then:ref('finance-code-dictionaries',{kind:literal('product_category'),name:column('二级分类',{required:true}),parentId:ref('finance-code-dictionaries',{kind:literal('product_category'),name:column('一级分类',{required:true}),parentId:literal(null)})}),otherwise:ref('finance-code-dictionaries',{kind:literal('product_category'),name:column('一级分类',{required:true}),parentId:literal(null)})}});
const importedCategory=():ImportValue=>({firstOf:[{when:{column:'二级分类',nonEmpty:true,then:{reference:{resource:'finance-categories',fields:{importArchiveType:archive,name:column('二级分类',{required:true}),parentId:{reference:{resource:'finance-categories',fields:{importArchiveType:archive,name:column('一级分类',{required:true}),parentId:literal(null)},optionalMissing:true}}},optionalMissing:true}},otherwise:{reference:{resource:'finance-categories',fields:{importArchiveType:archive,name:column('一级分类',{required:true}),parentId:literal(null)},optionalMissing:true}}}},category(categoryArchive)]});
const product=(codeColumn:string,kind?:ImportValue):ImportValue=>ref('finance-products',{code:column(codeColumn,{required:true}),...(kind?{archiveType:kind}:{})},'products');
const sheet=(name:string,headers:readonly string[],examples:ResourceImportSheet['examples']=[],optional=false):ResourceImportSheet=>({name,headers,examples,...(optional?{optional:true}:{})});
const importedProduct=(columnName:string):ImportValue=>({reference:{resource:'finance-products',fields:{code:column(columnName,{required:true})},namespace:'products',importedOwner:true}});
const baseOwner:ImportValue={reference:{resource:'finance-base-codes',fields:{code:column('商品基础编码',{required:true})},namespace:'base-codes',importedOwner:true}};
const dictionaryKind=column('字典类型',{required:true,map:{product_category:'product_category',商品分类:'product_category',一级分类:'product_category',二级分类:'product_category',brand:'brand',品牌:'brand',variety:'variety',品种:'variety',spec_unit:'spec_unit',规格单位:'spec_unit',单位:'spec_unit'}});
const dictWhere=(...values:string[])=>[{column:'字典类型',in:values}];
const role=column('角色',{fallback:'other',map:{主商品:'main',主要商品:'main',主要:'main',主料:'main',main:'main',辅助:'auxiliary',辅助商品:'auxiliary',辅料:'auxiliary',auxiliary:'auxiliary',包装:'package',package:'package',标签:'label',label:'label',说明书:'instruction',instruction:'instruction',赠品:'gift',gift:'gift',其他:'other',other:'other'}});
const money=(name:string):ImportValue=>column(name,{transform:'money'});

export const RESOURCE_IMPORT_PROFILES: readonly ResourceImportProfile[] = [
  {id:'archive_categories',label:'商品档案分类',maxRows:5000,sheets:[sheet('档案分类',['档案类型','一级分类','一级分类编码','二级分类','二级分类编码','排序','状态'],[{档案类型:'原料',一级分类:'合成原料',一级分类编码:'HC',二级分类:'合成苹果',二级分类编码:'PG',排序:'10',状态:'启用'}])],steps:[
    {id:'roots',sheet:'档案分类',resource:'finance-categories',fields:{archiveType:categoryArchive,importArchiveType:archive,name:column('一级分类',{required:true}),code:column('一级分类编码',{required:true,transform:'upper'}),sort:column('排序',{transform:'number',fallback:0})},status:active,matchFields:['archiveType','name','parentId'],deduplicate:['archiveType','name']},
    {id:'children',sheet:'档案分类',resource:'finance-categories',where:[{column:'二级分类',nonEmpty:true}],fields:{archiveType:categoryArchive,importArchiveType:archive,name:column('二级分类',{required:true}),code:column('二级分类编码',{required:true,transform:'upper'}),parentId:ref('finance-categories',{archiveType:categoryArchive,name:column('一级分类',{required:true}),parentId:literal(null)}),sort:column('排序',{transform:'number',fallback:0})},status:active,matchFields:['archiveType','name','parentId']},
  ]},
  {id:'dictionaries',label:'商品编码字典',maxRows:5000,sheets:[sheet('字典数据',['字典类型','上级名称','名称','编码','排序','状态'],[{字典类型:'商品分类',名称:'合成商品',编码:'HCSP',排序:'10',状态:'启用'},{字典类型:'商品分类',上级名称:'合成商品',名称:'合成苹果',编码:'PG',排序:'10',状态:'启用'},{字典类型:'品种',名称:'合成苹果',编码:'PG',状态:'启用'},{字典类型:'品牌',名称:'合成品牌',编码:'HCPP',排序:'10',状态:'启用'},{字典类型:'规格单位',名称:'千克',编码:'KG',排序:'10',状态:'启用'}])],notes:['编码字典按种类保存；不把商品编码分类猜成档案归属类型。'],steps:[
    {id:'brands',sheet:'字典数据',resource:'finance-brands',where:[...dictWhere('brand','品牌'),{column:'上级名称',empty:true}],fields:{name:column('名称',{required:true}),code:column('编码',{required:true,transform:'upper'}),sortOrder:column('排序',{transform:'number',fallback:0})},status:active,matchFields:['name'],rejectDuplicate:['name']},
    {id:'spec-units',sheet:'字典数据',resource:'finance-product-units',where:[...dictWhere('spec_unit','规格单位','单位'),{column:'上级名称',empty:true}],fields:{kind:literal('spec_unit'),name:column('名称',{required:true}),code:column('编码',{required:true,transform:'upper'}),sortOrder:column('排序',{transform:'number',fallback:0})},status:active,matchFields:['kind','name'],rejectDuplicate:['kind','name']},
    {id:'code-dictionary-roots',sheet:'字典数据',resource:'finance-code-dictionaries',namespace:{name:'code-category-roots',columns:['名称']},where:[{column:'字典类型',in:['product_category','商品分类','一级分类','二级分类']},{column:'上级名称',empty:true}],fields:{kind:dictionaryKind,name:column('名称',{required:true}),code:column('编码',{required:true,transform:'upper'}),sort:column('排序',{transform:'number',fallback:0})},status:active,matchFields:['kind','name','parentId'],rejectDuplicate:['kind','name']},
    {id:'varieties',sheet:'字典数据',resource:'finance-code-dictionaries',where:[...dictWhere('variety','品种'),{column:'上级名称',empty:true}],fields:{kind:literal('variety'),name:column('名称',{required:true}),code:column('编码',{required:true,transform:'upper'}),sort:column('排序',{transform:'number',fallback:0})},status:active,matchFields:['kind','name','parentId'],rejectDuplicate:['kind','name']},
    {id:'code-dictionary-children',sheet:'字典数据',resource:'finance-code-dictionaries',where:[{column:'字典类型',in:['product_category','商品分类','一级分类','二级分类']},{column:'上级名称',nonEmpty:true}],fields:{kind:literal('product_category'),name:column('名称',{required:true}),code:column('编码',{required:true,transform:'upper'}),parentId:{reference:{resource:'finance-code-dictionaries',fields:{kind:literal('product_category'),name:column('上级名称',{required:true}),parentId:literal(null)},namespace:'code-category-roots',aliasValue:column('上级名称',{required:true}),importedOwner:true}},sort:column('排序',{transform:'number',fallback:0})},status:active,matchFields:['kind','name','parentId'],rejectDuplicate:['kind','name']},
  ]},
  {id:'archive_units',label:'商品档案单位',maxRows:5000,sheets:[sheet('档案单位',['单位名称','单位编码','排序'],[{单位名称:'千克',单位编码:'KG',排序:'10'}])],steps:[{id:'units',sheet:'档案单位',resource:'finance-product-units',fields:{kind:literal('archive_unit'),name:column('单位名称',{required:true}),code:column('单位编码',{transform:'upper'}),sortOrder:column('排序',{transform:'number',fallback:0})},matchFields:['kind','name']}]},
  {id:'platforms',label:'销售平台',maxRows:5000,sheets:[sheet('销售平台',['平台名称','平台编码','排序','状态'],[{平台名称:'合成平台',平台编码:'HCPT',排序:'10',状态:'启用'}])],steps:[{id:'platforms',sheet:'销售平台',resource:'finance-platforms',fields:{name:column('平台名称',{required:true}),code:column('平台编码',{required:true,transform:'upper'}),sortOrder:column('排序',{transform:'number',fallback:0})},status:active,matchFields:['name']}]},
  {id:'product_archives',label:'商品档案',maxRows:5000,sheets:[
    sheet('商品档案',['档案类型','档案编号','档案名称','一级分类','二级分类','品牌','规格数量','单位','形态样式','称重重量kg','供货方式','状态','备注'],[{档案类型:'原料',档案编号:'YL-HC-PG-HCPG-1KG',档案名称:'合成苹果',一级分类:'合成原料',二级分类:'合成苹果',规格数量:'1',单位:'千克',状态:'启用'}]),
    sheet('原料明细',['成品档案编号','原料编号','用量'],[],true),sheet('包装明细',['成品档案编号','产品包装编号','用量'],[],true),sheet('OEM包装明细',['成品档案编号','OEM包装编号','用量'],[],true),sheet('人工成本明细',['成品档案编号','人工成本名称','金额'],[],true),
  ],steps:[
    {id:'products',sheet:'商品档案',resource:'finance-products',identity:'product-code',fields:{archiveType:archive,code:column('档案编号'),name:column('档案名称',{required:true}),categoryId:importedCategory(),brandId:{reference:{resource:'finance-brands',anyFields:['name','code'],value:column('品牌')}},specQty:column('规格数量',{required:true}),unitDictionaryKind:literal('archive_unit'),specUnit:column('单位',{required:true,transform:'unit',unitKind:'archive_unit'}),purchaseSpec:column('单位',{required:true}),shape:column('形态样式'),weightG:column('称重重量kg',{transform:'kg-to-g'}),weightManual:{when:{column:'称重重量kg',nonEmpty:true,then:literal(true),otherwise:literal(false)}},supplyMode:column('供货方式',{fallback:'original_purchase',map:{供应商OEM:'supplier_oem','供应商 OEM':'supplier_oem',supplier_oem:'supplier_oem',原装采购:'original_purchase',外购原装:'original_purchase',original_purchase:'original_purchase'}}),note:column('备注')},status:profileStatus,namespace:{name:'products',columns:['档案编号'],savedFields:['code']},matchFields:['code']},
    ...(['原料明细','包装明细','OEM包装明细'] as const).map((name,index):ResourceImportStep=>({id:`product-components-${index}`,sheet:name,resource:'finance-product-boms',fields:{productId:importedProduct('成品档案编号'),componentId:product(['原料编号','产品包装编号','OEM包装编号'][index],literal(['raw','package','oem_package'][index])),qty:column('用量',{required:true,transform:'number'})},replaceChildren:{parentField:'productId',ownerNamespace:'products'}})),
    {id:'labor-details',sheet:'人工成本明细',resource:'finance-product-boms',fields:{productId:importedProduct('成品档案编号'),importLineKind:literal('labor'),importLaborName:column('人工成本名称',{required:true}),importLaborCost:column('金额',{required:true,transform:'money'}),qty:literal(1)},replaceChildren:{parentField:'productId',ownerNamespace:'products'}},
  ]},
  {id:'base_codes',label:'商品基础编码',maxRows:5000,finalize:'base-import',sheets:[sheet('商品基础编码',['商品基础编码','款式编码','商品名称','简称','一级分类','二级分类','品牌','品种','规格数量','规格单位','基本单位','称重重量kg','成本价','采购价','状态'],[{商品基础编码:'HC-PG-1KG',款式编码:'HC-PG',商品名称:'合成苹果编码',一级分类:'合成商品',二级分类:'合成苹果',品牌:'合成品牌',品种:'合成苹果',规格数量:'1',规格单位:'千克',基本单位:'千克',称重重量kg:'1',成本价:'12.123456',采购价:'10',状态:'启用'}]),sheet('基础编码组成',['商品基础编码','档案类型','档案编号','角色','数量','单位','排序','备注'],[{商品基础编码:'HC-PG-1KG',档案类型:'原料',档案编号:'YL-HC-PG-HCPG-1KG',角色:'主商品',数量:'1'}])],notes:['已有组合引用的基础编码不可覆盖。外部历史编码保留成本价和采购价事实，档案组成另行关联，不生成虚构商品档案。'],steps:[
    {id:'base-codes',sheet:'商品基础编码',resource:'finance-base-codes',fields:{origin:literal('external_import'),codeDictionaryCategoryId:codeCategory(),codeBrandId:{reference:{resource:'finance-brands',anyFields:['name','code'],value:column('品牌')}},varietyDictionaryId:{reference:{resource:'finance-code-dictionaries',fields:{kind:literal('variety')},anyFields:['name','code'],value:column('品种'),optionalMissing:true}},baseUnit:column('基本单位'),externalCost:money('成本价'),externalPurchasePrice:money('采购价'),code:column('商品基础编码',{required:true}),styleCode:column('款式编码'),name:column('商品名称',{required:true}),shortName:column('简称'),varietyName:column('品种',{required:true}),codeSpecQty:column('规格数量',{transform:'number',required:true}),codeSpecUnit:column('规格单位',{transform:'unit',required:true,unitKind:'spec_unit'}),weightG:column('称重重量kg',{transform:'kg-to-g'}),codeChangeReason:literal('Excel历史编码导入')},status:column('状态',{fallback:'pending',map:{pending:'pending',启用:'pending',正常:'pending',active:'pending',normal:'pending',停用:'disabled',禁用:'disabled',inactive:'disabled'}}),namespace:{name:'base-codes',columns:['商品基础编码'],savedFields:['code']},matchFields:['code'],rejectDuplicate:['code'],rejectReferencedBy:[{resource:'finance-bundle-lines',field:'baseCodeId'}]},
    {id:'base-components',sheet:'基础编码组成',resource:'finance-base-code-lines',fields:{baseCodeId:baseOwner,productId:product('档案编号',archive),role:column('角色',{fallback:'auxiliary',map:{主商品:'main',主要商品:'main',主要:'main',主料:'main',main:'main',辅助:'auxiliary',辅助商品:'auxiliary',辅料:'auxiliary',auxiliary:'auxiliary'}}),qty:column('数量',{transform:'number',required:true}),unit:{firstOf:[column('单位',{transform:'unit',unitKind:'archive_unit'}),{reference:{resource:'finance-products',fields:{code:column('档案编号',{required:true}),archiveType:archive},namespace:'products',returnField:'specUnit'}}]},sortOrder:column('排序',{transform:'number',fallback:0}),remark:column('备注')},replaceChildren:{parentField:'baseCodeId',ownerNamespace:'base-codes'}},
  ]},
  {id:'bundle_codes',label:'商品组合编码与BOM',maxRows:5000,requiredChildren:[{ownerNamespace:'bundles',resource:'finance-bundle-lines',parentField:'bundleId',field:'role',equals:'main',message:'每个组合至少需要一个主商品组件'}],sheets:[sheet('商品组合编码',['组合编码','款式编码','组合名称','简称','一级分类','二级分类','基本单位','称重重量kg','平台','销售场景','配置号','规格','BOM版本','生效日期','状态','备注'],[{组合编码:'HC-BUNDLE-001',组合名称:'合成苹果组合',一级分类:'合成商品',二级分类:'合成苹果',平台:'合成平台',销售场景:'标准销售',配置号:'01',BOM版本:'V01',状态:'启用'}]),sheet('组合BOM',['组合编码','组件类型','组件编码','角色','数量','单位','损耗率','成本归类','计价处理','必选','进入聚水潭组合','排序','备注'],[{组合编码:'HC-BUNDLE-001',组件类型:'基础编码',组件编码:'HC-PG-1KG',角色:'主商品',数量:'1',单位:'千克',计价处理:'计入',必选:'是'}])],notes:['已存在组合编码不会静默覆盖；导入不发布或上传聚水潭。'],steps:[
    {id:'bundles',sheet:'商品组合编码',resource:'finance-bundles',createOnly:true,namespace:{name:'bundles',columns:['组合编码'],savedFields:['code']},fields:{manualCode:column('组合编码',{required:true}),manualStyleCode:column('款式编码'),manualName:column('组合名称',{required:true}),manualShortName:column('简称'),manualPropertiesValue:column('规格'),manualReason:literal('Excel历史编码原样导入'),codeDictionaryCategoryId:codeCategory(),platformId:{reference:{resource:'finance-platforms',anyFields:['name','code'],value:column('平台',{required:true})}},scenarioId:{firstOf:[{reference:{resource:'finance-scenarios',anyFields:['name','code'],value:column('销售场景'),optionalMissing:true}},{reference:{resource:'finance-scenarios',fields:{code:{when:{column:'销售场景',equals:'供应链销售',then:literal('supply_chain'),otherwise:{when:{column:'销售场景',equals:'供应链',then:literal('supply_chain'),otherwise:literal('standard')}}}}}}}]},baseUnit:column('基本单位'),configNo:column('配置号'),bomVersion:column('BOM版本',{fallback:'V01'}),bomEffectiveFrom:column('生效日期'),manualWeightG:column('称重重量kg',{transform:'kg-to-g'}),weightMode:{when:{column:'称重重量kg',nonEmpty:true,then:literal('manual'),otherwise:literal('auto')}},overrideReason:{when:{column:'称重重量kg',nonEmpty:true,then:literal('Excel历史称重导入'),otherwise:literal('')}},note:column('备注')},status:column('状态',{fallback:'pending',map:{pending:'pending',启用:'pending',正常:'pending',active:'pending',normal:'pending',停用:'inactive',禁用:'inactive',inactive:'inactive'}}),matchFields:['manualCode']},
    {id:'bundle-lines',sheet:'组合BOM',resource:'finance-bundle-lines',conflictingRows:[{field:'role',values:['main','auxiliary'],identityFields:['bundleId','baseCodeId','productId'],equalFields:['qty','lossRate'],message:'同一组件同时作为主商品与辅助组成，且数量及损耗率相同，会重复计算成本'}],fields:{bundleId:{reference:{resource:'finance-bundles',fields:{code:column('组合编码',{required:true})},namespace:'bundles',importedOwner:true}},baseCodeId:{when:{column:'组件类型',equals:'基础编码',then:ref('finance-base-codes',{code:column('组件编码',{required:true})},'base-codes'),otherwise:literal(null)}},productId:{when:{column:'组件类型',equals:'基础编码',then:literal(null),otherwise:product('组件编码',column('组件类型',{map:IMPORT_ARCHIVE_ALIASES}))}},role,qty:column('数量',{required:true,transform:'number'}),unit:column('单位',{required:true,transform:'unit',unitKind:'spec_unit'}),lossRate:column('损耗率',{transform:'number',fallback:0}),costBucket:column('成本归类',{map:{purchase:'purchase',采购成本:'purchase',transfer:'transfer',调运成本:'transfer',pre_ship_package:'pre_ship_package',发货前包装成本:'pre_ship_package',production:'production',生产成本:'production',shipping_package:'shipping_package',发货包装成本:'shipping_package',express:'express',快递成本:'express'}}),costTreatment:column('计价处理',{fallback:'include',map:{计入:'include',include:'include',已含上级:'included_in_parent',含在上级内:'included_in_parent',included_in_parent:'included_in_parent',仅参考:'reference_only',reference_only:'reference_only'}}),isRequired:column('必选',{transform:'boolean',fallback:true}),includeInJst:column('进入聚水潭组合',{transform:'boolean',fallback:false}),sortOrder:column('排序',{transform:'number',fallback:0}),note:column('备注')}},
  ]},
];

export function getResourceImportProfile(id:string) { return RESOURCE_IMPORT_PROFILES.find(profile=>profile.id===id) ?? getSourceProductImportProfile(id); }
