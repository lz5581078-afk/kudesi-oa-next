import 'reflect-metadata';
import {randomBytes} from 'crypto';
import {DataSource} from 'typeorm';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,User,ResourceRecord,ResourceChangeLog,OutboxJob} from '../entities';
import {exportProductReferenceCsv, type ProductReferenceCsvRecord} from './product-reference-csv';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('原商品CSV只读投影（隔离MySQL）',()=>{
 let ds:DataSource,companyId:number,otherId:number,userId:number;
 const create=async(type:string,data:Record<string,unknown>,o:{companyId?:number;status?:string;title?:string;archivedAt?:Date}={})=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:o.companyId??companyId,type,data,status:o.status??'active',title:o.title??'合成标题',createdBy:userId,updatedBy:userId,archivedAt:o.archivedAt??null}));
 const dto=(r:ResourceRecord):ProductReferenceCsvRecord=>({id:r.id,type:r.type,status:r.status,statusReason:r.statusReason,data:r.data});
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:false} as never).initialize();
  const companies=await ds.manager.save(Company,['本','外'].map(s=>ds.manager.create(Company,{code:'pc'+randomBytes(7).toString('hex'),name:'CSV合成'+s,status:'active'})));[companyId,otherId]=companies.map(c=>c.id);
  userId=(await ds.manager.save(User,ds.manager.create(User,{companyId,account:'admin',name:'合成CSV核对',passwordHash:'synthetic',status:'active',isCompanyAdmin:true,mustChangePassword:false}))).id;
 });
 afterAll(async()=>{await ds?.destroy();});
 it('205条来源全部展开且含停用，无来源0行；删除归档跨公司来源不导出，整个过程只读',async()=>{
  const supplier=await create('finance-suppliers',{shortCode:'REAL'},{title:'真实供应商',status:'inactive'});
  const parent=await create('finance-categories',{}, {title:'父分类'}),cat=await create('finance-categories',{parentId:parent.id,categoryCode:'CAT'},{title:'叶分类'});
  const p=await create('finance-products',{archiveType:'raw',name:'原料',code:'R',materialCode:'M',categoryId:cat.id,specQty:2,specUnit:'合成单位',purchaseSpec:'斤',freight:0,handlingFee:33.5001});
  const empty=await create('finance-products',{archiveType:'raw',name:'不应出现的无来源商品'});
  await ds.manager.save(ResourceRecord,Array.from({length:205},(_,i)=>ds.manager.create(ResourceRecord,{companyId,type:'finance-product-sources',title:'来源'+i,status:i?'inactive':'active',data:{productId:p.id,supplierId:supplier.id,originArea:'产区'+i,systemSpec:'斤',purchasePrice:33.5001,privateField:'不导出秘密'},createdBy:userId,updatedBy:userId})));
  for(const o of [{status:'deleted'},{archivedAt:new Date()},{companyId:otherId}])await create('finance-product-sources',{productId:p.id,supplierId:supplier.id,originArea:'禁止来源'},o);
  const before=await ds.manager.find(ResourceRecord,{where:{companyId},order:{id:'ASC'}});
  const counts=async()=>[await ds.manager.count(ResourceChangeLog,{where:{companyId}}),await ds.manager.count(OutboxJob,{where:{companyId}})];const initial=await counts();
  const runner=ds.createQueryRunner();await runner.connect();
  try{
   const query=jest.spyOn(runner,'query');
   const result=await exportProductReferenceCsv(runner.manager,{companyId},'raw',[dto(p),dto(empty)],true);
   expect(result.count).toBe(205);const lines=result.csv.split('\n');expect(lines).toHaveLength(206);
   expect(lines[1]).toBe('R,M,原料,产区0,真实供应商,REAL,父分类 / 叶分类,2,合成单位,斤,0.335001,0,0.335001,CAT');
   expect(lines[205]).toContain('产区204');expect(result.csv).not.toMatch(/禁止来源|无来源|秘密|privateField/);
   expect(query).toHaveBeenCalledTimes(2);for(const [sql]of query.mock.calls)expect(sql).toMatch(/^SELECT /);
  }finally{await runner.release();}
  expect(await ds.manager.find(ResourceRecord,{where:{companyId},order:{id:'ASC'}})).toEqual(before);expect(await counts()).toEqual(initial);
 });
 it('无成本权限SQL不选来源价格，DTO缺值不回填价格或零；跨公司ID不会按同名猜测',async()=>{
  const foreign=await create('finance-suppliers',{shortCode:'FOREIGN'},{companyId:otherId,title:'同名供应商'});
  const category=await create('finance-categories',{categoryCode:'FOREIGN-CAT'},{companyId:otherId,title:'外公司分类'});
  await create('finance-suppliers',{shortCode:'LOCAL'},{title:'同名供应商'});
  const p=await create('finance-products',{archiveType:'shipping_material',name:'物料',categoryId:category.id,freight:999999,handlingFee:888888,purchasePrice:777777});
  await create('finance-product-sources',{productId:p.id,supplierId:foreign.id,originArea:'本公司产区',systemSpec:'个',purchasePrice:666666});
  const runner=ds.createQueryRunner();await runner.connect();
  try{
   const query=jest.spyOn(runner,'query');
   const result=await exportProductReferenceCsv(runner.manager,{companyId},'shipping_material',[dto(p)],false);
   expect(result.count).toBe(1);expect(result.csv).not.toMatch(/采购价|运费|装卸费|999999|888888|777777|666666|FOREIGN|LOCAL|同名供应商|外公司/);
   for(const [sql]of query.mock.calls)expect(sql).not.toMatch(/purchasePrice|freight|handlingFee/);
  }finally{await runner.release();}
  const q=await create('finance-products',{archiveType:'self_made',name:'缺失成本'});const result=await exportProductReferenceCsv(ds.manager,{companyId},'self_made',[dto(q)],true);
  expect(result.csv.split('\n')[1].split(',').slice(10,13)).toEqual(['','','']);
 });
 it('双外购严格按供货方式分族，品牌和单位走真实同公司引用；CSV转义保持原换行格式',async()=>{
  const brand=await create('finance-brands',{}, {title:'真品牌'});
  await create('finance-product-units',{kind:'spec_unit',name:'真单位',code:'CSVU'});
  const original=await create('finance-products',{archiveType:'purchased',name:'名称,"含逗号"\n换行',brandId:brand.id,specQty:'半袋',specUnit:'CSVU',purchaseSpec:'个',weightG:250,purchasePrice:33.5001},{status:'inactive'});original.statusReason='真实原因';
  const oem=await create('finance-products',{archiveType:'purchased',supplyMode:'supplier_oem',name:'OEM专属'});
  const rows=[dto(original),dto(oem)];const a=await exportProductReferenceCsv(ds.manager,{companyId},'original_purchase',rows,true);
  expect(a.count).toBe(1);expect(a.csv).toContain('"名称,""含逗号""\n换行",真品牌,半袋,真单位,个,,原装采购,0.25,0.335001,,,停用,真实原因,');expect(a.csv).not.toContain('OEM专属');
  const b=await exportProductReferenceCsv(ds.manager,{companyId},'supplier_oem',rows,true);expect(b.count).toBe(1);expect(b.csv).toContain('供应商OEM');expect(b.csv).not.toContain('原装采购');
 });
 it('CSV公式危险首字符加单引号，普通编码/引号/BOM与LF保持',async()=>{
  const p=await create('finance-products',{archiveType:'self_made',name:'普通名称',code:'NORMAL'});
  for(const prefix of ['=','+','-','@','\t','\r']){const record=dto(p);record.data={...record.data,name:prefix+'公式'};const result=await exportProductReferenceCsv(ds.manager,{companyId},'self_made',[record],true);expect(result.csv).toContain(prefix==='\r'?`"'${prefix}公式"`:`'${prefix}公式`);expect(result.csv.startsWith('\uFEFF')).toBe(true);}
  const result=await exportProductReferenceCsv(ds.manager,{companyId},'self_made',[dto(p)],true);expect(result.csv).toContain('\nNORMAL,普通名称,');
 });
 it('七族运费/装卸精确保留八位元，来源采购价及普通采购价仍六位元，缺失不补零',async()=>{
  for(const family of ['raw','shipping_material','self_made','original_purchase','supplier_oem','package','oem_package']){
   const p=await create('finance-products',{archiveType:['original_purchase','supplier_oem'].includes(family)?'purchased':family,supplyMode:family==='supplier_oem'?'supplier_oem':'original_purchase',name:'八位物流'+family,purchasePrice:12.3456,freight:12.345678,handlingFee:0.000001});
   if(['raw','shipping_material'].includes(family))await create('finance-product-sources',{productId:p.id,purchasePrice:12.3456});
   const result=await exportProductReferenceCsv(ds.manager,{companyId},family,[dto(p)],true);const lines=result.csv.split('\n'),headers=lines[0].replace(/^\uFEFF/,'').split(','),cells=lines[1].split(',');
   expect(cells[headers.indexOf('采购价')]).toBe('0.123456');expect(cells[headers.indexOf('运费')]).toBe('0.12345678');expect(cells[headers.indexOf('装卸费')]).toBe('0.00000001');
   const hidden=await exportProductReferenceCsv(ds.manager,{companyId},family,[dto(p)],false);expect(hidden.csv).not.toMatch(/采购价|运费|装卸费|0\.12345678|0\.00000001/);
  }
  const invalid=await create('finance-products',{archiveType:'self_made',name:'非法精度不伪造',purchasePrice:12.345678,freight:12.3456781});const result=await exportProductReferenceCsv(ds.manager,{companyId},'self_made',[dto(invalid)],true);const [head,line]=result.csv.split('\n'),labels=head.replace(/^\uFEFF/,'').split(','),values=line.split(',');for(const label of ['采购价','运费','装卸费'])expect(values[labels.indexOf(label)]).toBe('');
 });
 it('产品包装保留容量、重量单位、库存与状态；OEM包装不增状态字段',async()=>{
  const p=await create('finance-products',{archiveType:'package',name:'袋',capacities:'500克\n1千克',weightG:25,weightUnit:'g',orderStock:1.25,actualStock:0,productPackagingSpec:'500G袋',productPackagingUnit:'袋',purchasePrice:0,freight:0,handlingFee:0});
  const a=await exportProductReferenceCsv(ds.manager,{companyId},'package',[dto(p)],true);expect(a.csv).toContain('500克；1千克,,25,克,,0,0,0,1.25,0,正常,,');
  const o=await create('finance-products',{...p.data,archiveType:'oem_package'});const b=await exportProductReferenceCsv(ds.manager,{companyId},'oem_package',[dto(o)],true);expect(b.csv.split('\n')[0]).not.toMatch(/状态|停用原因/);
 });
});
