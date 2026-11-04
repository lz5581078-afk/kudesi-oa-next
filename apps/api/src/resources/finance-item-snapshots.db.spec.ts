import 'reflect-metadata';
import {randomBytes} from 'node:crypto';
import {DataSource} from 'typeorm';
import type {DocInput} from '@kudesi/shared';
import type {AuthUser} from '../common/auth.decorators';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,FinanceDocumentLine,ResourceRecord,User} from '../entities';
import {buildServices} from '../test-support';
import {FinanceDocumentsService} from './finance-documents.service';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('制单商品/费用名称编码事实（隔离库）',()=>{
  let ds:DataSource,docs:FinanceDocumentsService,actor:AuthUser,fee:number,bank:number;
  const resource=(type:string,title:string,data:Record<string,unknown>)=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:actor.companyId,type,title,data,status:'active',searchText:title,createdBy:actor.id,updatedBy:actor.id}));
  const expense=(lines:DocInput['lines']):DocInput=>({type:'expense',date:'2026-11-03',bankAccountId:bank,lines});
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true}).initialize();
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:`is${randomBytes(5).toString('hex')}`,name:'合成项目快照公司',status:'active'}));
    const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'admin',name:'合成核对员',passwordHash:'x',status:'active',isCompanyAdmin:true,mustChangePassword:false}));actor={id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    const resources=buildServices(ds).resources;docs=new FinanceDocumentsService(ds,resources);
    fee=(await resource('finance-fee-items','合成旧标题',{name:'合成原费用',code:'F1',direction:'expense'})).id;
    bank=(await resources.create(actor,'bank-accounts',{kind:'company_public',accountName:'合成账户',bank:'合成测试行',accountNo:'6222000000001234',balance:10000})).id;
  });
  afterAll(async()=>{await ds?.destroy();});
  it('冻结真实名称编码，重存和复制保留，明确重选才刷新，红冲沿用原事实',async()=>{
    const line={feeItemId:fee,qty:1,unitPriceCents:1000};const d=await docs.createDraft(actor,expense([line]));
    expect(d.lines[0]).toMatchObject({feeItemName:'合成原费用',itemCode:'F1',itemNameSource:'snapshot'});
    await ds.manager.update(ResourceRecord,{id:fee,companyId:actor.companyId},{title:'合成新标题',data:{name:'合成新费用',code:'F2',direction:'expense'}});
    const saved=await docs.updateDraft(actor,d.id,expense([{...line,id:d.lines[0].id}]));expect(saved.lines[0]).toMatchObject({id:d.lines[0].id,feeItemName:'合成原费用',itemCode:'F1'});
    const copy=await docs.copyAsDraft(actor,d.id);expect(copy.lines[0]).toMatchObject({feeItemName:'合成原费用',itemCode:'F1'});
    const refreshed=await docs.updateDraft(actor,d.id,expense([{...line,id:d.lines[0].id,refreshItemName:true}]));expect(refreshed.lines[0]).toMatchObject({feeItemName:'合成新费用',itemCode:'F2'});
    await docs.post(actor,copy.id);const reversed=await docs.reverse(actor,copy.id,'合成撤销');expect(reversed.lines[0]).toMatchObject({feeItemName:'合成原费用',itemCode:'F1'});
  });
  it('商品原始名称200字和160位编码完整保存，空编码也是既定事实',async()=>{
    const name='商'.repeat(200),code='C'.repeat(160),p=await resource('finance-products','合成展示标题',{name,code,archiveType:'raw',specUnit:'包'});
    const d=await docs.createDraft(actor,{type:'purchase-in',date:'2026-11-03',lines:[{productId:p.id,qty:1,unitPriceCents:100}]});expect(d.lines[0]).toMatchObject({productName:name,itemCode:code});
    const empty=await resource('finance-fee-items','合成无编码',{name:'合成无编码',direction:'expense'}),e=await docs.createDraft(actor,expense([{feeItemId:empty.id,qty:1,unitPriceCents:100}]));
    await ds.manager.update(ResourceRecord,{id:empty.id},{data:{name:'合成无编码',direction:'expense',code:'LATER'}});
    expect((await docs.updateDraft(actor,e.id,expense([{id:e.lines[0].id,feeItemId:empty.id,qty:1,unitPriceCents:100}]))).lines[0].itemCode).toBe('');
  });
  it('空档案手工费用512字可过账，金额守恒且不创建费用档案',async()=>{
    const text='费'.repeat(512),before=await ds.manager.count(ResourceRecord,{where:{companyId:actor.companyId,type:'finance-fee-items'}});
    const d=await docs.createDraft(actor,expense([{itemName:text,qty:1,unitPriceCents:1234}]));const p=await docs.post(actor,d.id);
    expect(p.lines[0]).toMatchObject({feeItemId:null,itemName:text,feeItemName:text,itemNameSource:null});expect(p.entries.reduce((sum,e)=>sum+(e.amountCents??0),0)).toBe(0);
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:actor.companyId,type:'finance-fee-items'}})).toBe(before);
    await expect(docs.createDraft(actor,expense([{itemName:'费'.repeat(513),qty:1,unitPriceCents:100}]))).rejects.toThrow(/512/);
  });
  it('历史NULL只读回退、不回填伪历史，收入的自定义项目不被费用名称覆盖',async()=>{
    const f=await resource('finance-fee-items','合成收入旧标题',{name:'合成收入类型',direction:'income',code:'IN'});
    const d=await docs.createDraft(actor,{type:'other-income',date:'2026-11-03',lines:[{feeItemId:f.id,itemName:'合成实际项目说明',qty:1,unitPriceCents:100}]});expect(d.lines[0]).toMatchObject({itemName:'合成实际项目说明',feeItemName:'合成收入类型'});
    await ds.manager.update(FinanceDocumentLine,{id:d.lines[0].id},{feeItemNameSnapshot:null,itemCodeSnapshot:null});
    const v=await docs.get(actor,d.id);expect(v.lines[0]).toMatchObject({itemName:'合成实际项目说明',feeItemName:'合成收入旧标题',itemNameSource:'current'});
    const raw=await ds.manager.findOneByOrFail(FinanceDocumentLine,{id:d.lines[0].id});expect(raw.feeItemNameSnapshot).toBeNull();expect(raw.itemCodeSnapshot).toBeNull();
    const copy=await docs.copyAsDraft(actor,d.id);expect((await ds.manager.findOneByOrFail(FinanceDocumentLine,{id:copy.lines[0].id})).feeItemNameSnapshot).toBeNull();
  });
});
