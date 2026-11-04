import type { ResourceDef } from './resources';
/** Original coding dictionaries are distinct from archive ownership categories. No menu is added. */
export const CODE_DICTIONARY_RESOURCE_DEFS:readonly ResourceDef[]=[{
  key:'finance-code-dictionaries',label:'商品编码字典',titleField:'name',defaultStatus:'active',
  statuses:[{value:'active',label:'启用',tone:'ok'},{value:'inactive',label:'停用',tone:'muted'}],
  categoryOrder:{sortField:'sort',scopeFields:['kind']},
  uniqueTogether:[{fields:['kind','code'],message:'同类编码字典已有此编码'}],
  fields:[
    {key:'kind',label:'字典类型',type:'select',group:'基础',required:true,options:[{value:'product_category',label:'商品编码分类'},{value:'variety',label:'品种'}]},
    {key:'name',label:'名称',type:'text',group:'基础',required:true,maxLength:160,search:true,list:true},
    {key:'code',label:'编码',type:'text',group:'基础',maxLength:48,list:true,help:'不填则按名称自动生成；导入模板必须明确提供编码'},
    {key:'parentId',label:'上级',type:'ref',ref:'finance-code-dictionaries',group:'基础'},
    {key:'sort',label:'排序',type:'number',group:'基础'},
  ],
}];
