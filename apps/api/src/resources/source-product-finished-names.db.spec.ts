import 'reflect-metadata';
import {randomBytes,randomUUID,createHash} from 'crypto';
import {DataSource} from 'typeorm';
import {INestApplication,ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {ResourcesController} from './resources.controller';
import {ResourcesService} from './resources.service';
import {GridSaveService} from './grid-save.service';
import {DataToolsService} from './data-tools.service';
import {type ResourceFormInput} from '@kudesi/shared';
import {buildDataSourceOptions} from '../database/data-source';
import {Company,User,ResourceRecord,ResourceChangeLog,ResourceFormMutation,OutboxJob} from '../entities';
import {buildServices} from '../test-support';
import type {AuthUser} from '../common/auth.decorators';
import {recordVersion} from './resource-record-version';
import {SOURCE_FINISHED_NAMES_COMMAND,sourceFinishedNameCode,type SourceFinishedNamesCommand,type SourceFinishedNameRow} from './source-product-finished-names';
import {aliasCode} from './base-code-support';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('R05 source原料成品名稳定身份（隔离MySQL）',()=>{
 let ds:DataSource,s:ReturnType<typeof buildServices>,boss:AuthUser,other:AuthUser,viewer:AuthUser,categoryId:number,supplierId:number,seq=0,app:INestApplication,url:string;
 const raw=async(names='原名')=>s.resources.create(boss,'finance-products',{archiveType:'raw',name:'稳定原料'+(++seq),categoryId,purchaseSpec:'千克',specQty:1,specUnit:'KG',purchasePrice:1000,freight:100,handlingFee:50,rawFinishedNames:names});
 const aliases=(pid:number)=>ds.manager.createQueryBuilder(ResourceRecord,'a').where('a.companyId=:companyId AND a.type=:type',{companyId:boss.companyId,type:'finance-base-codes'}).andWhere("JSON_EXTRACT(a.data,'$.productId')=:pid AND JSON_EXTRACT(a.data,'$.canonicalId') IS NOT NULL",{pid}).orderBy('a.id','ASC').getMany();
 const command=(rows:SourceFinishedNameRow[],before:ResourceRecord[]):SourceFinishedNamesCommand=>({version:1,expected:before.map(a=>({aliasRecordId:a.id,version:recordVersion(a)})),rows});
 const save=async(pid:number,cmd:SourceFinishedNamesCommand,over:Partial<ResourceFormInput>={},actor=boss)=>{const p=await ds.manager.findOneByOrFail(ResourceRecord,{id:pid,companyId:boss.companyId,type:'finance-products'});return s.resources.saveForm(actor,'finance-products',{requestKey:randomUUID(),id:p.id,version:recordVersion(p),values:{rawFinishedNames:cmd.rows.map(r=>r.name).join('\n'),[SOURCE_FINISHED_NAMES_COMMAND]:cmd},collections:[],...over});};
 const snapshot=async()=>({records:await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId},order:{id:'ASC'}}),logs:await ds.manager.count(ResourceChangeLog,{where:{companyId:boss.companyId}}),mutations:await ds.manager.count(ResourceFormMutation,{where:{companyId:boss.companyId}}),jobs:await ds.manager.count(OutboxJob,{where:{companyId:boss.companyId}})});
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:false} as never).initialize();s=buildServices(ds);
  const actors=[];for(const suffix of ['本','外']){const c=await ds.manager.save(Company,ds.manager.create(Company,{code:'sf'+randomBytes(7).toString('hex'),name:'稳定成品名'+suffix,status:'active'}));const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:'admin',name:'合成管理员',passwordHash:'synthetic',status:'active',isCompanyAdmin:true}));actors.push({id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}});} [boss,other]=actors;
  const readUser=await ds.manager.save(User,ds.manager.create(User,{companyId:boss.companyId,account:'viewer',name:'真实合成只读人',passwordHash:'synthetic',status:'active',isCompanyAdmin:false}));viewer={id:readUser.id,companyId:boss.companyId,name:readUser.name,permissions:{isCompanyAdmin:false,allow:['resource.finance-products.view'],deny:[]}};
  categoryId=(await s.resources.create(boss,'finance-categories',{archiveType:'raw',name:'稳定身份分类',code:'SID'})).id;
  supplierId=(await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:boss.companyId,type:'finance-suppliers',title:'合成供货方',status:'active',data:{name:'合成供货方',shortCode:'HC'},createdBy:boss.id,updatedBy:boss.id}))).id;
 });
 afterAll(async()=>{await app?.close();await ds?.destroy();});
 it('source新增用真24 String(company/product)+UUID业务码，保存后返回真实id/version/token，重试不重复',async()=>{
  const token=randomUUID(),cmd=command([{name:'稳定新名',rowToken:token}],[]),input:ResourceFormInput={requestKey:randomUUID(),values:{archiveType:'raw',name:'source新建原料',categoryId,purchaseSpec:'千克',specQty:1,specUnit:'KG',purchasePrice:1000,freight:100,handlingFee:50,rawFinishedNames:'稳定新名',[SOURCE_FINISHED_NAMES_COMMAND]:cmd},collections:[{type:'finance-product-sources',expected:[],rows:[{values:{supplierId,originArea:'合成产区',systemSpec:'千克',purchasePrice:1000}}]}]};
  const p=await s.resources.saveForm(boss,'finance-products',structuredClone(input)),rows=await aliases(p.id);expect(rows).toHaveLength(1);const expected=`YL-${createHash('sha256').update(JSON.stringify([String(boss.companyId),String(p.id),token])).digest('hex').slice(0,20).toUpperCase()}`;expect(rows[0].data).toMatchObject({code:expected,aliasKey:aliasCode(boss.companyId,p.id,'稳定新名'),sourceFinishedRowToken:token});expect(sourceFinishedNameCode(boss.companyId,p.id,token)).toBe(expected);
  expect(p.data.__finishedNameDetails).toEqual([expect.objectContaining({name:'稳定新名',code:expected,aliasRecordId:rows[0].id,version:recordVersion(rows[0]),rowToken:token})]);expect(p.data).not.toHaveProperty(SOURCE_FINISHED_NAMES_COMMAND);expect((await s.resources.saveForm(boss,'finance-products',structuredClone(input))).id).toBe(p.id);expect(await aliases(p.id)).toHaveLength(1);
 });
 it('实际source复制使用fresh UUID与新alias ID/code，不带原记录身份',async()=>{
  const original=await raw(),old=(await aliases(original.id))[0],token=randomUUID(),input:ResourceFormInput={requestKey:randomUUID(),copySource:{id:original.id,version:original.version!,files:{}},values:{archiveType:'raw',name:'source原料副本',categoryId,purchaseSpec:'千克',specQty:1,specUnit:'KG',purchasePrice:1000,freight:100,handlingFee:50,rawFinishedNames:'原名',[SOURCE_FINISHED_NAMES_COMMAND]:command([{name:'原名',rowToken:token}],[])},collections:[{type:'finance-product-sources',expected:[],rows:[{values:{supplierId,originArea:'合成复制产区',systemSpec:'千克',purchasePrice:1000}}]}]};
  const copy=await s.resources.saveForm(boss,'finance-products',input),rows=await aliases(copy.id);expect(copy.id).not.toBe(original.id);expect(rows).toHaveLength(1);expect(rows[0].id).not.toBe(old.id);expect(rows[0].data.code).toBe(sourceFinishedNameCode(boss.companyId,copy.id,token));expect(rows[0].data.code).not.toBe(old.data.code);expect((await aliases(original.id))[0].data.code).toBe(old.data.code);
 });
 it('既有/迁移/已同步且被组合引用行改名保原ID和code，不经过删除guard',async()=>{
  const p=await raw();let initial=(await aliases(p.id))[0];initial.data={...initial.data,code:'YL-PRESERVED-LEGACY',migratedAliasName:'原名',migratedAliasSpec:JSON.stringify([1,'KG']),jstStatus:'synced',jstUploadedCode:'YL-PRESERVED-LEGACY'};initial.uniqueKey='yl-preserved-legacy';await ds.manager.save(initial);initial=await ds.manager.findOneByOrFail(ResourceRecord,{id:initial.id,companyId:boss.companyId});
  const bundle=await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:boss.companyId,type:'finance-bundles',title:'合成真实引用父',status:'pending',data:{code:'SYNTHETIC-REF',name:'合成引用'},createdBy:boss.id,updatedBy:boss.id}));const line=await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:boss.companyId,type:'finance-bundle-lines',title:'合成真实引用行',status:'active',data:{bundleId:bundle.id,baseCodeId:initial.id,qty:1,role:'main'},createdBy:boss.id,updatedBy:boss.id}));
  const token=randomUUID();await save(p.id,command([{name:'改后名称',rowToken:token,aliasRecordId:initial.id,version:recordVersion(initial)}],[initial]));let rows=await aliases(p.id);expect(rows).toHaveLength(1);expect(rows[0].id).toBe(initial.id);expect(rows[0].data).toMatchObject({code:'YL-PRESERVED-LEGACY',sourceFinishedRowToken:token,aliasKey:aliasCode(boss.companyId,p.id,'改后名称'),jstStatus:'synced'});expect((await ds.manager.findOneByOrFail(ResourceRecord,{id:line.id})).data.baseCodeId).toBe(initial.id);
  const before=await snapshot();await expect(save(p.id,command([],rows))).rejects.toThrow(/同步|引用/);expect(await snapshot()).toEqual(before);
  const row=rows[0];await save(p.id,command([{name:'再次改名',rowToken:token,aliasRecordId:row.id,version:recordVersion(row)}],rows));rows=await aliases(p.id);expect(rows[0].id).toBe(initial.id);expect(rows[0].data.code).toBe('YL-PRESERVED-LEGACY');
 });
 it('跨公司/伪造ID/版本/重复名或token/缺少完整expected/绑定token改变均回滚无审计副作用',async()=>{
  const p=await raw(),a=(await aliases(p.id))[0],token=randomUUID(),valid=command([{name:'原名',rowToken:token,aliasRecordId:a.id,version:recordVersion(a)}],[a]);
  const cases=[{...valid,rows:[{...valid.rows[0],name:''}]},{...valid,expected:[]},{...valid,rows:[{...valid.rows[0],aliasRecordId:a.id+999999}]},{...valid,rows:[{...valid.rows[0],version:'0'.repeat(16)}]},{...valid,rows:[{...valid.rows[0],rowToken:'invalid'}]},{...valid,rows:[valid.rows[0],{name:'另一名',rowToken:token}]},{...valid,rows:[valid.rows[0],{name:'原 名',rowToken:randomUUID()}]}];
  for(const cmd of cases){const before=await snapshot();await expect(save(p.id,cmd)).rejects.toThrow();expect(await snapshot()).toEqual(before);}
  const before=await snapshot();await expect(save(p.id,valid,{},other)).rejects.toThrow(/不存在/);expect(await snapshot()).toEqual(before);
  await save(p.id,valid);const bound=(await aliases(p.id))[0],changed=command([{name:'原名',rowToken:randomUUID(),aliasRecordId:bound.id,version:recordVersion(bound)}],[bound]);const after=await snapshot();await expect(save(p.id,changed)).rejects.toThrow(/标识已变化/);expect(await snapshot()).toEqual(after);
 });
 it('已绑定token不可在新行或另一parent重放；新建/复制携带已有alias ID拒绝',async()=>{
  const p=await raw(),a=(await aliases(p.id))[0],token=randomUUID();await save(p.id,command([{name:'原名',rowToken:token,aliasRecordId:a.id,version:recordVersion(a)}],[a]));const q=await raw('另一个名'),qa=(await aliases(q.id))[0];const before=await snapshot();await expect(save(q.id,command([{name:'另一个名',rowToken:token,aliasRecordId:qa.id,version:recordVersion(qa)}],[qa]))).rejects.toThrow(/标识已使用/);expect(await snapshot()).toEqual(before);
  await expect(s.resources.saveForm(boss,'finance-products',{requestKey:randomUUID(),values:{archiveType:'raw',name:'伪造新建',rawFinishedNames:'原名',[SOURCE_FINISHED_NAMES_COMMAND]:command([{name:'原名',rowToken:randomUUID(),aliasRecordId:a.id,version:recordVersion(a)}],[a])},collections:[]})).rejects.toThrow(/身份|新增|复制/);
 });
 it('旧父版本与并发同一身份只有一次成功，失败不留partial aliases',async()=>{
  const p=await raw(),a=(await aliases(p.id))[0],token=randomUUID(),version=p.version!;const cmd=command([{name:'并发改名',rowToken:token,aliasRecordId:a.id,version:recordVersion(a)}],[a]);const results=await Promise.allSettled([save(p.id,structuredClone(cmd),{version}),save(p.id,structuredClone(cmd),{version})]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);const rows=await aliases(p.id);expect(rows).toHaveLength(1);expect(rows[0].id).toBe(a.id);
  const current=await s.resources.get(boss,'finance-products',p.id),before=await snapshot();const fresh=rows[0],newToken=randomUUID();const conflict=sourceFinishedNameCode(boss.companyId,p.id,newToken);await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:boss.companyId,type:'finance-base-codes',title:'合成码冲突',status:'pending',uniqueKey:conflict.toLowerCase(),data:{code:conflict},createdBy:boss.id,updatedBy:boss.id}));const baseline=await snapshot();await expect(save(p.id,command([{name:'保留名',rowToken:token,aliasRecordId:fresh.id,version:recordVersion(fresh)},{name:'冲突新名',rowToken:newToken}],rows),{version:current.version})).rejects.toThrow();expect(await snapshot()).toEqual(baseline);expect(before.records.length+1).toBe(baseline.records.length);
 });
 it('名称互换按稳定ID而非name-key保留；改名占用被删行名字不残留重复alias',async()=>{
  const p=await raw('甲名\n乙名'),before=await aliases(p.id),[a,b]=before;
  await save(p.id,command([{name:'乙名',rowToken:randomUUID(),aliasRecordId:a.id,version:recordVersion(a)},{name:'甲名',rowToken:randomUUID(),aliasRecordId:b.id,version:recordVersion(b)}],before));let after=await aliases(p.id);expect(after.map(r=>r.id)).toEqual(before.map(r=>r.id));expect(after[0].data.code).toBe(a.data.code);expect(after[1].data.code).toBe(b.data.code);expect(after[0].data.aliasKey).toBe(aliasCode(boss.companyId,p.id,'乙名'));
  const keep=after[1];await save(p.id,command([{name:'乙名',rowToken:String(keep.data.sourceFinishedRowToken),aliasRecordId:keep.id,version:recordVersion(keep)}],after));after=await aliases(p.id);expect(after).toHaveLength(1);expect(after[0].id).toBe(keep.id);expect(after[0].data.code).toBe(b.data.code);
 });
 it('100行删1增1先沿原依赖guard删除，仍保持100而非被旧计数误拒',async()=>{
  const p=await raw(''),roots=await ds.manager.createQueryBuilder(ResourceRecord,'r').where('r.companyId=:company AND r.type=:type',{company:boss.companyId,type:'finance-base-codes'}).andWhere("JSON_EXTRACT(r.data,'$.productId')=:pid",{pid:p.id}).getMany(),root=roots.find(r=>!r.data.canonicalId)!;const names=Array.from({length:100},(_,i)=>'合成百名'+i);
  const record=await ds.manager.findOneByOrFail(ResourceRecord,{id:p.id});record.data.rawFinishedNames=names.join('\n');await ds.manager.save(record);
  await ds.manager.save(ResourceRecord,names.map(name=>ds.manager.create(ResourceRecord,{companyId:boss.companyId,type:'finance-base-codes',title:name,status:'pending',uniqueKey:aliasCode(boss.companyId,p.id,name).toLowerCase(),data:{productId:p.id,canonicalId:root.id,name,code:aliasCode(boss.companyId,p.id,name),aliasKey:aliasCode(boss.companyId,p.id,name)},createdBy:boss.id,updatedBy:boss.id})));const all=await aliases(p.id),token=randomUUID();
  await save(p.id,command([...all.slice(1).map((r,i)=>({name:names[i+1],rowToken:randomUUID(),aliasRecordId:r.id,version:recordVersion(r)})),{name:'新增第一百名',rowToken:token}],all));const after=await aliases(p.id);expect(after).toHaveLength(100);expect(after.some(r=>r.id===all[0].id)).toBe(false);expect(after.find(r=>r.data.sourceFinishedRowToken===token)?.data.code).toBe(sourceFinishedNameCode(boss.companyId,p.id,token));
 });
 it('真实HTTP source-form成功保身份；畸形token/跨公司字段/原始token注入/低权限均不落地',async()=>{
  const module=await Test.createTestingModule({controllers:[ResourcesController],providers:[{provide:ResourcesService,useValue:s.resources},{provide:GridSaveService,useValue:{}},{provide:DataToolsService,useValue:{}}]}).compile();app=module.createNestApplication();app.use((req:{headers:Record<string,string>;user?:AuthUser},_res:unknown,next:()=>void)=>{req.user=req.headers['x-test-role']==='viewer'?viewer:boss;next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');url=await app.getUrl();
  const p=await raw(),a=(await aliases(p.id))[0],row={name:'HTTP改名',rowToken:randomUUID(),aliasRecordId:a.id,version:recordVersion(a)},base={id:p.id,version:p.version,values:{rawFinishedNames:row.name,[SOURCE_FINISHED_NAMES_COMMAND]:command([row],[a])},collections:[]};
  const post=(body:unknown,headers:Record<string,string>={})=>fetch(`${url}/resources/finance-products/save-form`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  for(const body of [{...base,requestKey:randomUUID(),companyId:other.companyId},{...base,requestKey:randomUUID(),values:{...base.values,[SOURCE_FINISHED_NAMES_COMMAND]:{...base.values[SOURCE_FINISHED_NAMES_COMMAND],rows:[{...row,rowToken:'not-uuid'}]}}},{...base,requestKey:randomUUID(),values:{...base.values,[SOURCE_FINISHED_NAMES_COMMAND]:{...base.values[SOURCE_FINISHED_NAMES_COMMAND],companyId:other.companyId}}}]){const before=await snapshot();expect((await post(body)).status).toBe(400);expect(await snapshot()).toEqual(before);}
  const before=await snapshot();expect((await post({...base,requestKey:randomUUID()},{'x-test-role':'viewer'})).status).toBe(403);expect(await snapshot()).toEqual(before);
  const response=await post({...base,requestKey:randomUUID()});expect(response.status).toBe(201);const saved=await response.json() as {data:Record<string,unknown>};expect(saved.data.__finishedNameDetails).toEqual([expect.objectContaining({name:row.name,aliasRecordId:a.id,code:a.data.code,rowToken:row.rowToken})]);
  const after=await snapshot();const forged=await fetch(`${url}/resources/finance-base-codes/${a.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({values:{sourceFinishedRowToken:randomUUID()}})});expect(forged.status).toBe(400);expect(await snapshot()).toEqual(after);
 });
 it('普通PATCH/import式字段不能注入trusted command/token，原普通改名守卫保持',async()=>{
  const p=await raw(),before=await snapshot();await expect(s.resources.update(boss,'finance-products',p.id,{[SOURCE_FINISHED_NAMES_COMMAND]:{version:1,rows:[],expected:[]}})).rejects.toThrow();expect(await snapshot()).toEqual(before);
  const a=(await aliases(p.id))[0];await expect(s.resources.create(boss,'finance-base-codes',{productId:p.id,canonicalId:a.data.canonicalId,code:sourceFinishedNameCode(boss.companyId,p.id,randomUUID()),name:'伪造稳定码'})).rejects.toThrow(/马甲|手工|新增/);
 });
});
