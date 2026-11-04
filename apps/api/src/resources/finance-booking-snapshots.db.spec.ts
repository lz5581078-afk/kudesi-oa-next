import 'reflect-metadata';
import {randomBytes} from 'node:crypto';
import {DataSource} from 'typeorm';
import type {DocInput,DocLineInput} from '@kudesi/shared';
import type {AuthUser} from '../common/auth.decorators';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,FinanceDocument,FinanceDocumentLine,ResourceRecord,User} from '../entities';
import {buildServices} from '../test-support';
import {FinanceDocumentsService} from './finance-documents.service';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('财务挂账资料快照及明细身份（隔离库）',()=>{
  let ds:DataSource,docs:FinanceDocumentsService,resources:ReturnType<typeof buildServices>['resources'],actor:AuthUser,other:AuthUser,fee:number,otherFee:number;
  const resource=async(type:string,title:string,data:Record<string,unknown>,who=actor)=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:who.companyId,type,title,data,status:'active',searchText:title,createdBy:who.id,updatedBy:who.id}));
  const input=(lines:Partial<DocLineInput>[],who=actor):DocInput=>({type:'expense',date:'2026-11-03',settlementMode:'credit',paidCents:0,lines:lines.map(line=>({feeItemId:who===actor?fee:otherFee,qty:1,unitPriceCents:1000,...line}))});
  const create=(lines:Partial<DocLineInput>[],who=actor)=>docs.createDraft(who,input(lines,who));
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true}).initialize();resources=buildServices(ds).resources;docs=new FinanceDocumentsService(ds,resources);
    const person=async()=>{const c=await ds.manager.save(Company,ds.manager.create(Company,{code:`bs${randomBytes(5).toString('hex')}`,name:'合成快照公司',status:'active'}));const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'admin',name:'合成核对员',passwordHash:'x',status:'active',isCompanyAdmin:true,mustChangePassword:false}));return{id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};
    actor=await person();other=await person();fee=(await resources.create(actor,'finance-fee-items',{name:'合成快照费',direction:'expense'})).id;otherFee=(await resources.create(other,'finance-fee-items',{name:'外公司费',direction:'expense'})).id;
  });
  afterAll(async()=>{await ds?.destroy();});
  it('七类资源真实名称编号从服务端冻结，不采信客户端名称或商品的其他规格字段',async()=>{
    const examples=[['营业执照','licenses',{companyName:'合成主体',licenseNo:'L1'},'合成主体 · L1'],['店铺','stores',{name:'合成店',storeNo:'S1'},'合成店 · S1'],['手机号','phones',{number:'18500000000'},'18500000000'],['固定资产','fixed-assets',{name:'合成设备',assetNo:'A1'},'合成设备 · A1'],['商品','finance-products',{name:'合成商品',code:'P1',specQty:500,specUnit:'包'},'合成商品 · P1'],['供应商','finance-suppliers',{name:'合成供应商',code:'SP1'},'合成供应商 · SP1'],['客户','finance-customers',{name:'合成客户',code:'C1'},'合成客户 · C1']] as const;
    for(const[node,type,data,label]of examples){const r=await resource(type,'合成旧标题',data);const d=await create([{relatedNode:node,relatedId:r.id,relatedName:'伪造名称'}]);expect(d.lines[0]).toMatchObject({relatedId:r.id,relatedName:label,relatedNameSource:'snapshot'});}
  });
  it('银行快照取真实关联店铺及加密卡号尾四位，不泄漏完整卡号',async()=>{
    const store=await resource('stores','合成银行关联店',{name:'合成银行关联店',platform:'pdd'});
    const number='6222000099997890',bank=await resources.create(actor,'bank-accounts',{kind:'store_public',accountName:'合成银行账户',ownerName:'合成户主',bank:'合成测试行',accountNo:number,storeId:store.id});
    const d=await create([{relatedNode:'店铺公户',relatedId:bank.id,relatedName:'伪造尾号0000'}]);expect(d.lines[0].relatedName).toBe('店铺公户 · 合成银行关联店 · 尾号7890');expect(d.lines[0].relatedName).not.toContain(number);
  });
  it('改名后重存及复制保留旧快照和行ID，只有明确改选对象才捕获新名称',async()=>{
    const a=await resource('finance-customers','合成甲',{name:'合成甲',code:'C1'}),b=await resource('finance-customers','合成乙',{name:'合成乙',code:'C2'}),d=await create([{relatedNode:'客户',relatedId:a.id}]);const id=d.lines[0].id;
    await ds.manager.update(ResourceRecord,{id:a.id,companyId:actor.companyId},{title:'改名甲',data:{name:'改名甲',code:'NEW'}});
    const saved=await docs.updateDraft(actor,d.id,input([{id,relatedNode:'客户',relatedId:a.id,relatedName:'伪造'}]));expect(saved.lines[0]).toMatchObject({id,relatedName:'合成甲 · C1'});
    const copy=await docs.copyAsDraft(actor,d.id);expect(copy.lines[0].relatedName).toBe('合成甲 · C1');expect(copy.lines[0].id).not.toBe(id);expect((await docs.updateDraft(actor,d.id,input([{id,relatedNode:'客户',relatedId:a.id,refreshRelatedName:true,relatedName:'不能采信'}]))).lines[0]).toMatchObject({id,relatedName:'改名甲 · NEW'});
    expect((await docs.updateDraft(actor,d.id,input([{id,relatedNode:'客户',relatedId:b.id}]))).lines[0]).toMatchObject({id,relatedName:'合成乙 · C2'});expect((await docs.get(actor,copy.id)).lines[0].relatedName).toBe('合成甲 · C1');
  });
  it('重排/插入/删除保留对应行的身份与旧快照，旧客户端无ID重存也不重复造行',async()=>{
    const a=await resource('finance-customers','合成排序甲',{name:'合成排序甲',code:'A'}),b=await resource('finance-customers','合成排序乙',{name:'合成排序乙',code:'B'}),c=await resource('finance-customers','合成排序丙',{name:'合成排序丙',code:'C'});
    const d=await create([{relatedNode:'客户',relatedId:a.id},{relatedNode:'客户',relatedId:b.id}]),[first,second]=d.lines;
    await ds.manager.update(ResourceRecord,{id:a.id},{title:'新甲',data:{name:'新甲',code:'AA'}});await ds.manager.update(ResourceRecord,{id:b.id},{title:'新乙',data:{name:'新乙',code:'BB'}});
    const next=await docs.updateDraft(actor,d.id,input([{id:second.id,relatedNode:'客户',relatedId:b.id},{relatedNode:'客户',relatedId:c.id},{id:first.id,relatedNode:'客户',relatedId:a.id}]));expect(next.lines.map(line=>[line.lineNo,line.relatedName])).toEqual([[1,'合成排序乙 · B'],[2,'合成排序丙 · C'],[3,'合成排序甲 · A']]);expect(next.lines[0].id).toBe(second.id);expect(next.lines[2].id).toBe(first.id);
    const keep=await docs.updateDraft(actor,d.id,input([{id:next.lines[1].id,relatedNode:'客户',relatedId:c.id},{id:first.id,relatedNode:'客户',relatedId:a.id}]));const retry=await docs.updateDraft(actor,d.id,input([{relatedNode:'客户',relatedId:c.id},{relatedNode:'客户',relatedId:a.id}]));expect(retry.lines.map(line=>line.id)).toEqual(keep.lines.map(line=>line.id));expect(retry.lines[1].relatedName).toBe('合成排序甲 · A');expect(await ds.manager.countBy(FinanceDocumentLine,{documentId:d.id,companyId:actor.companyId})).toBe(2);
  });
  it('外公司/其他单据/重复或不存在行ID均拒绝，整张草稿与明细原子回滚',async()=>{
    const own=await create([{}]),foreign=await create([{}],other),another=await create([{}]);const before=await ds.manager.countBy(FinanceDocument,{companyId:actor.companyId});
    for(const id of [foreign.lines[0].id,another.lines[0].id,2147483647])await expect(docs.updateDraft(actor,own.id,{...input([{id}]),date:'2026-11-04'})).rejects.toThrow(/明细已变更/);
    await expect(docs.updateDraft(actor,own.id,input([{id:own.lines[0].id},{id:own.lines[0].id}]))).rejects.toThrow(/明细已变更/);await expect(create([{id:own.lines[0].id}])).rejects.toThrow(/明细已变更/);expect(await ds.manager.countBy(FinanceDocument,{companyId:actor.companyId})).toBe(before);expect((await docs.get(actor,own.id)).docDate).toBe('2026-11-03');expect((await docs.get(actor,own.id)).lines[0].id).toBe(own.lines[0].id);
  });
  it('旧空快照只读回退标明当前资料，读取不回填；跨公司旧坏引用不返回别家公司名称',async()=>{
    const r=await resource('finance-customers','合成旧空',{name:'合成旧空',code:'OLD'}),foreign=await resource('finance-customers','不应泄漏',{name:'不应泄漏',code:'SECRET'},other),d=await create([{relatedNode:'客户',relatedId:r.id}]),id=d.lines[0].id;
    await ds.manager.update(FinanceDocumentLine,{id,companyId:actor.companyId},{relatedName:null});expect((await docs.get(actor,d.id)).lines[0]).toMatchObject({relatedName:'合成旧空 · OLD',relatedNameSource:'current'});expect((await ds.manager.findOneByOrFail(FinanceDocumentLine,{id})).relatedName).toBeNull();
    await ds.manager.update(ResourceRecord,{id:r.id},{title:'当前名',data:{name:'当前名',code:'NOW'}});expect((await docs.get(actor,d.id)).lines[0].relatedName).toBe('当前名 · NOW');const saved=await docs.updateDraft(actor,d.id,input([{id,relatedNode:'客户',relatedId:r.id}]));expect(saved.lines[0]).toMatchObject({relatedName:'当前名 · NOW',relatedNameSource:'snapshot'});
    await ds.manager.update(FinanceDocumentLine,{id,companyId:actor.companyId},{relatedId:foreign.id,relatedName:null});expect((await docs.get(actor,d.id)).lines[0]).toMatchObject({relatedName:null,relatedNameSource:null});
  });
  it('完整403字资料名称编号和512字自由文字不截断，超过容量拒绝且不留下半张单据',async()=>{
    const name='名'.repeat(200),code='号'.repeat(200),r=await resource('stores',name,{name,storeNo:code});expect((await create([{relatedNode:'店铺',relatedId:r.id}])).lines[0].relatedName).toBe(`${name} · ${code}`);
    expect((await create([{relatedNode:'不固定',relatedName:'字'.repeat(512)}])).lines[0].relatedName).toBe('字'.repeat(512));const before=await ds.manager.countBy(FinanceDocument,{companyId:actor.companyId});await expect(create([{relatedNode:'不固定',relatedName:'字'.repeat(513)}])).rejects.toThrow(/512/);expect(await ds.manager.countBy(FinanceDocument,{companyId:actor.companyId})).toBe(before);
  });
});
