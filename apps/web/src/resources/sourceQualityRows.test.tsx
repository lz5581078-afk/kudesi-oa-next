import {expect,it} from 'vitest';
import {copySourceQualityRow,withSourceQualityKey} from './sourceQualityRows';
import {orderedSourceRows,sourceCollection,type SourceRow} from './ProductFormParts';
it('存量身份按实际ID，新行UUID稳定；复制及替换不携原身份',()=>{
 const old=withSourceQualityKey({rowId:17,qualityKey:crypto.randomUUID(),qty:2});
 expect(old.qualityKey).toBe('id:17');
 const copy=copySourceQualityRow(old);
 expect(copy).not.toHaveProperty('rowId');expect(copy.qualityKey).not.toBe(old.qualityKey);
 expect(withSourceQualityKey(copy).qualityKey).toBe(copy.qualityKey);
 const {rowId:_id,...replacement}=old;
 expect(withSourceQualityKey(replacement).qualityKey).not.toBe(old.qualityKey);
});
it('来源绑定顺序复用真正collection排序，过滤未选供应商而不按界面行号猜',()=>{
 const row=(id:number|null,time:string):SourceRow=>withSourceQualityKey({supplierId:id,purchasePrice:10,originArea:'产区',systemSpec:'袋',priceUpdatedAt:time});
 const rows=[row(3,'2026-11-03'),row(null,'2026-11-01'),row(2,'2026-11-02')];
 expect(orderedSourceRows(rows).map(r=>r.supplierId)).toEqual([2,3]);
 expect(sourceCollection(rows,[],true).rows.map(r=>r.values.supplierId)).toEqual(orderedSourceRows(rows).map(r=>r.supplierId));
 expect(orderedSourceRows(rows)[0].qualityKey).toBe(rows[2].qualityKey);
});
