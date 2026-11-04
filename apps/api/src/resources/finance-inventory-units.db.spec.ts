import 'reflect-metadata';
import {randomBytes} from 'node:crypto';
import {DataSource} from 'typeorm';
import type {AuthUser} from '../common/auth.decorators';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,FinanceDocumentLine,FinanceEntry,ResourceRecord,User} from '../entities';
import {buildServices} from '../test-support';
import {FinanceDocumentsService} from './finance-documents.service';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('库存单位快照、旧明细与单位内扣减（真实隔离数据库）',()=>{
  let ds:DataSource,docs:FinanceDocumentsService,actor:AuthUser,categoryId:number,supplierId:number,customerId:number,warehouseId:number,sequence=0;
  let resources:ReturnType<typeof buildServices>['resources'];
  const product=async()=>await resources.create(actor,'finance-products',{archiveType:'raw',name:`合成单位商品${++sequence}`,categoryId,specQty:1,specUnit:'KG',purchaseSpec:'千克',purchasePrice:1000,freight:0,handlingFee:0,zeroValueReason:'运费：无\n装卸费：无'});
  const draft=async(productId:number,unit:string|undefined,qty=2,type:'purchase-in'|'sale'='purchase-in')=>await docs.createDraft(actor,{type,date:'2026-11-03',partyId:type==='sale'?customerId:supplierId,warehouseId,lines:[{productId,qty,unitPriceCents:1000,...(unit===undefined?{}:{unit})}]});
  const purchase=async(productId:number,unit?:string,qty=2)=>await docs.post(actor,(await draft(productId,unit,qty)).id);
  const renameUnit=async(id:number,specUnit:string)=>{const item=await ds.manager.findOneByOrFail(ResourceRecord,{id,companyId:actor.companyId,type:'finance-products'});await ds.manager.update(ResourceRecord,{id,companyId:actor.companyId},{data:{...item.data,specUnit}});};
  const stock=async(id:number)=>(await docs.inventory(actor,{})).filter(row=>row.productId===id);
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true}).initialize();
    const company=await ds.manager.save(Company,ds.manager.create(Company,{code:`iu${randomBytes(5).toString('hex')}`,name:'合成库存单位',status:'active'}));
    const user=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'synthetic',name:'合成核对员',passwordHash:'x',isCompanyAdmin:true,status:'active',mustChangePassword:false}));
    actor={companyId:company.id,id:user.id,name:user.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};resources=buildServices(ds).resources;docs=new FinanceDocumentsService(ds);
    categoryId=(await resources.create(actor,'finance-categories',{archiveType:'raw',name:'合成单位分类',code:'UNIT'})).id;
    supplierId=(await resources.create(actor,'finance-suppliers',{name:'合成单位供应商'})).id;customerId=(await resources.create(actor,'finance-customers',{name:'合成单位客户'})).id;warehouseId=(await resources.create(actor,'finance-warehouses',{name:'合成单位仓'})).id;
  });
  afterAll(async()=>{await ds?.destroy();});
  it('新明细冻结默认单位，分录/查询保持历史值；同商品同仓不同单位分别列示',async()=>{
    const item=await product(),first=await draft(item.id,undefined);expect(first.lines[0].unit).toBe('千克');
    const posted=await docs.post(actor,first.id);expect(posted.entries.find(entry=>entry.kind==='inventory')?.unit).toBe('千克');
    await renameUnit(item.id,'D');await purchase(item.id,'袋',3);
    expect((await stock(item.id)).map(row=>[row.unit,row.qty]).sort()).toEqual([['千克',2],['袋',3]].sort());
    const viewer={...actor,permissions:{isCompanyAdmin:false,allow:['finance.inventory.view'],deny:[]}};expect((await docs.inventory(viewer,{})).filter(row=>row.productId===item.id).every(row=>row.amountCents===null&&row.avgCostCents===null)).toBe(true);
    expect(await docs.inventory({...actor,companyId:actor.companyId+100000},{})).toEqual([]);
  });
  it('扣减按单位累计同单多行，不借其他单位的数量；失败不留开立或分录',async()=>{
    const item=await product();await purchase(item.id,'千克',2);await purchase(item.id,'袋',2);
    const invalid=await docs.createDraft(actor,{type:'sale',date:'2026-11-03',partyId:customerId,warehouseId,lines:[{productId:item.id,unit:'袋',qty:1.5,unitPriceCents:1000},{productId:item.id,unit:'袋',qty:1.5,unitPriceCents:1000}]});
    await expect(docs.post(actor,invalid.id)).rejects.toThrow(/库存不够/);expect((await docs.get(actor,invalid.id)).status).toBe('draft');expect(await ds.manager.count(FinanceEntry,{where:{companyId:actor.companyId,documentId:invalid.id}})).toBe(0);
    const sale=await docs.post(actor,(await draft(item.id,'袋',1,'sale')).id);expect(sale.entries.find(entry=>entry.kind==='inventory')?.unit).toBe('袋');
    expect((await stock(item.id)).map(row=>[row.unit,row.qty]).sort()).toEqual([['千克',2],['袋',1]].sort());
  });
  it('旧分录从一致的原明细读取单位，档案改名不覆盖，红冲沿用原单位且不回写原分录',async()=>{
    const item=await product(),posted=await purchase(item.id,'历史袋',2);await ds.manager.update(FinanceEntry,{companyId:actor.companyId,documentId:posted.id,kind:'inventory'},{unit:null});
    await renameUnit(item.id,'J');expect(await stock(item.id)).toEqual([expect.objectContaining({unit:'历史袋',qty:2})]);
    const reversed=await docs.reverse(actor,posted.id,'合成单位红冲');expect(reversed.entries.find(entry=>entry.kind==='inventory')?.unit).toBe('历史袋');expect(await stock(item.id)).toEqual([expect.objectContaining({unit:'历史袋',qty:0})]);
    expect((await ds.manager.findOneByOrFail(FinanceEntry,{companyId:actor.companyId,documentId:posted.id,kind:'inventory'})).unit).toBeNull();
  });
  it('历史多种明细单位无法确定对应时不猜今天单位，也不能借用未知单位库存',async()=>{
    const item=await product();const doc=await docs.createDraft(actor,{type:'purchase-in',date:'2026-11-03',partyId:supplierId,warehouseId,lines:[{productId:item.id,unit:'旧甲',qty:1,unitPriceCents:1000},{productId:item.id,unit:'旧乙',qty:1,unitPriceCents:1000}]});await docs.post(actor,doc.id);
    await ds.manager.update(FinanceEntry,{companyId:actor.companyId,documentId:doc.id,kind:'inventory'},{unit:null});await renameUnit(item.id,'D');expect(await stock(item.id)).toEqual([expect.objectContaining({unit:'',qty:2})]);
    await expect(docs.post(actor,(await draft(item.id,'袋',1,'sale')).id)).rejects.toThrow(/历史库存未记录单位/);
  });
  it('旧待过账明细缺单位时在本次过账冻结；允许原40字自由单位并拒绝41字',async()=>{
    const item=await product(),old=await draft(item.id,undefined);await ds.manager.update(FinanceDocumentLine,{companyId:actor.companyId,documentId:old.id},{unit:null});await renameUnit(item.id,'D');
    const posted=await docs.post(actor,old.id);expect(posted.lines[0].unit).toBe('袋');expect(posted.entries.find(entry=>entry.kind==='inventory')?.unit).toBe('袋');await renameUnit(item.id,'J');expect((await stock(item.id))[0].unit).toBe('袋');
    const longUnit='计'.repeat(40),long=await purchase(item.id,longUnit,1);expect(long.lines[0].unit).toBe(longUnit);expect(long.entries.find(entry=>entry.kind==='inventory')?.unit).toBe(longUnit);
    await expect(draft(item.id,'计'.repeat(41))).rejects.toThrow(/单位最多40字/);
  });
  it('相似字形和大小写的自由单位不跨单位扣减；旧明细公司隔离',async()=>{
    const item=await product();await purchase(item.id,'é',2);await purchase(item.id,'e',1);
    await purchase(item.id,'e\u0301',1);
    expect((await stock(item.id)).map(row=>row.unit).sort()).toEqual(['e','é','e\u0301'].sort());await expect(docs.post(actor,(await draft(item.id,'e\u0301',2,'sale')).id)).rejects.toThrow(/库存不够/);await expect(docs.post(actor,(await draft(item.id,'E',1,'sale')).id)).rejects.toThrow(/库存不够/);
    const legacy=await purchase(item.id,'只属于本公司',1);await ds.manager.update(FinanceEntry,{companyId:actor.companyId,documentId:legacy.id,kind:'inventory'},{unit:null});
    const foreign=await ds.manager.save(Company,ds.manager.create(Company,{code:`uf${randomBytes(5).toString('hex')}`,name:'合成其他单位公司',status:'active'}));
    await ds.manager.update(FinanceDocumentLine,{companyId:actor.companyId,documentId:legacy.id},{companyId:foreign.id,unit:'其他公司私有单位'});
    expect(JSON.stringify(await stock(item.id))).not.toContain('其他公司私有单位');expect((await stock(item.id)).find(row=>row.unit==='')?.qty).toBe(1);
  });
  it('流水按各自单位计算结存，混合单位不相加；单位筛选/成本权限/日期及公司范围保持',async()=>{
    const item=await product();await purchase(item.id,'千克',2);await purchase(item.id,'袋',3);await docs.post(actor,(await draft(item.id,'千克',1,'sale')).id);
    const ledger=await docs.inventoryLedger(actor,{productId:item.id,warehouseId});expect(ledger).toMatchObject({mixedUnits:true,inQty:null,outQty:null,closingQty:null});
    expect(ledger.rows.map(row=>[row.unit,row.qty,row.balanceQty])).toEqual([['千克',2,2],['袋',3,3],['千克',-1,1]]);expect(ledger.byUnit).toEqual(expect.arrayContaining([expect.objectContaining({unit:'千克',closingQty:1}),expect.objectContaining({unit:'袋',closingQty:3})]));
    expect(await docs.inventoryLedger(actor,{productId:item.id,warehouseId,unit:'袋'})).toMatchObject({mixedUnits:false,unit:'袋',inQty:3,outQty:0,closingQty:3});
    expect((await docs.inventoryLedger(actor,{productId:item.id,warehouseId,unit:'袋',asOf:'2026-11-02'})).rows).toEqual([]);
    const viewer={...actor,permissions:{isCompanyAdmin:false,allow:['finance.inventory.view'],deny:[]}};const hidden=await docs.inventoryLedger(viewer,{productId:item.id,warehouseId});expect(hidden.closingAmountCents).toBeNull();expect(hidden.byUnit.every(group=>group.closingAmountCents===null)).toBe(true);expect(hidden.rows.every(row=>row.amountCents===null&&row.balanceAmountCents===null)).toBe(true);
    expect((await docs.inventoryLedger({...actor,companyId:actor.companyId+100000},{productId:item.id,warehouseId,unit:'袋'})).rows).toEqual([]);
  });

  it('自定义名称单位按本公司及单位种类解析，改名停用不覆盖已保存快照，资料返回显示名而不改编码',async()=>{
    await resources.seedUnitDefaults(actor);
    const named=await resources.create(actor,'finance-product-units',{kind:'spec_unit',code:'SYNTHUNIT',name:'合成托盘'});
    await resources.create(actor,'finance-product-units',{kind:'shipping_unit',code:'SYNTHUNIT',name:'合成卷材'});
    const foreign=await ds.manager.save(Company,ds.manager.create(Company,{code:`ul${randomBytes(5).toString('hex')}`,name:'合成其他字典公司',status:'active'}));
    const foreignUser=await ds.manager.save(User,ds.manager.create(User,{companyId:foreign.id,account:'synthetic-unit',name:'合成单位管理员',passwordHash:'x',isCompanyAdmin:true,status:'active',mustChangePassword:false}));
    const foreignActor={...actor,companyId:foreign.id,id:foreignUser.id};
    await resources.create(foreignActor,'finance-product-units',{kind:'spec_unit',code:'SYNTHUNIT',name:'其他公司专有单位'});
    const item=await resources.create(actor,'finance-products',{archiveType:'raw',name:'合成自定单位商品',categoryId,specQty:1,specUnit:'SYNTHUNIT',purchaseSpec:'千克',purchasePrice:1000,freight:1,handlingFee:1});
    expect(item.data.specUnit).toBe('SYNTHUNIT');expect(item.optionLabels?.specUnit).toBe('合成托盘');
    expect((await resources.list(actor,'finance-products',{page:1,pageSize:200})).items.find(row=>row.id===item.id)?.optionLabels?.specUnit).toBe('合成托盘');
    const stored=await purchase(item.id);expect(stored.lines[0].unit).toBe('合成托盘');expect(stored.entries.find(entry=>entry.kind==='inventory')?.unit).toBe('合成托盘');
    const shippingCategory=await resources.create(actor,'finance-categories',{archiveType:'shipping_material',name:'合成专用发货分类',code:'SYNSHIP'});
    const shipping=await resources.create(actor,'finance-products',{archiveType:'shipping_material',name:'合成自定发货商品',categoryId:shippingCategory.id,specQty:1,specUnit:'SYNTHUNIT',purchaseSpec:'卷',weightG:10,purchasePrice:1000,freight:1,handlingFee:1});
    expect(shipping.optionLabels?.specUnit).toBe('合成卷材');expect((await draft(shipping.id,undefined)).lines[0].unit).toBe('合成卷材');
    await resources.update(actor,'finance-product-units',named.id,{name:'合成新托盘'});await resources.changeStatus(actor,'finance-product-units',named.id,'inactive','合成历史显示核对');
    expect((await resources.get(actor,'finance-products',item.id)).optionLabels?.specUnit).toBe('合成新托盘');
    expect((await draft(item.id,undefined)).lines[0].unit).toBe('合成新托盘');
    expect((await docs.get(actor,stored.id)).lines[0].unit).toBe('合成托盘');expect((await stock(item.id))[0].unit).toBe('合成托盘');
    const reader={...actor,permissions:{isCompanyAdmin:false,allow:['resource.finance-products.view'],deny:[]}};
    const visible=await resources.get(reader,'finance-products',item.id);expect(visible.optionLabels?.specUnit).toBe('合成新托盘');expect(visible.data).not.toHaveProperty('purchasePrice');
    expect(JSON.stringify(visible.optionLabels)).not.toContain('其他公司专有单位');
  });
});
