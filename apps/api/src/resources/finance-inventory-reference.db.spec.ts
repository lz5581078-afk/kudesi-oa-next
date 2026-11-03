import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { buildServices } from '../test-support';
import { FinanceDocumentsService } from './finance-documents.service';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('原库存搜索与精细平均报价（真实隔离数据库）',()=>{
  let ds:DataSource,docs:FinanceDocumentsService,actor:AuthUser,documentId:number,firstId:number;
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true}).initialize();
    const company=await ds.manager.save(Company,ds.manager.create(Company,{code:`iq${randomBytes(5).toString('hex')}`,name:'合成库存语义',status:'active'}));
    const user=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'synthetic',name:'合成管理员',passwordHash:'x',isCompanyAdmin:true,status:'active',mustChangePassword:false}));
    actor={companyId:company.id,id:user.id,name:user.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    const svc=buildServices(ds).resources;docs=new FinanceDocumentsService(ds);
    const category=await svc.create(actor,'finance-categories',{archiveType:'raw',name:'合成库存分类',code:'SEARCH'});
    const warehouse=await svc.create(actor,'finance-warehouses',{name:'合成固定仓'}),supplier=await svc.create(actor,'finance-suppliers',{name:'合成供应商'});
    for(const [index,name] of ['合成 Alpha Beta','合成 Alpha 中间 Beta','合成_%'].entries()){
      const product=await svc.create(actor,'finance-products',{archiveType:'raw',name,categoryId:category.id,specQty:1,specUnit:'KG',purchaseSpec:'千克',purchasePrice:1,freight:0,handlingFee:0,zeroValueReason:'运费：无\n装卸费：无'});
      const draft=await docs.createDraft(actor,{type:'purchase-in',date:'2026-11-03',partyId:supplier.id,warehouseId:warehouse.id,lines:[{productId:product.id,qty:index===0?3:1,unitPriceCents:index===0?0.3333:100}]});
      await docs.post(actor,draft.id);if(index===0){firstId=product.id;documentId=draft.id;}
    }
  });
  afterAll(async()=>{await ds?.destroy();});
  it('完整短语不被空格拆散；换行任一条匹配，去重不重复行，通配符和SQL文字按字面搜索',async()=>{
    const phrase=await docs.inventory(actor,{keyword:'Alpha Beta'});expect(phrase.map(row=>row.productId)).toEqual([firstId]);
    expect((await docs.inventory(actor,{keyword:'Alpha Beta\n中间\nalpha beta'})).map(row=>row.productName).sort()).toEqual(['合成 Alpha Beta','合成 Alpha 中间 Beta'].sort());
    expect((await docs.inventory(actor,{keyword:`${phrase[0].code} ${phrase[0].productName}`})).map(row=>row.productId)).toEqual([firstId]);
    for(const literal of ['%','_'])expect((await docs.inventory(actor,{keyword:literal})).map(row=>row.productName)).toEqual(['合成_%']);
    expect(await docs.inventory(actor,{keyword:"' OR 1=1 --"})).toEqual([]);
    expect(await docs.inventory({...actor,companyId:actor.companyId+100000},{keyword:'Alpha Beta\n_%'})).toEqual([]);
  });
  it('1分/3单位保留0.003333元报价；成本权限继续脱敏，红冲后零数量无平均成本',async()=>{
    const row=(await docs.inventory(actor,{keyword:'Alpha Beta'}))[0];expect(row.amountCents).toBe(1);expect(row.qty).toBe(3);expect(row.avgCostCents).toBe(0.3333);
    const viewer={...actor,permissions:{isCompanyAdmin:false,allow:['finance.inventory.view'],deny:[]}};
    expect((await docs.inventory(viewer,{keyword:'Alpha Beta'}))[0]).toMatchObject({amountCents:null,avgCostCents:null});
    await docs.reverse(actor,documentId,'合成库存核对撤销');
    expect((await docs.inventory(actor,{keyword:'Alpha Beta'}))[0]).toMatchObject({qty:0,amountCents:0,avgCostCents:null});
  });
});
