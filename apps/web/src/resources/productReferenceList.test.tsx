import {expect,it} from 'vitest';
import {getResourceDef} from '@kudesi/shared';
import {productReferenceColumns,productReferenceText} from './productReferenceList';
import type {ResourceDto} from './api';
const def=getResourceDef('finance-products')!;
const row=(data:Record<string,unknown>):ResourceDto=>({id:1,type:def.key,title:'合成资料',data,status:'active',statusReason:null,files:{},refLabels:{},secretConfigured:{},createdAt:'',updatedAt:''});
it('原料与发货物料恢复供货来源、分类标识及独立最新档案成本列，不以总成本冒充',()=>{
 const expected=['系统自动编号','基础信息全名','供货来源','最新供应商','最新产区','所属分类','分类标识','系统规格','采购价','运费','装卸费','运费装卸费','最新成本','状态','操作'];
 for(const family of ['raw','shipping_material']){const columns=productReferenceColumns(def,family);expect(columns.map(f=>f.label)).toEqual(expected);const latest=columns.find(f=>f.label==='最新成本')!;expect(latest.key).toBe('latestUnitCost');expect(productReferenceText(latest,row({totalCost:12345}))).toBe('未维护');expect(latest.permission).toBe('product.cost.view');}
});
it('外购/自产与两类包装保留原版不同默认列',()=>{
 for(const family of ['original_purchase','supplier_oem','self_made']){const labels=productReferenceColumns(def,family).map(f=>f.label);expect(labels).toEqual([family==='self_made'?'自产成品编号':'外购成品编号','基础信息全名','所属分类','称重重量','采购价','运费','装卸费','运费装卸费','状态','操作']);}
 for(const family of ['package','oem_package'])expect(productReferenceColumns(def,family).map(f=>f.label)).toEqual([family==='package'?'产品包装编号':'OEM包装编号','基础信息全名','所属分类','容量','包装印刷公司','重量','系统规格','采购价','运费','装卸费','运费装卸费','订单库存','实际库存','最新成本','操作']);
});
it('至少三位并按各金额字段精度显示，缺失/脱敏值不伪造零，外购采购价按原两位',()=>{
 const fields=productReferenceColumns(def,'raw'),sum=fields.find(f=>f.key==='__freightHandling')!,price=fields.find(f=>f.key==='purchasePrice')!;
 expect(productReferenceText(sum,row({freight:20.0001,handlingFee:9.9999}))).toBe('¥0.300');expect(productReferenceText(sum,row({freight:0}))).toBe('-');expect(productReferenceText(sum,row({freight:20.000001,handlingFee:1}))).toBe('¥0.21000001');expect(productReferenceText(price,row({archiveType:'raw',purchasePrice:350.1234}))).toBe('¥3.501234');expect(productReferenceText(price,row({archiveType:'purchased',purchasePrice:350.1234}))).toBe('¥3.50');
 expect(productReferenceText(fields.find(f=>f.key==='__sourceCount')!,row({}))).toBe('-');
});

it('物流八位元逐费与合计保真，未知不造零，普通采购报价不放宽',()=>{
 const fields=productReferenceColumns(def,'raw'),field=(key:string)=>fields.find(f=>f.key===key)!;
 expect(productReferenceText(field('freight'),row({freight:12.345678}))).toBe('¥0.12345678');expect(productReferenceText(field('handlingFee'),row({handlingFee:0.000001}))).toBe('¥0.00000001');
 expect(productReferenceText(field('__freightHandling'),row({freight:12.345678,handlingFee:0.000001}))).toBe('¥0.12345679');
 for(const data of [{freight:12.345678},{freight:NaN,handlingFee:0},{freight:0.0000001,handlingFee:0},{freight:0,handlingFee:0}])expect(productReferenceText(field('__freightHandling'),row(data))).toBe('-');
 expect(productReferenceText(field('purchasePrice'),row({archiveType:'raw',purchasePrice:12.345678}))).toBe('-');
 expect(productReferenceText({...field('freight'),key:'totalCost',readonly:true},row({totalCost:12.345678}))).toBe('¥0.12345678');
});
