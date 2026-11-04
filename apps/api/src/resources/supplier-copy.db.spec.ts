import * as crypto from 'crypto';
import {DataSource} from 'typeorm';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,ResourceFile,ResourceRecord,ResourceChangeLog,ResourceFormMutation,User} from '../entities';
import {buildServices} from '../test-support';
import type {AuthUser} from '../common/auth.decorators';
import type {ResourceFormInput} from '@kudesi/shared';
const db=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
db('供应商最终整组复制（隔离MySQL）',()=>{
 let ds:DataSource,s:ReturnType<typeof buildServices>,user:AuthUser,other:AuthUser,categoryId:number;
 beforeAll(async()=>{
  ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME ?? 'kudesi_oa_test_finance_parity_phase72_final'}),migrationsRun:true} as never);await ds.initialize();s=buildServices(ds);
  jest.spyOn(s.settings,'getQiniu').mockResolvedValue({accessKey:'synthetic',secretKey:'synthetic',bucket:'synthetic',zone:'z0',domain:'https://synthetic.invalid',isPrivate:true});
  const actor=async()=>{const c=await ds.manager.save(Company,ds.manager.create(Company,{code:crypto.randomBytes(8).toString('hex'),name:'合成复制公司',status:'active'}));const p=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'synthetic',name:'合成复制员',passwordHash:'unused',status:'active',isCompanyAdmin:true,mustChangePassword:false}));return{id:p.id,companyId:c.id,name:p.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};user=await actor();other=await actor();
  categoryId=(await s.resources.create(user,'finance-supplier-categories',{name:'合成复制分类',categoryCode:'CP'})).id;
 });
 afterAll(async()=>{jest.restoreAllMocks();await ds?.destroy();});
 const source=async()=>{const upload=await s.files.upload(user,'finance-suppliers','paymentQr',{originalname:'合成图.png',buffer:Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),size:8});return s.resources.create(user,'finance-suppliers',{name:`合成源-${crypto.randomUUID()}`,categoryIds:[categoryId],paymentQr:[upload.id],bankAccountName:'原户名',bank:'原开户行',bankAccountNo:'6222 1234 5678 9000'});};
 const request=(row:Awaited<ReturnType<typeof source>>):ResourceFormInput=>({requestKey:crypto.randomUUID(),values:{name:`合成副本-${crypto.randomUUID()}`,categoryIds:[categoryId],paymentQr:[],bankAccountName:row.data.bankAccountName,bank:row.data.bank,bankAccountNo:row.data.bankAccountNo},collections:[],copySource:{id:row.id,version:row.version!,files:{paymentQr:row.data.paymentQr as number[]}}});
 it('只有最终保存生成新ID和绑定，银行明文沿原规则重加密；幂等重试不重复复制，删除任一方不删另一方对象',async()=>{
  const row=await source(),input=request(row),oldId=(row.data.paymentQr as number[])[0],old=await ds.manager.findOneByOrFail(ResourceFile,{id:oldId,companyId:user.companyId});
  const before=await ds.manager.count(ResourceFile,{where:{companyId:user.companyId}}),objectCount=s.storage.objects.size;
  const result=await s.resources.saveForm(user,'finance-suppliers',input),ids=result.data.paymentQr as number[];expect(ids).toHaveLength(1);expect(ids[0]).not.toBe(oldId);expect(result.data.bankAccountNo).toBe(row.data.bankAccountNo);expect(result.data.bank).toBe('原开户行');
  const copied=await ds.manager.findOneByOrFail(ResourceFile,{id:ids[0],companyId:user.companyId});expect(copied).toMatchObject({resourceId:result.id,fieldKey:'paymentQr',storageKey:old.storageKey});expect(s.storage.objects.size).toBe(objectCount);
  const record=await ds.manager.findOneByOrFail(ResourceRecord,{id:result.id,companyId:user.companyId});expect(record.data).not.toHaveProperty('bankAccountNo');expect(s.resources.sensitiveOf(record,'bankAccountNo')).toBe('6222 1234 5678 9000');
  expect((await s.resources.saveForm(user,'finance-suppliers',input)).id).toBe(result.id);expect(await ds.manager.count(ResourceFile,{where:{companyId:user.companyId}})).toBe(before+1);
  await s.resources.update(user,'finance-suppliers',row.id,{paymentQr:[]});expect(s.storage.objects.has(old.storageKey)).toBe(true);expect(s.storage.removed).not.toContain(old.storageKey);expect((await s.resources.get(user,'finance-suppliers',result.id)).data.paymentQr).toEqual(ids);
  await s.resources.update(user,'finance-suppliers',result.id,{paymentQr:[]});expect(s.storage.objects.has(old.storageKey)).toBe(false);expect(s.storage.removed.filter(key=>key===old.storageKey)).toHaveLength(1);
 });
 it('同公司源版本、真实字段和绑定、源查看与目标新增权限必须一致；普通请求不能复用已绑定ID',async()=>{
  const row=await source(),input=request(row),before=await ds.manager.count(ResourceFile,{where:{companyId:user.companyId}});
  await expect(s.resources.create(user,'finance-suppliers',{name:'伪造直接绑定',categoryIds:[categoryId],paymentQr:row.data.paymentQr})).rejects.toThrow(/无效/);
  await expect(s.resources.saveForm(other,'finance-suppliers',input)).rejects.toThrow(/来源不存在/);
  await expect(s.resources.saveForm({...user,permissions:{isCompanyAdmin:false,allow:['resource.finance-suppliers.create'],deny:[]}},'finance-suppliers',input)).rejects.toThrow(/查看|view|没有/);
  await expect(s.resources.saveForm({...user,permissions:{isCompanyAdmin:false,allow:['resource.finance-suppliers.view'],deny:[]}},'finance-suppliers',input)).rejects.toThrow(/新增/);
  await expect(s.resources.saveForm(user,'finance-suppliers',{...input,copySource:{...input.copySource!,files:{notAField:row.data.paymentQr as number[]}}})).rejects.toThrow(/字段/);
  await expect(s.resources.saveForm(user,'finance-suppliers',{...input,copySource:{...input.copySource!,files:{paymentQr:[999999999]}}})).rejects.toThrow(/来源/);
  await s.resources.update(user,'finance-suppliers',row.id,{contact:'源已变化'});await expect(s.resources.saveForm(user,'finance-suppliers',input)).rejects.toThrow(/刚被修改/);
  expect(await ds.manager.count(ResourceFile,{where:{companyId:user.companyId}})).toBe(before);
 });
 it('后续主表失败回滚新File/主档/审计/幂等记录，重试可成功，可信scope不放宽普通verify',async()=>{
  const row=await source(),input=request(row),beforeFiles=await ds.manager.count(ResourceFile,{where:{companyId:user.companyId}}),beforeRows=await ds.manager.count(ResourceRecord,{where:{companyId:user.companyId}}),beforeLogs=await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}}),beforeMutations=await ds.manager.count(ResourceFormMutation,{where:{companyId:user.companyId}}),objects=s.storage.objects.size;
  const spy=jest.spyOn(s.resources as any,'saveRecord').mockRejectedValueOnce(new Error('合成主表失败'));
  try{await expect(s.resources.saveForm(user,'finance-suppliers',input)).rejects.toThrow('合成主表失败');}finally{spy.mockRestore();}
  expect(await ds.manager.count(ResourceFile,{where:{companyId:user.companyId}})).toBe(beforeFiles);expect(await ds.manager.count(ResourceRecord,{where:{companyId:user.companyId}})).toBe(beforeRows);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}})).toBe(beforeLogs);expect(await ds.manager.count(ResourceFormMutation,{where:{companyId:user.companyId}})).toBe(beforeMutations);expect(s.storage.objects.size).toBe(objects);
  expect((await s.resources.saveForm(user,'finance-suppliers',input)).data.paymentQr).toHaveLength(1);
 });
 it('旧双附件/PDF/超限事实只在本次可信克隆保留，普通新绑定依旧拒绝',async()=>{
  const row=await source(),legacy:number[]=[];
  for(const suffix of ['a','b'])legacy.push((await ds.manager.save(ResourceFile,ds.manager.create(ResourceFile,{companyId:user.companyId,resourceType:'finance-suppliers',resourceId:row.id,fieldKey:'paymentQr',storageKey:`legacy-${row.id}-${suffix}`,name:`原文件${suffix}.pdf`,mime:'application/pdf',size:3*1024*1024,uploadedBy:user.id}))).id);
  const original=await ds.manager.findOneByOrFail(ResourceRecord,{id:row.id,companyId:user.companyId});await ds.manager.update(ResourceRecord,{id:row.id,companyId:user.companyId},{data:{...original.data,paymentQr:legacy}});
  const latest=await s.resources.get(user,'finance-suppliers',row.id),result=await s.resources.saveForm(user,'finance-suppliers',request(latest));expect(result.data.paymentQr).toHaveLength(2);expect(Object.values(result.files).map(file=>file.mime)).toEqual(['application/pdf','application/pdf']);
  const unbound=await ds.manager.save(ResourceFile,ds.manager.create(ResourceFile,{companyId:user.companyId,resourceType:'finance-suppliers',resourceId:null,fieldKey:'paymentQr',storageKey:'fake-pdf-copy',name:'伪造旧.pdf',mime:'application/pdf',size:3*1024*1024,uploadedBy:user.id}));await expect(s.resources.create(user,'finance-suppliers',{name:'普通绑定仍被拒绝',categoryIds:[categoryId],paymentQr:[unbound.id]})).rejects.toThrow(/2MB|图片/);
 });
 it('复制持有源行与文件锁时源解绑等待，随后只删源登记且副本对象仍可用',async()=>{
  const row=await source(),input=request(row),oldId=(row.data.paymentQr as number[])[0],file=await ds.manager.findOneByOrFail(ResourceFile,{id:oldId,companyId:user.companyId});
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const original=s.files.cloneFor.bind(s.files);const spy=jest.spyOn(s.files,'cloneFor').mockImplementation(async(...args)=>{const ids=await original(...args);enter();await gate;return ids;});
  let change:Promise<unknown>|undefined;const copy=s.resources.saveForm(user,'finance-suppliers',input);
  try{await entered;let finished=false;change=s.resources.update(user,'finance-suppliers',row.id,{paymentQr:[]}).then(value=>{finished=true;return value;});await new Promise(resolve=>setTimeout(resolve,25));expect(finished).toBe(false);release();const result=await copy;await change;expect(s.storage.objects.has(file.storageKey)).toBe(true);expect((result.data.paymentQr as number[])[0]).not.toBe(oldId);expect(await ds.manager.findOneBy(ResourceFile,{id:oldId,companyId:user.companyId})).toBeNull();}finally{release();await Promise.allSettled([copy,...(change?[change]:[])]);spy.mockRestore();}
 });

});
