import 'reflect-metadata';
import * as crypto from 'crypto';
import {DataSource} from 'typeorm';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,User,ResourceRecord,ResourceChangeLog} from '../entities';
import {buildServices} from '../test-support';
import type {AuthUser} from '../common/auth.decorators';
const db=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
db('原联系/费用查重使用生成后的编号（真实MySQL）',()=>{
 let ds:DataSource,s:ReturnType<typeof buildServices>,user:AuthUser,other:AuthUser;
 beforeAll(async()=>{
  ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never);await ds.initialize();s=buildServices(ds);
  const actor=async()=>{const company=await ds.manager.save(Company,ds.manager.create(Company,{code:crypto.randomBytes(8).toString('hex'),name:'合成查重公司',status:'active'}));const person=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'synthetic',name:'合成维护员',passwordHash:'unused',status:'active',isCompanyAdmin:true,mustChangePassword:false}));return{id:person.id,companyId:company.id,name:person.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};};user=await actor();other=await actor();
 });
 afterAll(async()=>{await ds?.destroy();});
 it('相同联系内容以新自动编号提示相似，复制saveForm可提交且重试不重复',async()=>{
  const values={name:'合成完全同名供货商',phone:'00000000001',bankAccountName:'合成户名',bank:'合成银行',bankAccountNo:'0000000000000000',paymentQr:[]};
  const first=await s.resources.create(user,'finance-suppliers',values),before=await ds.manager.count(ResourceRecord,{where:{companyId:user.companyId,type:'finance-suppliers'}});
  const preview=await s.resources.similarCheck(user,'finance-suppliers',values);expect(preview.blocked).toHaveLength(0);expect(preview.warnings.map(row=>row.id)).toContain(first.id);
  expect(await ds.manager.count(ResourceRecord,{where:{companyId:user.companyId,type:'finance-suppliers'}})).toBe(before);
  const input={requestKey:crypto.randomUUID(),values,collections:[],copySource:{id:first.id,version:first.version!,files:{}}};
  const copy=await s.resources.saveForm(user,'finance-suppliers',input),{paymentQr,...savedValues}=values;expect(copy.data.code).not.toBe(first.data.code);expect(copy.data).toMatchObject(savedValues);expect(copy.data.paymentQr??[]).toEqual(paymentQr);
  expect((await s.resources.saveForm(user,'finance-suppliers',input)).id).toBe(copy.id);expect(await ds.manager.count(ResourceRecord,{where:{companyId:user.companyId,type:'finance-suppliers'}})).toBe(before+1);
 });
 it('手工编号规范化后相同仍服务器拒绝，无保存日志或半份资料',async()=>{
  const first=await s.resources.create(user,'finance-customers',{name:'合成编号原资料',code:'KH-SYN-001'}),before=await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}});
  const candidate={name:'另一个合成客户',code:'KHSYN001'};
  expect((await s.resources.similarCheck(user,'finance-customers',candidate)).blocked.map(row=>row.id)).toContain(first.id);
  await expect(s.resources.create(user,'finance-customers',candidate)).rejects.toThrow(/重复/);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}})).toBe(before);
 });
 it('费用同样提示名称相似/拒绝同编号，默认口径显示中文且不混其他公司',async()=>{
  const values={name:'合成重复费用口径',direction:'expense',platform:'any',isCommon:'yes',needFlow:'by_amount'},first=await s.resources.create(user,'finance-fee-items',{...values,code:'FY-SYN-001'});
  const foreign=await s.resources.create(other,'finance-fee-items',{...values,code:'FY-SYN-001'}),preview=await s.resources.similarCheck(user,'finance-fee-items',values);
  expect(preview.blocked).toHaveLength(0);expect(preview.warnings.map(row=>row.id)).toContain(first.id);expect(preview.warnings.map(row=>row.id)).not.toContain(foreign.id);
  const changed=await s.resources.similarCheck(user,'finance-fee-items',{...values,direction:'income',code:'FY-OTHER'});expect(changed.warnings[0].text).toContain('收入');expect(changed.warnings[0].text).toContain('支出');expect(changed.warnings[0].text).not.toContain('expense');
  const before=await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}});await expect(s.resources.create(user,'finance-fee-items',{...values,code:'FYSYN001'})).rejects.toThrow(/重复/);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:user.companyId}})).toBe(before);
  await expect(s.resources.similarCheck(user,'finance-fee-items',values,foreign.id)).rejects.toThrow(/不存在/);
 });
 it('停用资料仍参与，已归档/删除状态不再制造幽灵提示',async()=>{
  const first=await s.resources.create(user,'finance-customers',{name:'合成状态查重客户',code:'KH-SYN-STATE'});
  await s.resources.changeStatus(user,'finance-customers',first.id,'inactive','合成状态核对');expect((await s.resources.similarCheck(user,'finance-customers',{name:'合成状态查重客户'})).warnings.map(row=>row.id)).toContain(first.id);
  await ds.manager.update(ResourceRecord,first.id,{archivedAt:new Date()});expect((await s.resources.similarCheck(user,'finance-customers',{name:'合成状态查重客户'})).warnings.map(row=>row.id)).not.toContain(first.id);
 });
});
