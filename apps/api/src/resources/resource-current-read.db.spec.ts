import 'reflect-metadata';
import {randomUUID} from 'crypto';
import {DataSource} from 'typeorm';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,ResourceRecord,User} from '../entities';
import {buildServices} from '../test-support';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('内部联动使用当前读更新并发新行',()=>{
 let ds:DataSource;
 beforeAll(async()=>{ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true} as never).initialize();},30000);
 afterAll(async()=>{await ds?.destroy();});
 it('旧快照没有新行，当前读看见后只UPDATE，不经save重新INSERT同一主键',async()=>{
  const company=await ds.manager.save(Company,ds.manager.create(Company,{code:'cr'+randomUUID().slice(0,8),name:'合成当前读'}));
  const person=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'admin',passwordHash:'synthetic',name:'合成管理员',isCompanyAdmin:true,status:'active',mustChangePassword:false}));
  const user={id:person.id,companyId:company.id,name:person.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}},svc=buildServices(ds).resources;
  const tx=ds.createQueryRunner();await tx.connect();await tx.startTransaction('REPEATABLE READ');
  try{
   await tx.manager.find(ResourceRecord,{where:{companyId:company.id}});
   const brand=await svc.create(user,'finance-brands',{name:'并发新建品牌'});
   expect(await tx.manager.findOneBy(ResourceRecord,{companyId:company.id,id:brand.id})).toBeNull();
   await svc.patchData(tx.manager,user,'finance-brands',brand.id,{name:'当前读更新品牌'},'合成当前读验证',false,true);
   await tx.commitTransaction();
   expect((await svc.get(user,'finance-brands',brand.id)).data).toMatchObject({name:'当前读更新品牌',code:brand.data.code});
   expect(await ds.manager.count(ResourceRecord,{where:{companyId:company.id,id:brand.id}})).toBe(1);
  }catch(error){if(tx.isTransactionActive)await tx.rollbackTransaction();throw error;}finally{await tx.release();}
 });
});
