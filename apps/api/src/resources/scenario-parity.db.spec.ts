import 'reflect-metadata';
import {createHash,randomBytes} from 'crypto';
import {DataSource} from 'typeorm';
import {AuthUser} from '../common/auth.decorators';
import {Company,ResourceRecord,User} from '../entities';
import {buildDataSourceOptions} from '../database/data-source';
import {buildServices} from '../test-support';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('原销售场景名称维护沿统一资源（隔离MySQL）',()=>{
 let ds:DataSource;
 beforeAll(async()=>{ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();});afterAll(async()=>{await ds?.destroy();});
 async function fixture(){const company=await ds.manager.save(Company,ds.manager.create(Company,{name:'合成场景公司',code:randomBytes(8).toString('hex'),status:'active'})),user=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'scenario',name:'合成管理员',passwordHash:'unused',status:'active',isCompanyAdmin:true,mustChangePassword:false}));const actor:AuthUser={id:user.id,companyId:company.id,name:user.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};return{actor,resources:buildServices(ds).resources};}
 it('只填名称生成原sha256标识及编码段，普通显式场景原能力保留，名称/段重复拒绝且跨公司独立',async()=>{
  const f=await fixture(),other=await fixture(),name='合成新销售场景',hash=createHash('sha256').update(name).digest('hex').slice(0,12),row=await f.resources.create(f.actor,'finance-scenarios',{name});expect(row.data).toMatchObject({code:'scene_'+hash,segment:'S'+hash.toUpperCase()});
  await expect(f.resources.create(f.actor,'finance-scenarios',{name})).rejects.toThrow(/重复|存在/);
  await expect(f.resources.create(f.actor,'finance-scenarios',{name:'另一名称',code:'OTHER',segment:row.data.segment})).rejects.toThrow(/重复/);
  expect((await other.resources.create(other.actor,'finance-scenarios',{name})).data.code).toBe(row.data.code);
  const staff={...f.actor,permissions:{isCompanyAdmin:false,allow:['resource.finance-scenarios.create'],deny:[]}};await expect(f.resources.create(staff,'finance-scenarios',{name:'不能隐式创建'})).rejects.toMatchObject({status:403});expect((await f.resources.create(staff,'finance-scenarios',{name:'原明确编码入口',code:'EXPLICIT'})).data.code).toBe('EXPLICIT');
 });
 it('公司自销不可停用、实际被组合引用场景不可停用，未引用可停再启且保留原ID',async()=>{
  const f=await fixture(),standard=await f.resources.create(f.actor,'finance-scenarios',{name:'公司自销',code:'standard',segment:''}),custom=await f.resources.create(f.actor,'finance-scenarios',{name:'未引用场景'});
  await expect(f.resources.changeStatus(f.actor,'finance-scenarios',standard.id,'inactive','原默认场景删除')).rejects.toThrow(/默认/);
  await f.resources.changeStatus(f.actor,'finance-scenarios',custom.id,'inactive','删除销售场景');expect((await f.resources.get(f.actor,'finance-scenarios',custom.id)).status).toBe('inactive');await f.resources.changeStatus(f.actor,'finance-scenarios',custom.id,'active');expect((await f.resources.get(f.actor,'finance-scenarios',custom.id)).data.code).toBe(custom.data.code);
  await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:f.actor.companyId,type:'finance-bundles',title:'合成已引用组合',data:{scenarioId:custom.id},status:'pending',createdBy:f.actor.id,updatedBy:f.actor.id}));await expect(f.resources.changeStatus(f.actor,'finance-scenarios',custom.id,'inactive','删除销售场景')).rejects.toThrow(/组合编码使用/);expect((await f.resources.get(f.actor,'finance-scenarios',custom.id)).status).toBe('active');
 });
 it('并发相同名称创建只成功一条，grid改名仍受同一名称规则约束',async()=>{
  const f=await fixture(),result=await Promise.allSettled([f.resources.create(f.actor,'finance-scenarios',{name:'并发场景'}),f.resources.create(f.actor,'finance-scenarios',{name:'并发场景'})]);expect(result.filter(row=>row.status==='fulfilled')).toHaveLength(1);
  const other=await f.resources.create(f.actor,'finance-scenarios',{name:'待改名场景'});await expect(f.resources.saveGridRow(f.actor,'finance-scenarios',{id:other.id,version:other.version,values:{name:'并发场景'}},'合成改名')).rejects.toThrow(/重复/);expect((await f.resources.get(f.actor,'finance-scenarios',other.id)).title).toBe('待改名场景');
 });
 it('品牌空码按原首字母自动避让，并发不同名同缩写均保留；明确手填冲突仍拒绝',async()=>{
  const f=await fixture(),a=await f.resources.create(f.actor,'finance-brands',{name:'A-B'}),b=await f.resources.create(f.actor,'finance-brands',{name:'A B'});expect(a.data.code).toBe('AB');expect(b.data.code).toBe('AB2');await expect(f.resources.create(f.actor,'finance-brands',{name:'明确冲突',code:'AB'})).rejects.toThrow(/品牌码/);
  const long=await f.resources.create(f.actor,'finance-brands',{name:'ABCDEFGHIJKLMN'}),longCollision=await f.resources.create(f.actor,'finance-brands',{name:'ABCDEFGHIJKLMN+'});expect(long.data.code).toBe('ABCDEFGHIJKLMN');expect(longCollision.data.code).toBe('ABCDEFGHIJKLMN2');expect((await f.resources.create(f.actor,'finance-brands',{name:'明确长品牌码',code:'SOMELONGBRAND'})).data.code).toBe('SOMELONGBRAND');
  const rows=await Promise.all([f.resources.create(f.actor,'finance-brands',{name:'C-D'}),f.resources.create(f.actor,'finance-brands',{name:'C D'})]);expect(new Set(rows.map(row=>row.data.code)).size).toBe(2);expect((await f.resources.update(f.actor,'finance-brands',a.id,{name:'品牌新名'})).data.code).toBe('AB');
 });
 it('平台真实base/组合引用与精确旧款式token保护改码和删除，不按子串/名称推断；GENERAL已存保护',async()=>{
  const f=await fixture(),platform=await f.resources.create(f.actor,'finance-platforms',{name:'合成令牌平台',code:'TOK'}),other=await f.resources.create(f.actor,'finance-platforms',{name:'无引用平台',code:'TO'});
  const base=await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:f.actor.companyId,type:'finance-base-codes',title:'合成旧款式事实',data:{styleCode:'ZH-TOK-BASE'},status:'pending',createdBy:f.actor.id,updatedBy:f.actor.id}));
  await expect(f.resources.update(f.actor,'finance-platforms',platform.id,{code:'NEWTOK'})).rejects.toThrow(/业务引用/);await expect(f.resources.remove(f.actor,'finance-platforms',platform.id,'删除销售平台')).rejects.toThrow(/被引用/);expect((await f.resources.update(f.actor,'finance-platforms',platform.id,{name:'原平台可改名'})).data.code).toBe('TOK');
  await f.resources.remove(f.actor,'finance-platforms',other.id,'删除无真实引用平台');
  const general=await f.resources.create(f.actor,'finance-platforms',{name:'通用',code:'GENERAL'});await expect(f.resources.update(f.actor,'finance-platforms',general.id,{name:'不能改名'})).rejects.toThrow(/系统保留/);await expect(f.resources.remove(f.actor,'finance-platforms',general.id,'删除通用平台')).rejects.toThrow(/系统保留/);
  await expect(f.resources.create(f.actor,'finance-platforms',{name:'原平台可改名',code:'UNIQUE'})).rejects.toThrow(/已存在/);await expect(f.resources.create(f.actor,'finance-platforms',{name:'非法码平台',code:'A-B'})).rejects.toThrow(/大写字母和数字/);expect(base.data.styleCode).toBe('ZH-TOK-BASE');
 });

});
