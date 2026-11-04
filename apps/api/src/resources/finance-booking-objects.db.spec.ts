import 'reflect-metadata';
import {randomBytes} from 'node:crypto';
import {DataSource} from 'typeorm';
import type {DocLineInput} from '@kudesi/shared';
import type {AuthUser} from '../common/auth.decorators';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,FinanceDocument,User} from '../entities';
import {buildServices} from '../test-support';
import {FinanceDocumentsService} from './finance-documents.service';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('费用挂账公司/人员选择与历史名称（真实隔离库）',()=>{
  let ds:DataSource,docs:FinanceDocumentsService,actor:AuthUser,other:AuthUser,feeId:number,bankId:number,storeBankId:number;
  const create=(line:Partial<DocLineInput>)=>docs.createDraft(actor,{type:'expense',date:'2026-11-03',settlementMode:'credit',lines:[{feeItemId:feeId,qty:1,unitPriceCents:1000,...line}]});
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true}).initialize();const resources=buildServices(ds).resources;docs=new FinanceDocumentsService(ds,resources);
    const make=async(name:string)=>{const company=await ds.manager.save(Company,ds.manager.create(Company,{code:`bo${randomBytes(5).toString('hex')}`,name,status:'active'}));const user=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:`synthetic-${randomBytes(4).toString('hex')}`,name:`${name}人员`,passwordHash:'x',status:'active',isCompanyAdmin:true,mustChangePassword:false}));return{companyId:company.id,id:user.id,name:user.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};
    actor=await make('合成挂账公司');other=await make('合成外部公司');feeId=(await resources.create(actor,'finance-fee-items',{name:'合成挂账费用',direction:'expense'})).id;
    bankId=(await resources.create(actor,'bank-accounts',{kind:'company_public',accountName:'合成公司公户',bank:'合成测试行',accountNo:'6222000000111100'})).id;
    storeBankId=(await resources.create(actor,'bank-accounts',{kind:'store_public',accountName:'合成店铺公户',bank:'合成测试行',accountNo:'6222000000222200'})).id;
  });
  afterAll(async()=>{await ds?.destroy();});
  it('所选ID保存本公司真实名称，不采信伪造名称；公司/人员改名不改已存明细，100字公司名不截断',async()=>{
    const company=await create({relatedNode:'公司',relatedId:actor.companyId,relatedName:'伪造名称'}),employee=await create({relatedNode:'人员',relatedId:actor.id,relatedName:'伪造人员'});
    expect(company.lines[0]).toMatchObject({relatedId:actor.companyId,relatedName:'合成挂账公司'});expect(employee.lines[0]).toMatchObject({relatedId:actor.id,relatedName:actor.name});
    await ds.manager.update(Company,{id:actor.companyId},{name:'合'.repeat(100)});await ds.manager.update(User,{id:actor.id,companyId:actor.companyId},{name:'合成已改名人员'});
    expect((await docs.get(actor,company.id)).lines[0].relatedName).toBe('合成挂账公司');expect((await docs.get(actor,employee.id)).lines[0].relatedName).toBe(actor.name);
    expect((await create({relatedNode:'公司',relatedId:actor.companyId})).lines[0].relatedName).toBe('合'.repeat(100));expect((await create({relatedNode:'人员',relatedId:actor.id})).lines[0].relatedName).toBe('合成已改名人员');
  });
  it('跨公司/不存在的公司人员和挂账银行类型错配均拒绝，不留下半张单据',async()=>{
    const before=await ds.manager.count(FinanceDocument,{where:{companyId:actor.companyId}});
    await expect(create({relatedNode:'公司',relatedId:other.companyId})).rejects.toThrow(/当前公司/);
    await expect(create({relatedNode:'人员',relatedId:other.id})).rejects.toThrow(/不属于当前公司/);
    await expect(create({relatedNode:'人员',relatedId:2147483647})).rejects.toThrow(/不存在/);
    await expect(create({relatedNode:'公司公户',relatedId:storeBankId})).rejects.toThrow(/类型.*不一致/);
    expect(await ds.manager.count(FinanceDocument,{where:{companyId:actor.companyId}})).toBe(before);
    expect((await create({relatedNode:'公司公户',relatedId:bankId})).lines[0].relatedId).toBe(bankId);expect((await create({relatedNode:'店铺公户',relatedId:storeBankId})).lines[0].relatedId).toBe(storeBankId);
  });
  it('原来只有文字的挂账对象继续保存，不猜ID或改写历史名称',async()=>{
    for(const relatedNode of ['公司','人员','部门']){const doc=await create({relatedNode,relatedName:'合成原文字对象'});expect(doc.lines[0]).toMatchObject({relatedId:null,relatedName:'合成原文字对象'});}
  });
});
