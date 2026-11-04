import { EntityManager } from 'typeorm';
import { exportProductReferenceCsv, PRODUCT_REFERENCE_CSV_COLUMNS } from './product-reference-csv';

const headers:Record<string,string>={
 raw:'系统自动编号,原料生产编码,原料名称,产区,供应商名称,供应商简称编码,所属分类,规格,名称单位,系统规格,采购价,运费,装卸费,分类标识',
 shipping_material:'系统自动编号,物料生产编码,发货物料名称,产区,供应商名称,供应商简称编码,所属分类,规格,规格单位,系统规格,采购价,运费,装卸费,分类标识',
 self_made:'自产成品编号,自产成品名称,品牌,名称规格,名称单位,产品包装规格,产品包装单位,系统规格,所属分类,称重重量,采购价,运费,装卸费,状态,停用原因,分类标识',
 original_purchase:'外购成品编号,外购成品名称,品牌,名称规格,名称单位,系统规格,所属分类,供货方式,称重重量,采购价,运费,装卸费,状态,停用原因,分类标识',
 supplier_oem:'外购成品编号,外购成品名称,品牌,名称规格,名称单位,系统规格,所属分类,供货方式,称重重量,采购价,运费,装卸费,状态,停用原因,分类标识',
 package:'产品包装编号,所属分类,包装类别,包装名称,品牌,尺寸,尺寸单位,容量明细,包装印刷公司,重量,重量单位,系统规格,采购价,运费,装卸费,订单库存,实际库存,状态,停用原因,分类标识',
 oem_package:'OEM包装编号,所属分类,包装类别,包装名称,品牌,尺寸,尺寸单位,容量明细,包装印刷公司,重量,重量单位,系统规格,采购价,运费,装卸费,订单库存,实际库存,分类标识',
};
describe('原商品档案CSV固定文件合同',()=>{
 const em={createQueryBuilder:jest.fn()} as unknown as EntityManager;
 it.each(Object.keys(headers))('%s表头顺序与原版一致；空文件也有BOM，且不查数据库',async family=>{
  const result=await exportProductReferenceCsv(em,{companyId:1},family,[],true);
  expect(result.csv).toBe('\uFEFF'+headers[family]);expect(result.count).toBe(0);expect(result.filename).toMatch(/-全部\.csv$/);
  expect(em.createQueryBuilder).not.toHaveBeenCalled();
 });
 it.each(Object.keys(headers))('%s无成本读权限同时移除三个表头',async family=>{
  const result=await exportProductReferenceCsv(em,{companyId:1},family,[],false,{selectedCount:2});
  expect(result.csv).toBe('\uFEFF'+headers[family].split(',').filter(s=>!['采购价','运费','装卸费'].includes(s)).join(','));
  expect(result.filename).toMatch(/-已选2条\.csv$/);
 });
 it('未知族明确失败，不偷偷退回通用资料格式',async()=>{
  expect(Object.keys(PRODUCT_REFERENCE_CSV_COLUMNS)).toHaveLength(7);
  for(const family of ['purchased','__proto__','toString'])await expect(exportProductReferenceCsv(em,{companyId:1},family,[],true)).rejects.toThrow('请选择有效商品档案类型');
 });
});
