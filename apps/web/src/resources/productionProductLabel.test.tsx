import {afterEach,expect,it} from 'vitest';
import type {ResourceDto} from './api';
import {productionProductLabel} from './productionProductLabel';
import {resetUnitOptionsForTest} from './unitOptions';
afterEach(()=>resetUnitOptionsForTest({}));
it.each(['raw','self_made','original_purchase','supplier_oem','package','oem_package','shipping_material'])('%s生产标签仅名称/实际品牌/名称规格单位，不串生产编号',family=>{
 resetUnitOptionsForTest({archive_unit:[{value:'KG',label:'千克'}],shipping_unit:[{value:'KG',label:'千克'}]});
 const item:ResourceDto={id:1,type:'finance-products',title:'合成原料',status:'active',statusReason:null,data:{archiveType:family,name:'合成原料',brandId:2,specQty:1,specUnit:'KG',unitDictionaryKind:family==='shipping_material'?'shipping_unit':'archive_unit',basicInfoFullName:'合成原料-合成品牌-1-千克-HC01',materialCode:'HC01'},refLabels:{brandId:'合成品牌'},files:{},secretConfigured:{},createdAt:'',updatedAt:''};
 expect(productionProductLabel(item)).toBe('合成原料 · 合成品牌 · 1千克');
 expect(productionProductLabel({...item,data:{...item.data,brandId:undefined}})).toBe('合成原料 · 1千克');
 expect(productionProductLabel({...item,data:{...item.data,specQty:undefined}})).toBe('合成原料 · 合成品牌 · 千克');
});
