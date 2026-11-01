import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { getResourceDef,permissionOwner } from '@kudesi/shared';
import { buildDataSourceOptions } from '../database/data-source';
import { Company,User,ResourceRecord } from '../entities';
import { buildServices } from '../test-support';
import { PermissionsGuard } from '../common/permissions.guard';
import { RESOURCE_ACTION,type AuthUser } from '../common/auth.decorators';
import { importBankRegistration } from './bank-registration-import';
import { runLegacyImport } from './runner';
import type { LegacyArchive } from './protocol';

const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('重复银行账户原登记保留（MySQL）',()=>{
  let ds:DataSource,svc:ReturnType<typeof buildServices>,actor:AuthUser,first:User,second:User,parentId:number;
  const TYPE='bank-account-history',accountNo='6222000011112222';
  const raw=(id:number,kind='company_public',keeper=10,cycle='monthly')=>({id,company_id:3,account_scope:kind==='store_public'?'store':'company',account_kind:kind,keeper_employee_id:keeper,reconciliation_cycle:cycle,current_balance:'12.00',created_at:'2026-08-01 10:00:00',status:'normal'});
  const data=(kind='company_public',keeper?:number,cycle='monthly')=>({kind,accountName:'同一户名',bank:'测试银行',accountNo,keeperUserId:keeper??first.id,reconcileCycle:cycle,balance:1200,note:'原登记说明'});
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();svc=buildServices(ds);
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'银行登记',status:'active'}));
    const person=async(name:string)=>ds.manager.save(User,ds.manager.create(User,{companyId:c.id,name,account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:false,mustChangePassword:false}));
    first=await person('第一保管人');second=await person('第二保管人');
    const admin=await person('管理员');await ds.manager.update(User,{id:admin.id},{isCompanyAdmin:true});actor={id:admin.id,companyId:c.id,name:admin.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    parentId=(await svc.resources.create(actor,'bank-accounts',{...data(),note:'主资料人工说明'})).id;
  });
  afterAll(async()=>{await ds?.destroy();});
  const context=(em:DataSource['manager'])=>({em,resources:svc.resources,crypto:svc.crypto,user:actor,sourceCompanyId:3,parentId,lookup:(type:string,id:unknown)=>type==='user'?String(id)==='10'?first.id:String(id)==='20'?second.id:undefined:undefined});
  it('同号两份登记的类型、保管人和对账周期分别保留；原余额只作快照，不重复计入现金银行',async()=>{
    await ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;
      expect((await importBankRegistration(context(em),'1',raw(1),data(),false)).reused).toBe(false);
      expect((await importBankRegistration(context(em),'2',raw(2,'store_public',20,'quarterly'),data('store_public',second.id,'quarterly'),false)).reused).toBe(false);
      expect((await importBankRegistration(context(em),'2',raw(2,'store_public',20,'quarterly'),data('store_public',second.id,'quarterly'),false)).reused).toBe(true);
    });
    const records=await ds.manager.find(ResourceRecord,{where:{companyId:actor.companyId,type:TYPE},order:{id:'ASC'}});expect(records).toHaveLength(2);
    const details=await Promise.all(records.map(r=>svc.resources.get(actor,TYPE,r.id)));
    expect(details.map(r=>[r.data.kind,r.refLabels.keeperUserId,r.data.reconcileCycle,r.data.originalBalance])).toEqual([['company_public','第一保管人','monthly',1200],['store_public','第二保管人','quarterly',1200]]);
    expect(details.every(r=>r.data.accountNo===accountNo&&!('_legacySourceHash' in r.data))).toBe(true);
    expect(JSON.stringify(records)).not.toContain(accountNo);
    const parent=await svc.resources.get(actor,'bank-accounts',parentId);expect(parent.data.currentBalance).toBe(1200);expect(parent.data.note).toBe('主资料人工说明');expect(parent.data.kind).toBe('company_public');
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:actor.companyId,type:'bank-accounts'}})).toBe(1);
    expect(Number((await ds.query('SELECT COUNT(*) n FROM finance_documents WHERE company_id=?',[actor.companyId]))[0].n)).toBe(0);
  });
  it('继承账户查看权限，管理员也不能通过公开动作改、删或新建历史；跨公司不能读取',async()=>{
    expect(permissionOwner(TYPE)).toBe('bank-accounts');expect(getResourceDef('bank-accounts')!.children).toContain(TYPE);
    const guard=new PermissionsGuard(new Reflector());
    const request=(action:string,user:AuthUser)=>{const handler=()=>{};Reflect.defineMetadata(RESOURCE_ACTION,action,handler);return {getHandler:()=>handler,getClass:()=>class Controller{},switchToHttp:()=>({getRequest:()=>({params:{type:TYPE},user})})} as unknown as ExecutionContext;};
    expect(guard.canActivate(request('view',{...actor,permissions:{isCompanyAdmin:false,allow:['resource.bank-accounts.view'],deny:[]}}))).toBe(true);
    expect(()=>guard.canActivate(request('view',{...actor,permissions:{isCompanyAdmin:false,allow:[],deny:[]}}))).toThrow('没有权限');
    for(const action of ['create','edit','delete','disable'])expect(()=>guard.canActivate(request(action,actor))).toThrow('只读');
    const row=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:actor.companyId,type:TYPE});
    await expect(svc.resources.update(actor,TYPE,row.id,{reconcileCycle:'yearly'})).rejects.toThrow('只读');
    await expect(svc.resources.remove(actor,TYPE,row.id,'测试删除')).rejects.toThrow('只读');
    await expect(svc.resources.get({...actor,companyId:actor.companyId+99999},TYPE,row.id)).rejects.toThrow('不存在');
  });
  it('原人员关联、余额冲突、未知字段及未核对附件阻止写入，来源变化不覆盖已迁登记',async()=>{
    const badCases=[{source:{...raw(99),current_balance:'13.00'},values:{...data(),balance:1300},files:false},{source:raw(99),values:{...data(),keeperUserId:second.id},files:false},{source:raw(99),values:{...data(),unknown:'lost-field'},files:false},{source:raw(99),values:data(),files:true}];
    for(const bad of badCases)await expect(ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;return importBankRegistration(context(em),'99',bad.source,bad.values,bad.files);})).rejects.toThrow('旧银行登记');
    await expect(ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;return importBankRegistration(context(em),'1',{...raw(1),status:'abnormal'},data(),false);})).rejects.toThrow('来源');
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:actor.companyId,type:TYPE}})).toBe(2);
  });
  it('完整导入只消除已通过原登记验收的差异说明，其他未验收差异仍阻止正式提交',async()=>{
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'原登记整批演练',status:'active'}));
    const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,name:'管理员',account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:true,mustChangePassword:false}));
    const originals=[101,102,103].map(id=>({...raw(id,id===102?'store_public':'company_public',10,id===102?'quarterly':'monthly'),company_id:9,keeper_employee_id:null,current_balance:'0.00'}));
    const archive:LegacyArchive={company:{id:9,name:c.name},departments:[],positions:[],employees:[],employeePositions:[],positionPermissions:[],exclusions:[],loadFile:async()=>Buffer.alloc(0),sourceRows:originals.map(r=>({table:'bank_accounts',key:String(r.id),row:r})),records:originals.map(r=>({id:String(r.id),type:'bank-accounts',status:'normal',data:{kind:r.account_kind,accountName:'整批同号户名',bank:'测试银行',accountNo,balance:0,reconcileCycle:r.reconciliation_cycle,note:r.id===103?'尚待验收的另一说明':'首条说明'}}))};
    const opts={companyId:c.id,actorId:u.id,expectedName:c.name,preserveLegacyStates:true,sourceRowsCrypto:svc.crypto};
    const report=await runLegacyImport(ds,svc.resources,svc.files,archive,{...opts,apply:false});
    expect(report.failures).toEqual([]);expect(report.created[TYPE]).toBe(3);expect(report.verified?.['bank-account-history-view']).toBe(3);
    expect(report.excluded.map(e=>[e.type,e.id])).toEqual([['bank-accounts.duplicate.note','103']]);
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:c.id}})).toBe(0);
    await expect(runLegacyImport(ds,svc.resources,svc.files,archive,{...opts,apply:true,expectedReport:report})).rejects.toThrow('未验收');
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:c.id}})).toBe(0);
  });
});
