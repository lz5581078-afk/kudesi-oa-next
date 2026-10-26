import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User, FinanceDocumentLine } from '../entities';
import { buildServices } from '../test-support';
import { FinanceDocumentsService } from './finance-documents.service';
import { AuthUser } from '../common/auth.decorators';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('精细单价落库与结算',()=>{
  let ds:DataSource,services:ReturnType<typeof buildServices>,user:AuthUser;
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();
    services=buildServices(ds);const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'精细单价测试',status:'active'}));
    const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'precision-'+c.id,name:'管理员',passwordHash:'x',isCompanyAdmin:true,status:'active',mustChangePassword:false}));
    user={id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
  });
  afterAll(async()=>{await ds?.destroy();});
  it('0.0025元单价×100，数据库不截单价，过账金额25分且借贷平衡',async()=>{
    const svc=services.resources;const category=await svc.create(user,'finance-categories',{archiveType:'raw',name:'测试原料',code:'RAW'});
    const product=await svc.create(user,'finance-products',{archiveType:'raw',name:'精细成本原料',categoryId:category.id,purchaseSpec:'克',specQty:1,specUnit:'G',purchasePrice:0.25,freight:0.1,handlingFee:0.15});
    expect(product.data.totalCost).toBe(0.5);
    const supplier=await svc.create(user,'finance-suppliers',{name:'测试供应商'});
    const warehouse=await svc.create(user,'finance-warehouses',{name:'测试仓库'});
    const docs=new FinanceDocumentsService(ds);
    const draft=await docs.createDraft(user,{type:'purchase-in',date:'2026-10-26',partyId:supplier.id,warehouseId:warehouse.id,lines:[{productId:product.id,qty:100,unitPriceCents:0.25}]});
    expect(draft.amountCents).toBe(25);
    const line=await ds.manager.findOneByOrFail(FinanceDocumentLine,{documentId:draft.id,companyId:user.companyId});expect(line.unitPriceCents).toBe(0.25);
    const posted=await docs.post(user,draft.id);expect(posted.entries.every(e=>Number.isInteger(e.amountCents))).toBe(true);
    expect(posted.entries.reduce((sum,e)=>sum+(e.amountCents??0),0)).toBe(0);
    const balance=(await docs.inventory(user,{})).find(r=>r.productId===product.id)!;expect(balance.qty).toBe(100);
  });
});
