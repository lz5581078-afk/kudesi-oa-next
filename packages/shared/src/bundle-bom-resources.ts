import type {ResourceDef} from './resources';
/** 独立BOM版本仍走统一子资料，不增加导航或第二套组成发布流程。 */
export const BUNDLE_BOM_RESOURCES:readonly ResourceDef[]=[{
 key:'finance-bundle-bom-versions',label:'组合BOM版本',parent:{type:'finance-bundles',field:'bundleId'},titleField:'label',uniqueField:'scopeKey',defaultStatus:'inactive',formChildren:[],
 statuses:[{value:'unknown',label:'启用情况未记录',tone:'muted'},{value:'inactive',label:'草稿/停用',tone:'muted'},{value:'active',label:'已启用',tone:'ok'}],
 fields:[
 {key:'label',label:'BOM版本',type:'text',group:'基础',readonly:true,maxLength:120},
 {key:'bundleId',label:'组合定义',type:'ref',ref:'finance-bundles',group:'基础',required:true},
 {key:'versionNo',label:'版本号',type:'text',group:'基础',maxLength:40},
 {key:'effectiveFrom',label:'生效日期',type:'date',group:'基础'},
 {key:'effectiveTo',label:'失效日期',type:'date',group:'基础'},
 {key:'remark',label:'备注',type:'textarea',group:'基础',maxLength:2000},
 {key:'payload',label:'组成明细',type:'textarea',group:'基础',maxLength:1000000},
 {key:'copyFromId',label:'复制来源BOM',type:'ref',ref:'finance-bundle-bom-versions',group:'基础'},
 {key:'definitionKey',label:'定义标识',type:'text',group:'系统',readonly:true,listOnly:true,maxLength:100},
 {key:'scopeKey',label:'版本标识',type:'text',group:'系统',readonly:true,listOnly:true,maxLength:160},
 {key:'sourceFacts',label:'组成来源事实',type:'textarea',group:'系统',readonly:true,listOnly:true,maxLength:1000000},
 {key:'activatedAt',label:'首次启用时间',type:'text',group:'基础',readonly:true,maxLength:40},
 {key:'sealedAt',label:'历史锁定时间',type:'text',group:'基础',readonly:true,maxLength:40},
 ],
}];
