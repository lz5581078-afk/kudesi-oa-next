import 'reflect-metadata';
import {randomBytes,randomUUID} from 'crypto';
import {DataSource,EntityManager} from 'typeorm';
import {archiveQualityContext,archiveQualityFields,type ResourceFormInput,type SourceQualityCommand,type SourceQualityFacts} from '@kudesi/shared';
import type {AuthUser} from '../common/auth.decorators';
import {Company,Position,ResourceChangeLog,ResourceFormMutation,ResourceRecord,User} from '../entities';
import {buildDataSourceOptions} from '../database/data-source';
import {buildServices} from '../test-support';
import {loadSourceProductQualityFacts,sourceProductQualityActive,sourceQualityConfirmedLegacyZero} from './source-product-quality';
const db=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
db('Source商品整组质量确认真实保存边界',()=>{
 let ds:DataSource,svc:ReturnType<typeof buildServices>['resources'],user:AuthUser,product:ResourceRecord,source:ResourceRecord,supplierId:number;
 beforeAll(async()=>{ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();svc=buildServices(ds).resources;});
 afterAll(async()=>{await ds?.destroy();});
 beforeEach(async()=>{
  const company=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'质量合成公司',status:'active'}));
  const person=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'synthetic',name:'合成质量管理员',passwordHash:'unused',status:'active',isCompanyAdmin:true,mustChangePassword:false}));user={id:person.id,companyId:company.id,name:person.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
  await svc.create(user,'finance-product-units',{kind:'spec_unit',name:'千克',code:'KG'});
  const category=await svc.create(user,'finance-categories',{archiveType:'raw',name:'原料',code:'HC'}),supplierCategory=await svc.create(user,'finance-supplier-categories',{name:'供应商',code:'SUP'});
  supplierId=(await svc.create(user,'finance-suppliers',{name:'合成供应商',categoryIds:[supplierCategory.id]})).id;
  const p=await svc.create(user,'finance-products',{archiveType:'raw',name:'合成苹果',categoryId:category.id,specQty:1,specUnit:'KG',purchaseSpec:'1千克',purchasePrice:100,freight:1,handlingFee:1});
  const child=await svc.create(user,'finance-product-sources',{productId:p.id,supplierId,originArea:'山东',purchasePrice:100});
  product=await ds.manager.findOneByOrFail(ResourceRecord,{id:p.id,companyId:user.companyId});source=await ds.manager.findOneByOrFail(ResourceRecord,{id:child.id,companyId:user.companyId});
 });
 const confirm=(facts:SourceQualityFacts)=>Object.fromEntries(archiveQualityFields(facts.parent,{canCost:true,sourceFacts:facts}).filter(field=>field.value!=null&&String(field.value)!==''&&Number(field.value)===0&&field.mode!=='positive').map(field=>[field.id,{reason:'合成业务确认为零',context:archiveQualityContext(facts)}]));
 const request=async(change:Record<string,unknown>={},sourceChange:Record<string,unknown>={}):Promise<ResourceFormInput>=>{
  const current=await svc.get(user,'finance-products',product.id),child=await svc.get(user,'finance-product-sources',source.id);
  const facts=await loadSourceProductQualityFacts(ds.manager,user.companyId,await ds.manager.findOneByOrFail(ResourceRecord,{id:product.id}));facts.parent={...facts.parent,...change};facts.sources[0]={...facts.sources[0],...sourceChange};
  const command:SourceQualityCommand={version:1,rows:[{type:'finance-product-sources',index:0,key:`id:${source.id}`,id:source.id}],confirmations:confirm(facts)};
  return {requestKey:randomUUID(),id:product.id,version:current.version!,values:{...change,__sourceQuality:command},collections:[{type:'finance-product-sources',expected:[{id:source.id,version:child.version!}],rows:[{id:source.id,values:sourceChange}]}]};
 };
 it('实际Source保存各零逐项确认并持久actual ID上下文；幂等重试同记录',async()=>{
  const body=await request({freight:0,handlingFee:0},{purchasePrice:0});
  const result=await svc.saveForm(user,'finance-products',structuredClone(body));const stored=await ds.manager.findOneByOrFail(ResourceRecord,{id:product.id});
  const facts=await loadSourceProductQualityFacts(ds.manager,user.companyId,stored);expect(stored.data.sourceQualityConfirmations).toEqual(confirm(facts));expect(stored.data).not.toHaveProperty('__sourceQuality');expect(stored.data.zeroValueReason).toContain('运费：合成业务确认为零');expect(String(stored.data.zeroValueReason)).not.toContain('来源');expect((await svc.saveForm(user,'finance-products',structuredClone(body))).id).toBe(result.id);await expect(svc.update(user,'finance-products',product.id,{note:'普通API只改说明'})).resolves.toBeDefined();
 });
 it('上下文变化使旧确认失效并回滚主子、日志和幂等；原key修正后仍可提交',async()=>{
  await svc.saveForm(user,'finance-products',await request({freight:0,handlingFee:0},{purchasePrice:0}));
  const body=await request({purchaseSpec:'2千克'}),stored=await ds.manager.findOneByOrFail(ResourceRecord,{id:product.id});
  (body.values.__sourceQuality as SourceQualityCommand).confirmations=stored.data.sourceQualityConfirmations as SourceQualityCommand['confirmations'];
  const before=await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}});
  await expect(svc.saveForm(user,'finance-products',structuredClone(body))).rejects.toThrow('尚未明确确认');
  expect((await ds.manager.findOneByOrFail(ResourceRecord,{id:product.id})).data.purchaseSpec).toBe(stored.data.purchaseSpec);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}})).toBe(before);expect(await ds.manager.count(ResourceFormMutation,{where:{companyId:user.companyId,requestKey:body.requestKey}})).toBe(0);
  const repaired=await request({purchaseSpec:'2千克'});repaired.requestKey=body.requestKey;await expect(svc.saveForm(user,'finance-products',repaired)).resolves.toBeDefined();
 });
 it('普通写改变上下文不会读时重签，下一次Source即使无其它变更也必须重新确认',async()=>{
  await svc.saveForm(user,'finance-products',await request({freight:0,handlingFee:0},{purchasePrice:0}));
  const before=await ds.manager.findOneByOrFail(ResourceRecord,{id:product.id});await svc.update(user,'finance-products',product.id,{purchaseSpec:'3千克',zeroValueReason:String(before.data.zeroValueReason)+'\n采购价：原料本次不计采购价'});
  const after=await ds.manager.findOneByOrFail(ResourceRecord,{id:product.id});expect(after.data.sourceQualityConfirmations).toEqual(before.data.sourceQualityConfirmations);
  const stale=await request();(stale.values.__sourceQuality as SourceQualityCommand).confirmations=before.data.sourceQualityConfirmations as SourceQualityCommand['confirmations'];await expect(svc.saveForm(user,'finance-products',stale)).rejects.toThrow('尚未明确确认');
  await expect(svc.saveForm(user,'finance-products',await request())).resolves.toBeDefined();
 });
 it('新增来源UUID重写actualID，同价第二来源不能借第一来源的确认',async()=>{
  const body=await request(),key=randomUUID(),facts=await loadSourceProductQualityFacts(ds.manager,user.companyId,product);facts.sources.push({key,supplierId,originArea:'河北',systemSpec:'1千克',purchasePrice:0});
  const command=body.values.__sourceQuality as SourceQualityCommand;command.rows.push({type:'finance-product-sources',index:1,key});command.confirmations=confirm(facts);
  body.collections[0].rows.push({values:{supplierId,originArea:'河北',systemSpec:'1千克',purchasePrice:0}});
  await svc.saveForm(user,'finance-products',body);const stored=await ds.manager.findOneByOrFail(ResourceRecord,{id:product.id}),actual=await loadSourceProductQualityFacts(ds.manager,user.companyId,stored),newSource=actual.sources.find(row=>row.id!==source.id)!;
  expect(stored.data.sourceQualityConfirmations).toHaveProperty(`source:id:${newSource.id}:purchasePrice`);expect(JSON.stringify(stored.data.sourceQualityConfirmations)).not.toContain(key);
 });
 it('伪造/遗漏映射或跨公司既有ID拒绝；普通CRUD旧理由契约不被Source flag绕过',async()=>{
  const incomplete=await request();(incomplete.values.__sourceQuality as SourceQualityCommand).rows=[];await expect(svc.saveForm(user,'finance-products',incomplete)).rejects.toThrow('绑定不完整');
  const forged=await request();(forged.values.__sourceQuality as SourceQualityCommand).rows[0].id=source.id+1000;await expect(svc.saveForm(user,'finance-products',forged)).rejects.toThrow('不属于实际提交');
  await expect(svc.update(user,'finance-products',product.id,{freight:0})).rejects.toThrow('填了 0');await expect(svc.update(user,'finance-products',product.id,{freight:0,zeroValueReason:'运费：自提'})).resolves.toBeDefined();
  await expect(svc.update(user,'finance-products',product.id,{__sourceQuality:{version:1,rows:[],confirmations:{}},handlingFee:0})).rejects.toThrow();
  expect((await ds.manager.findOneByOrFail(ResourceRecord,{id:product.id})).data).not.toHaveProperty('sourceQualityConfirmations');
 });
 it('真实get/list/logs不向无成本/仓库角色泄露确认上下文，跨公司及伪造持久确认拒绝',async()=>{
  await svc.saveForm(user,'finance-products',await request({freight:0,handlingFee:0},{purchasePrice:0}));
  const viewer:AuthUser={...user,permissions:{isCompanyAdmin:false,allow:['resource.finance-products.view'],deny:['product.cost.view']}};
  expect((await svc.get(viewer,'finance-products',product.id)).data).not.toHaveProperty('sourceQualityConfirmations');
  expect((await svc.list(viewer,'finance-products',{pageSize:100})).items.find(row=>row.id===product.id)!.data).not.toHaveProperty('sourceQualityConfirmations');
  expect(JSON.stringify(await svc.logs(viewer,'finance-products',product.id))).not.toContain('sourceQualityConfirmations');
  const position=await ds.manager.save(Position,ds.manager.create(Position,{companyId:user.companyId,name:'合成仓库',workspaceType:'warehouse',status:'active'}));await ds.manager.update(User,{id:user.id},{positionId:position.id});
  const warehouse:AuthUser={...viewer,permissions:{isCompanyAdmin:false,allow:['resource.finance-products.view','product.cost.view'],deny:[]}};
  expect((await svc.get(warehouse,'finance-products',product.id)).data).not.toHaveProperty('sourceQualityConfirmations');
  await expect(svc.get({...user,companyId:user.companyId+100000},'finance-products',product.id)).rejects.toThrow();
  await expect(svc.update(user,'finance-products',product.id,{sourceQualityConfirmations:{freight:{reason:'伪造',context:'假'}}})).rejects.toThrow();
 });
 it('旧未确认资料只在实际全指纹不变时保留且不升级；复制必须重新确认但允许合法fresh确认',async()=>{
  product.data={...product.data,freight:0,handlingFee:0};await ds.manager.save(product);
  const unchanged=await request({note:'旧核算资料未动'});(unchanged.values.__sourceQuality as SourceQualityCommand).confirmations={};await expect(svc.saveForm(user,'finance-products',unchanged)).resolves.toBeDefined();
  const stored=await ds.manager.findOneByOrFail(ResourceRecord,{id:product.id});expect(stored.data).not.toHaveProperty('sourceQualityConfirmations');
  const changed=await request({name:'旧资料改名'});(changed.values.__sourceQuality as SourceQualityCommand).confirmations={};await expect(svc.saveForm(user,'finance-products',changed)).rejects.toThrow('尚未明确确认');
  const key=randomUUID(),facts=await loadSourceProductQualityFacts(ds.manager,user.companyId,stored);facts.sources[0].key=key;
  const current=await svc.get(user,'finance-products',product.id);
  const copy:ResourceFormInput={requestKey:randomUUID(),copySource:{id:product.id,version:current.version!,files:{}},values:{archiveType:'raw',name:'合成苹果复制',categoryId:stored.data.categoryId,specQty:1,specUnit:'KG',purchaseSpec:'1千克',purchasePrice:100,freight:0,handlingFee:0,__sourceQuality:{version:1,rows:[{type:'finance-product-sources',index:0,key}],confirmations:{}}},collections:[{type:'finance-product-sources',expected:[],rows:[{values:{supplierId,originArea:'山东',systemSpec:'1千克',purchasePrice:100}}]}]};
  await expect(svc.saveForm(user,'finance-products',structuredClone(copy))).rejects.toThrow('尚未明确确认');
  (copy.values.__sourceQuality as SourceQualityCommand).confirmations=confirm(facts);const copied=await svc.saveForm(user,'finance-products',copy);expect(copied.id).not.toBe(product.id);expect((await ds.manager.findOneByOrFail(ResourceRecord,{id:copied.id})).data.sourceQualityConfirmations).toBeDefined();
 });
 it('脱敏维护人只能原样复用真实有效旧确认，不能签新财务0或改变核算上下文',async()=>{
  await svc.saveForm(user,'finance-products',await request({freight:0,handlingFee:0},{purchasePrice:0}));
  const actor:AuthUser={...user,permissions:{isCompanyAdmin:false,allow:['resource.finance-products.view','resource.finance-products.edit'],deny:['product.cost.view','product.cost.edit']}};
  const body=await request({note:'只改非核算说明'});(body.values.__sourceQuality as SourceQualityCommand).confirmations={};await expect(svc.saveForm(actor,'finance-products',body)).resolves.toBeDefined();
  const changed=await request({purchaseSpec:'2千克'});(changed.values.__sourceQuality as SourceQualityCommand).confirmations={};await expect(svc.saveForm(actor,'finance-products',changed)).rejects.toThrow('尚未明确确认');
 });
 it('普通旧零只复用实际当前来源ID的有效确认，不按同价/供应商猜并且只读',async()=>{
  await svc.saveForm(user,'finance-products',await request({freight:0,handlingFee:0},{purchasePrice:0}));
  const current=await ds.manager.findOneByOrFail(ResourceRecord,{id:product.id}),logs=await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}});
  expect(await sourceQualityConfirmedLegacyZero(ds.manager,user,current,{...current.data},'purchasePrice')).toBe(true);
  expect(await sourceQualityConfirmedLegacyZero(ds.manager,user,current,{...current.data,purchaseSpec:'上下文已改'},'purchasePrice')).toBe(false);
  expect(await sourceQualityConfirmedLegacyZero(ds.manager,{...user,companyId:user.companyId+1},current,current.data,'purchasePrice')).toBe(false);
  expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}})).toBe(logs);
  await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:user.companyId,type:'finance-product-sources',title:'同供应商同价格但真实新来源',status:'active',data:{productId:product.id,supplierId,originArea:'山东',systemSpec:'1千克',purchasePrice:0,priceUpdatedAt:new Date(Date.now()+1000).toISOString()},createdBy:user.id,updatedBy:user.id}));
  expect(await sourceQualityConfirmedLegacyZero(ds.manager,user,current,current.data,'purchasePrice')).toBe(false);
 });
 it.each(['self_made','supplier_oem'])('真实%s组成/费用按完整事实校验，原可选组不额外要求不存在人工',async family=>{
  const type=family==='self_made'?'self_made':'purchased';
  const category=await svc.create(user,'finance-categories',{archiveType:family,name:'合成成品分类',code:'CP'}),brand=await svc.create(user,'finance-brands',{name:'合成品牌',code:'HC'});
  const parent=await svc.create(user,'finance-products',{archiveType:type,...(family==='supplier_oem'?{supplyMode:'supplier_oem'}:{}),name:'合成质量成品',categoryId:category.id,brandId:brand.id,specQty:1,specUnit:'KG',purchaseSpec:'1千克',productPackagingSpec:'1盒',productPackagingUnit:'KG',weightManual:true,weightG:1000,purchasePrice:100,freight:1,handlingFee:1});
  const bom=family==='self_made'?await svc.create(user,'finance-product-boms',{productId:parent.id,componentId:product.id,qty:1}):null;
  const current=await svc.get(user,'finance-products',parent.id),actual=await ds.manager.findOneByOrFail(ResourceRecord,{id:parent.id});const facts=await loadSourceProductQualityFacts(ds.manager,user.companyId,actual);facts.parent={...facts.parent,freight:0,handlingFee:0,...(family==='supplier_oem'?{purchasePrice:0}:{})};
  const command:SourceQualityCommand={version:1,rows:bom?[{type:'finance-product-boms',index:0,key:`id:${bom.id}`,id:bom.id}]:[],confirmations:confirm(facts)};
  const body:ResourceFormInput={requestKey:randomUUID(),id:parent.id,version:current.version!,values:{freight:0,handlingFee:0,...(family==='supplier_oem'?{purchasePrice:0}:{}),__sourceQuality:command},collections:bom?[{type:'finance-product-boms',expected:[{id:bom.id,version:bom.version!}],rows:[{id:bom.id,values:{}}]}]:[]};
  await expect(svc.saveForm(user,'finance-products',body)).resolves.toBeDefined();const stored=await ds.manager.findOneByOrFail(ResourceRecord,{id:parent.id});
  expect(stored.data.sourceQualityConfirmations).toEqual(expect.objectContaining({packagingGroup:expect.any(Object),freight:expect.any(Object),handlingFee:expect.any(Object)}));
  if(family==='supplier_oem')expect(stored.data.sourceQualityConfirmations).not.toHaveProperty('laborGroup');else{expect(stored.data.sourceQualityConfirmations).toHaveProperty('laborGroup');const changed=structuredClone(body);changed.requestKey=randomUUID();changed.version=(await svc.get(user,'finance-products',parent.id)).version!;changed.collections[0].expected[0].version=(await svc.get(user,'finance-product-boms',bom!.id)).version!;changed.collections[0].rows[0].values={qty:2};await expect(svc.saveForm(user,'finance-products',changed)).rejects.toThrow('尚未明确确认');expect((await svc.get(user,'finance-product-boms',bom!.id)).data.qty).toBe(1);}
 });
 it('最终故障整组回滚且可信scope finally清理，客户端flag不能残留豁免',async()=>{
  const body=await request({freight:0,handlingFee:0}),original=EntityManager.prototype.update;let manager:EntityManager|undefined;
  const spy=jest.spyOn(EntityManager.prototype,'update').mockImplementation(function(this:EntityManager,...args:Parameters<typeof original>){if(args[0]===ResourceFormMutation){manager=this;throw new Error('合成末尾失败');}return original.apply(this,args);});
  try{await expect(svc.saveForm(user,'finance-products',structuredClone(body))).rejects.toThrow('合成末尾失败');}finally{spy.mockRestore();}
  expect(manager).toBeDefined();expect(sourceProductQualityActive(manager!,user)).toBe(false);expect((await ds.manager.findOneByOrFail(ResourceRecord,{id:product.id})).data.freight).toBe(1);expect(await ds.manager.count(ResourceFormMutation,{where:{companyId:user.companyId,requestKey:body.requestKey}})).toBe(0);
  await expect(svc.saveForm(user,'finance-products',body)).resolves.toBeDefined();
 });
});
