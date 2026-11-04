import {expect,it} from 'vitest';
import type {ResourceDto} from './api';
import {sourceProductQualityDraft} from './sourceProductQualityDraft';
import {withSourceQualityKey} from './sourceQualityRows';
const item=(id:number,data:Record<string,unknown>,refLabels:Record<string,string>={}):ResourceDto=>({id,type:'finance-products',title:'合成',status:'active',statusReason:null,data,refLabels,secretConfigured:{},files:{},createdAt:'',updatedAt:''});
it('采用真实单位code/人工单位名/独立人工空单位，不携导入金额；bindings与保存顺序相同',()=>{
 const sources=[withSourceQualityKey({supplierId:3,originArea:'甲',systemSpec:'袋',purchasePrice:20,priceUpdatedAt:'2026-11-03'}),withSourceQualityKey({supplierId:2,originArea:'乙',systemSpec:'张',purchasePrice:0,priceUpdatedAt:'2026-11-02'})];
 const bom=[withSourceQualityKey({kind:'component' as const,group:'raw' as const,id:10,qty:1,loss:2}),withSourceQualityKey({kind:'labor' as const,group:'labor' as const,id:11,qty:2,loss:0}),withSourceQualityKey({kind:'labor' as const,group:'labor' as const,id:null,qty:1,loss:0,importedLabor:{name:'旧人工',unitCost:99,sourceRowId:12,version:'old'}})];
 const result=sourceProductQualityDraft({name:'甲'},null,sources,bom,new Map([['component:10',item(10,{specUnit:'KG'})],['labor:11',item(11,{unitId:2},{unitId:'件'})]]),true,true);
 expect(result.rows.map(row=>row.key)).toEqual([sources[1].qualityKey,sources[0].qualityKey,...bom.map(row=>row.qualityKey)]);
 expect(result.facts.composition.map(row=>row.unit)).toEqual(['KG','件','']);
 expect(result.facts.composition[2]).toMatchObject({kind:'imported_labor',referenceId:null,importedLaborName:'旧人工'});
 expect(result.facts.composition[2]).not.toHaveProperty('unitCost');
 expect(result.facts.sources[1].purchasePrice).toBe(0);
});
it('实际引用资料未读到时明确阻止生成确认context，不用空单位冒充完整',()=>{
 expect(()=>sourceProductQualityDraft({},3,[],[withSourceQualityKey({kind:'component',group:'raw',id:10,qty:1,loss:0})],new Map(),false,true)).toThrow('组成档案正在读取');
});

it('草稿确认只保留当前零值及精确context，不把旧说明或变价转成确认',async()=>{
 const {archiveQualityContext}=await import('@kudesi/shared');
 const {currentSourceQualityConfirmations}=await import('./sourceProductQualityDraft');
 const facts=sourceProductQualityDraft({archiveType:'raw',freight:0,handlingFee:100},null,[],[],new Map(),true,false).facts;
 const receipt={freight:{reason:'真实自提',context:archiveQualityContext(facts)}};
 expect(currentSourceQualityConfirmations(receipt,facts)).toEqual(receipt);
 expect(currentSourceQualityConfirmations('运费：真实自提',facts)).toEqual({});
 expect(currentSourceQualityConfirmations(receipt,{...facts,parent:{...facts.parent,freight:1}})).toEqual({});
 expect(currentSourceQualityConfirmations(receipt,{...facts,parent:{...facts.parent,purchaseSpec:'新计量规格'}})).toEqual({});
});
