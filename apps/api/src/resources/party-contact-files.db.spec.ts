import 'reflect-metadata';
import * as crypto from 'crypto';
import {DataSource} from 'typeorm';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,ResourceFile,ResourceRecord,ResourceChangeLog,ResourceFormMutation,User} from '../entities';
import {buildServices} from '../test-support';
import type {AuthUser} from '../common/auth.decorators';
const db=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
db('往来档案自由电话与收款码局部上传限制（隔离MySQL）',()=>{
 let ds:DataSource,s:ReturnType<typeof buildServices>,user:AuthUser,other:AuthUser,categoryId:number,customerCategory:number;
 beforeAll(async()=>{
  ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME ?? 'kudesi_oa_test_finance_parity_phase72_final'}),migrationsRun:true} as never);await ds.initialize();s=buildServices(ds);
  jest.spyOn(s.settings,'getQiniu').mockResolvedValue({accessKey:'synthetic',secretKey:'synthetic',bucket:'synthetic',zone:'z0',domain:'https://synthetic.invalid',isPrivate:true});
  const actor=async()=>{const c=await ds.manager.save(Company,ds.manager.create(Company,{code:crypto.randomBytes(8).toString('hex'),name:'合成往来公司',status:'active'}));const p=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'synthetic',name:'合成操作员',passwordHash:'unused',status:'active',isCompanyAdmin:true,mustChangePassword:false}));return{id:p.id,companyId:c.id,name:p.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};user=await actor();other=await actor();
  const root=await s.resources.create(user,'finance-supplier-categories',{name:'种子供应商',categoryCode:'ZZ'});categoryId=(await s.resources.create(user,'finance-supplier-categories',{name:'玉米种子',categoryCode:'YM',parentId:root.id})).id;
  customerCategory=(await s.resources.create(user,'finance-customer-categories',{name:'合成客户末级',categoryCode:'KH'})).id;
 });
 afterAll(async()=>{jest.restoreAllMocks();await ds?.destroy();});
 const png=(size=8)=>{const buffer=Buffer.alloc(size);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(buffer);return{originalname:'合成收款码.png',size,buffer};};
 it.each(['finance-suppliers','finance-customers'])('%s的联系电话原文保存，编辑不抹空格/分隔/分机与既有历史内容',async type=>{
  const phone='138 0000 0001 / 400-123-4567 转 9（白天）';const row=await s.resources.create(user,type,{name:`自由电话-${type}`,categoryIds:[type==='finance-suppliers'?categoryId:customerCategory],phone});expect(row.data.phone).toBe(phone);
  expect((await s.resources.update(user,type,row.id,{contact:'合成联系人'})).data.phone).toBe(phone);
 });
 it('单张≤2MB按实际字节和文件头验证，拒绝假图片/PDF/越权，失败不留下对象或登记',async()=>{
  const count=await ds.manager.count(ResourceFile,{where:{companyId:user.companyId}}),objects=s.storage.objects.size;
  await expect(s.files.upload(user,'finance-suppliers','paymentQr',{originalname:'fake.png',size:8,buffer:Buffer.from('%PDF-1.4')})).rejects.toThrow(/图片/);
  await expect(s.files.upload(user,'finance-suppliers','paymentQr',{...png(2*1024*1024+1),size:1})).rejects.toThrow(/2MB/);
  await expect(s.files.upload({...user,permissions:{isCompanyAdmin:false,allow:[],deny:[]}},'finance-suppliers','paymentQr',png())).rejects.toThrow(/权限/);
  expect(await ds.manager.count(ResourceFile,{where:{companyId:user.companyId}})).toBe(count);expect(s.storage.objects.size).toBe(objects);
  s.storage.failUpload=true;try{await expect(s.files.upload(user,'finance-suppliers','paymentQr',png())).rejects.toThrow(/上传/);}finally{s.storage.failUpload=false;}
  const spy=jest.spyOn(ds.manager,'save').mockRejectedValueOnce(new Error('合成登记失败'));
  try{await expect(s.files.upload(user,'finance-suppliers','paymentQr',png())).rejects.toThrow('合成登记失败');}finally{spy.mockRestore();}
  expect(s.storage.objects.size).toBe(objects);expect(await ds.manager.count(ResourceFile,{where:{companyId:user.companyId}})).toBe(count);
 });
 it('旧多附件/旧大文件与PDF保留；新替换只能单图，失败不删旧ID，成功走统一绑定与清理',async()=>{
  const row=await s.resources.create(user,'finance-suppliers',{name:'保留旧收款事实',categoryIds:[categoryId]});
  const legacy=[];for(const suffix of ['a','b']){const file=await ds.manager.save(ResourceFile,ds.manager.create(ResourceFile,{companyId:user.companyId,resourceType:'finance-suppliers',resourceId:row.id,fieldKey:'paymentQr',storageKey:`synthetic-legacy-${row.id}-${suffix}`,name:`原文件${suffix}.pdf`,mime:'application/pdf',size:3*1024*1024,uploadedBy:user.id}));legacy.push(file.id);}
  await ds.manager.update(ResourceRecord,{companyId:user.companyId,id:row.id},{data:{...row.data,paymentQr:legacy}});
  expect((await s.resources.update(user,'finance-suppliers',row.id,{contact:'保留历史附件'})).data.paymentQr).toEqual(legacy);
  const one=await s.files.upload(user,'finance-suppliers','paymentQr',png()),two=await s.files.upload(user,'finance-suppliers','paymentQr',png());
  await expect(s.resources.update(user,'finance-suppliers',row.id,{paymentQr:[one.id,two.id]})).rejects.toThrow(/一张/);
  expect((await s.resources.get(user,'finance-suppliers',row.id)).data.paymentQr).toEqual(legacy);expect(await ds.manager.count(ResourceFile,{where:{id:legacy[0],companyId:user.companyId}})).toBe(1);
  await expect(ds.transaction(em=>s.files.verify(em,other.companyId,'finance-suppliers','paymentQr',[one.id],null))).rejects.toThrow(/无效/);
  expect((await s.resources.update(user,'finance-suppliers',row.id,{paymentQr:[one.id]})).data.paymentQr).toEqual([one.id]);
  expect(await ds.manager.count(ResourceFile,{where:{id:legacy[0],companyId:user.companyId}})).toBe(0);expect(s.storage.removed.some(key=>key===`synthetic-legacy-${row.id}-a`)).toBe(true);
 });
 it('费用初始停用以显式空子表整组事务保存真实原因，权限/原因/子表失败全回滚且幂等',async()=>{
  const category=await s.resources.create(user,'finance-fee-categories',{name:'合成费用目录'});
  const input={requestKey:crypto.randomUUID(),values:{name:'合成初始停用费用',direction:'expense',categoryId:category.id},status:'inactive',statusReason:'合成原业务已停止',collections:[]};
  const beforeMutation=await ds.manager.count(ResourceFormMutation,{where:{companyId:user.companyId}}),beforeRows=await ds.manager.count(ResourceRecord,{where:{companyId:user.companyId,type:'finance-fee-items'}}),beforeLogs=await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}});
  await expect(s.resources.saveForm(user,'finance-fee-items',{...input,requestKey:crypto.randomUUID(),statusReason:''})).rejects.toThrow(/原因/);
  await expect(s.resources.saveForm({...user,permissions:{isCompanyAdmin:false,allow:['resource.finance-fee-items.create','resource.finance-fee-items.view'],deny:[]}},'finance-fee-items',{...input,requestKey:crypto.randomUUID()})).rejects.toThrow(/修改状态/);
  await expect(s.resources.saveForm(user,'finance-fee-items',{...input,requestKey:crypto.randomUUID(),collections:[{type:'finance-product-boms',expected:[],rows:[]}]})).rejects.toThrow(/子表/);
  await expect(s.resources.saveForm(user,'finance-brands',{...input,requestKey:crypto.randomUUID(),values:{name:'不能借未配置事务绕过'}})).rejects.toThrow(/配置/);
  expect(await ds.manager.count(ResourceFormMutation,{where:{companyId:user.companyId}})).toBe(beforeMutation);expect(await ds.manager.count(ResourceRecord,{where:{companyId:user.companyId,type:'finance-fee-items'}})).toBe(beforeRows);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}})).toBe(beforeLogs);
  const result=await s.resources.saveForm(user,'finance-fee-items',input);expect(result).toMatchObject({status:'inactive',statusReason:'合成原业务已停止'});expect(result.data).not.toHaveProperty('__draftStatus');
  expect((await s.resources.saveForm(user,'finance-fee-items',input)).id).toBe(result.id);expect(await ds.manager.count(ResourceRecord,{where:{companyId:user.companyId,type:'finance-fee-items'}})).toBe(beforeRows+1);expect(await ds.manager.count(ResourceFormMutation,{where:{companyId:user.companyId}})).toBe(beforeMutation+1);
 });

});
