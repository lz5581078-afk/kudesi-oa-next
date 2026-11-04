import 'reflect-metadata';
import * as crypto from 'crypto';
import {DataSource} from 'typeorm';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,ResourceChangeLog,User} from '../entities';
import {buildServices} from '../test-support';
import type {AuthUser} from '../common/auth.decorators';
const db=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
db('费用列表挂账节点沿通用主表事务（隔离MySQL）',()=>{
 let ds:DataSource,s:ReturnType<typeof buildServices>,user:AuthUser,other:AuthUser,categoryId:number;
 beforeAll(async()=>{ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never);await ds.initialize();s=buildServices(ds);
  const actor=async()=>{const company=await ds.manager.save(Company,ds.manager.create(Company,{code:crypto.randomBytes(8).toString('hex'),name:'合成节点公司',status:'active'}));const person=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'synthetic',name:'合成维护员',passwordHash:'unused',status:'active',isCompanyAdmin:true,mustChangePassword:false}));return{id:person.id,companyId:company.id,name:person.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};user=await actor();other=await actor();categoryId=(await s.resources.create(user,'finance-fee-categories',{name:'合成费用目录'})).id;
 });
 afterAll(async()=>{await ds?.destroy();});
 const create=()=>s.resources.create(user,'finance-fee-items',{name:`合成费用${crypto.randomBytes(3).toString('hex')}`,direction:'expense',categoryId,accountingSubject:'原核算科目',defaultObject:'公司',relationRequirement:'原说明',isCommon:'yes',needFlow:'by_amount',platform:'any',note:'保留原备注'});
 it('只更改节点与说明并由服务端推导必挂对象，重复请求幂等，不改其他资料',async()=>{
  const record=await create(),input={id:record.id,version:record.version,requestKey:crypto.randomUUID(),values:{defaultObject:'店铺、公司',relationRequirement:'需要具体店铺'},collections:[]};
  const before=await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}}),result=await s.resources.saveForm(user,'finance-fee-items',input);
  expect(result.data).toEqual({...record.data,defaultObject:'店铺、公司',relationRequirement:'需要具体店铺',requiredObject:'yes'});
  expect((await s.resources.saveForm(user,'finance-fee-items',input)).id).toBe(record.id);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}})).toBe(before+1);
  const cleared=await s.resources.saveForm(user,'finance-fee-items',{...input,version:result.version,requestKey:crypto.randomUUID(),values:{defaultObject:'',relationRequirement:''}});expect(cleared.data).toMatchObject({requiredObject:'no',defaultObject:'不固定',accountingSubject:'原核算科目',note:'保留原备注'});expect(cleared.data.relationRequirement??'').toBe('');
 });
 it('原详情可单独设置必挂对象，普通编辑保留，节点改变重新推导',async()=>{
  const record=await create();
  const changed=await s.resources.saveForm(user,'finance-fee-items',{id:record.id,version:record.version,requestKey:crypto.randomUUID(),values:{requiredObject:'yes'},collections:[]});
  expect(changed.data).toMatchObject({defaultObject:'公司',requiredObject:'yes'});
  const renamed=await s.resources.saveForm(user,'finance-fee-items',{id:record.id,version:changed.version,requestKey:crypto.randomUUID(),values:{note:'只修改备注'},collections:[]});
  expect(renamed.data.requiredObject).toBe('yes');
  const unset=await s.resources.saveForm(user,'finance-fee-items',{id:record.id,version:renamed.version,requestKey:crypto.randomUUID(),values:{direction:''},collections:[]});
  expect(unset.data.direction??'').toBe('');
  const noRequirement=await s.resources.saveForm(user,'finance-fee-items',{id:record.id,version:unset.version,requestKey:crypto.randomUUID(),values:{requiredObject:''},collections:[]});
  expect(noRequirement.data.requiredObject??'').toBe('');
  const keptUnset=await s.resources.saveForm(user,'finance-fee-items',{id:record.id,version:noRequirement.version,requestKey:crypto.randomUUID(),values:{note:'保留未设置要求'},collections:[]});
  expect(keptUnset.data.requiredObject??'').toBe('');
  const moved=await s.resources.saveForm(user,'finance-fee-items',{id:record.id,version:keptUnset.version,requestKey:crypto.randomUUID(),values:{defaultObject:'',requiredObject:'yes'},collections:[]});
  expect(moved.data).toMatchObject({defaultObject:'不固定',requiredObject:'no'});
 });
 it('过期版本/跨公司/无编辑权都不写回节点，失败保持现有科目与节点',async()=>{
  const record=await create(),input={id:record.id,version:record.version,requestKey:crypto.randomUUID(),values:{defaultObject:'手机号',relationRequirement:'迟到内容'},collections:[]};
  await s.resources.update(user,'finance-fee-items',record.id,{accountingSubject:'刚维护的科目'});
  await expect(s.resources.saveForm(user,'finance-fee-items',input)).rejects.toThrow(/刚被修改/);
  await expect(s.resources.saveForm(other,'finance-fee-items',{...input,requestKey:crypto.randomUUID()})).rejects.toThrow(/不存在/);
  await expect(s.resources.saveForm({...user,permissions:{isCompanyAdmin:false,allow:['resource.finance-fee-items.view'],deny:[]}},'finance-fee-items',{...input,requestKey:crypto.randomUUID()})).rejects.toThrow(/编辑/);
  expect((await s.resources.get(user,'finance-fee-items',record.id)).data).toMatchObject({accountingSubject:'刚维护的科目',defaultObject:'公司',relationRequirement:'原说明'});
 });
 it('原版新增的独立必挂选择不被默认公司节点覆盖，明确未设置也保留；未提供仍自动取默认',async()=>{
  const form=(name:string,values:Record<string,unknown>)=>s.resources.saveForm(user,'finance-fee-items',{requestKey:crypto.randomUUID(),values:{name,categoryId,defaultObject:'公司',...values},collections:[]});
  const yes=await form('新增手动必挂'+crypto.randomBytes(3).toString('hex'),{requiredObject:'yes'});expect(yes.data).toMatchObject({defaultObject:'公司',requiredObject:'yes'});
  const unset=await form('新增手动空白'+crypto.randomBytes(3).toString('hex'),{requiredObject:''});expect(unset.data.requiredObject??'').toBe('');
  const auto=await form('新增自动默认'+crypto.randomBytes(3).toString('hex'),{});expect(auto.data.requiredObject).toBe('no');
  const node=await form('新增节点默认'+crypto.randomBytes(3).toString('hex'),{defaultObject:'店铺'});expect(node.data.requiredObject).toBe('yes');
 });

});
