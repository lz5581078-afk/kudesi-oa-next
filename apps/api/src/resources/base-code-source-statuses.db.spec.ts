import 'reflect-metadata';
import {randomBytes} from 'crypto';
import {DataSource} from 'typeorm';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,ResourceRecord,User,ResourceChangeLog,OutboxJob} from '../entities';
import {buildServices} from '../test-support';
import {deriveBaseCodeSourceStatuses} from './base-code-source-statuses';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('基础编码真实来源状态批量只读投影',()=>{
 let ds:DataSource,companyId:number,foreign:number,actor:number;
 const put=(type:string,data:Record<string,unknown>,status='active',company=companyId)=>ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:company,type,title:'合成来源',data,status,createdBy:actor,updatedBy:actor}));
 beforeAll(async()=>{ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:false} as never).initialize();const companies=await ds.manager.save(Company,['本','外'].map(s=>ds.manager.create(Company,{code:randomBytes(8).toString('hex'),name:'来源状态'+s,status:'active'})));[companyId,foreign]=companies.map(c=>c.id);actor=(await ds.manager.save(User,ds.manager.create(User,{companyId,account:'source-status',name:'合成用户',passwordHash:'x',status:'active',isCompanyAdmin:true,mustChangePassword:false}))).id;});
 afterAll(async()=>{await ds?.destroy();});
 it('单项与205项都走固定两次SELECT，不选全JSON或财务，保留真实active/inactive/deleted而不猜客户端marker',async()=>{
  const products=await Promise.all(['active','inactive','deleted'].map(status=>put('finance-products',{totalCost:999999,password:'不读'},status)));
  const bases=await ds.manager.save(ResourceRecord,Array.from({length:205},(_,i)=>ds.manager.create(ResourceRecord,{companyId,type:'finance-base-codes',title:'合成来源'+i,data:{productId:products[i%3].id,sourceStatus:'伪造相反状态',cost:888888},status:'pending',createdBy:actor,updatedBy:actor})));
  const runner=ds.createQueryRunner();await runner.connect();try{const query=jest.spyOn(runner,'query');for(const records of [[bases[0]],bases]){query.mockClear();const result=await deriveBaseCodeSourceStatuses(runner.manager,companyId,records);expect(result.size).toBe(records.length);for(const [i,base]of records.entries())expect(result.get(base.id)).toBe(products[i%3].status);expect(query).toHaveBeenCalledTimes(2);for(const [sql]of query.mock.calls){expect(sql).toMatch(/^SELECT /);expect(sql).not.toMatch(/SELECT[^]*[bp]\.data(?:\s|,)|cost|price|secrets|password/i);expect(sql).not.toMatch(/LIMIT /);}}
  }finally{await runner.release();}
 });
 it('别名沿真实同公司根来源；冲突/跨公司根或商品/多层别名/未知及硬删除不冒充deleted',async()=>{
  const product=await put('finance-products',{},'deleted'),root=await put('finance-base-codes',{productId:product.id}),alias=await put('finance-base-codes',{canonicalId:root.id,productId:product.id}),aliasNoProduct=await put('finance-base-codes',{canonicalId:root.id});
  const foreignProduct=await put('finance-products',{},'deleted',foreign),foreignRoot=await put('finance-base-codes',{productId:foreignProduct.id},'active',foreign);
  const invalid=await Promise.all([{productId:foreignProduct.id,sourceStatus:'deleted'},{productId:999999999,sourceStatus:'deleted'},{canonicalId:foreignRoot.id},{canonicalId:root.id,productId:foreignProduct.id},{canonicalId:alias.id},{canonicalId:99999999,productId:product.id},{origin:'composed',productId:product.id},{origin:'external_import',productId:product.id},{}].map(data=>put('finance-base-codes',data)));
  const before=await ds.manager.find(ResourceRecord,{where:{companyId},order:{id:'ASC'}}),logs=await ds.manager.count(ResourceChangeLog,{where:{companyId}}),jobs=await ds.manager.count(OutboxJob,{where:{companyId}});
  const result=await deriveBaseCodeSourceStatuses(ds.manager,companyId,[root,alias,aliasNoProduct,foreignRoot,...invalid]);for(const base of [root,alias,aliasNoProduct])expect(result.get(base.id)).toBe('deleted');for(const base of [foreignRoot,...invalid])expect(result.get(base.id)).toBeNull();
  expect(await ds.manager.find(ResourceRecord,{where:{companyId},order:{id:'ASC'}})).toEqual(before);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId}})).toBe(logs);expect(await ds.manager.count(OutboxJob,{where:{companyId}})).toBe(jobs);
 });
 it('真实ResourcesService GET投影顶层状态，不返来源JSON且成本读权限仍限制原DTO',async()=>{
  const product=await put('finance-products',{totalCost:987654.321,purchasePrice:876543.21,note:'SOURCE-FINANCE-SECRET'},'deleted'),base=await put('finance-base-codes',{productId:product.id,cost:12345,sourceStatus:'客户端假状态'});
  const actorRow=await ds.manager.findOneByOrFail(User,{id:actor,companyId}),viewer={id:actor,companyId,name:actorRow.name,permissions:{isCompanyAdmin:false,allow:['resource.finance-base-codes.view'],deny:['product.cost.view','product.price.view']}};
  const got=await buildServices(ds).resources.get(viewer,'finance-base-codes',base.id);
  expect(got.sourceStatus).toBe('deleted');expect(got.data).not.toHaveProperty('cost');expect(got.data).not.toHaveProperty('purchasePrice');expect(got).not.toHaveProperty('source');expect(JSON.stringify(got)).not.toMatch(/SOURCE-FINANCE-SECRET|987654|876543/);
  const alias=await put('finance-base-codes',{canonicalId:base.id,productId:product.id});expect((await buildServices(ds).resources.get(viewer,'finance-base-codes',alias.id)).sourceStatus).toBe('deleted');
 });
 it('空批不查库，归档不是删除证据',async()=>{expect(await deriveBaseCodeSourceStatuses(ds.manager,companyId,[])).toEqual(new Map());const p=await put('finance-products',{});await ds.manager.update(ResourceRecord,{id:p.id},{archivedAt:new Date()});const b=await put('finance-base-codes',{productId:p.id});expect((await deriveBaseCodeSourceStatuses(ds.manager,companyId,[b])).get(b.id)).toBeNull();});
});
