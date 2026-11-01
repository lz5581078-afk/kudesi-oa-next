import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { getResourceDef,permissionOwner } from '@kudesi/shared';
import { Company,ResourceRecord,User } from '../entities';
import { buildDataSourceOptions } from '../database/data-source';
import { buildServices } from '../test-support';
import { PermissionsGuard } from '../common/permissions.guard';
import { RESOURCE_ACTION } from '../common/auth.decorators';
import type { AuthUser } from '../common/auth.decorators';
import type { LegacyArchive,LegacyRecord } from './protocol';
import { importPhoneRegistrations } from './phone-registration-import';
import { runLegacyImport } from './runner';
const TYPE='phone-registration-history',suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('重复号码的原登记（MySQL）',()=>{
  let ds:DataSource,svc:ReturnType<typeof buildServices>,actor:AuthUser,parentId:number,number:string;
  const raw=(id:number)=>({id,company_id:3,number,status:'normal',phone_owner_name:id===1?'原认证甲':'原认证乙',package_name:id===1?'旧套餐甲':'旧套餐乙',external_user_name:id===1?'原外部甲':'原外部乙',phone_device_type:'原手机',has_forwarding_app:0,forwarding_app_name:id===1?'原程序甲':'原程序乙',remark:id===1?' 原备注甲\n':'原备注乙',recharge_day:id===1?'10':'20',fee_cycle:id===1?'30':'90',monthly_fee:'10.00'});
  const original=(id:number)=>({raw:raw(id),record:{id:String(id),type:'phones',status:'normal',data:{number,usageType:'company_kept',certifiedName:raw(id).phone_owner_name,plan:raw(id).package_name,forwardApp:'no'}} as LegacyRecord,data:{number,usageType:'company_kept',certifiedName:raw(id).phone_owner_name,plan:raw(id).package_name,forwardApp:'no'}});
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();svc=buildServices(ds);
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'号码登记',status:'active'}));
    const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,name:'管理员',account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:true,mustChangePassword:false}));
    actor={id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};number='138'+String(Number.parseInt(randomBytes(4).toString('hex'),16)).padStart(10,'0').slice(-8);
    parentId=(await svc.resources.create(actor,'phones',{number,usageType:'company_kept',note:'主档案人工备注'})).id;
  });
  afterAll(async()=>{await ds?.destroy();});
  const run=(rows:ReturnType<typeof original>[])=>ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;return importPhoneRegistrations({em,resources:svc.resources,user:actor,sourceCompanyId:3,parentId},rows);});
  it('隐藏字段差异、原费用周期及备注空白分别可读；没有伪造来源时间或改变主档案',async()=>{
    const first=await run([original(1),original(2)]);expect(first.every(r=>!r.reused)).toBe(true);
    expect((await run([original(1),original(2)])).every(r=>r.reused)).toBe(true);
    const views=await Promise.all(first.map(r=>svc.resources.get(actor,TYPE,r.id)));
    expect(views.map(r=>[r.data.certifiedName,r.data.externalUser,r.data.forwardAppName,r.data.rechargeDay,r.data.feeCycle,r.data.originalRemark])).toEqual([['原认证甲','原外部甲','原程序甲','10','30',' 原备注甲\n'],['原认证乙','原外部乙','原程序乙','20','90','原备注乙']]);
    expect(views.every(v=>!('_legacySourceHash' in v.data))).toBe(true);expect(getResourceDef(TYPE)!.fields.some(f=>/time|At$/.test(f.key))).toBe(false);
    expect((await svc.resources.get(actor,'phones',parentId)).data.note).toBe('主档案人工备注');
  });
  it('未核对原字段、被忽略的密钥差异、跨公司及已迁来源变化全部拒绝，不覆盖原登记',async()=>{
    const cases=[()=>{const b=original(2);b.raw.monthly_fee='11.00';return b;},()=>{const b=original(2);(b.data as Record<string,unknown>).password='different-fixture';return b;},()=>{const b=original(2);b.raw.company_id=4;return b;},()=>{const b=original(2);b.raw.remark='后来修改';return b;}];
    for(const bad of cases)await expect(run([original(1),bad()])).rejects.toThrow('旧号码登记');
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:actor.companyId,type:TYPE}})).toBe(2);
  });
  it('继承号码权限，管理员也不能修改只读登记，其他公司不能读取',async()=>{
    expect(permissionOwner(TYPE)).toBe('phones');expect(getResourceDef('phones')!.children).toContain(TYPE);
    const guard=new PermissionsGuard(new Reflector());const req=(action:string,user:AuthUser)=>{const handler=()=>{};Reflect.defineMetadata(RESOURCE_ACTION,action,handler);return {getHandler:()=>handler,getClass:()=>class C{},switchToHttp:()=>({getRequest:()=>({params:{type:TYPE},user})})} as unknown as ExecutionContext;};
    expect(guard.canActivate(req('view',{...actor,permissions:{isCompanyAdmin:false,allow:['resource.phones.view'],deny:[]}}))).toBe(true);
    expect(()=>guard.canActivate(req('view',{...actor,permissions:{isCompanyAdmin:false,allow:[],deny:[]}}))).toThrow('没有权限');
    for(const action of ['create','edit','delete','disable'])expect(()=>guard.canActivate(req(action,actor))).toThrow('只读');
    const row=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:actor.companyId,type:TYPE});
    await expect(svc.resources.update(actor,TYPE,row.id,{plan:'改套餐'})).rejects.toThrow('只读');
    await expect(svc.resources.get({...actor,companyId:actor.companyId+99999},TYPE,row.id)).rejects.toThrow('不存在');
  });
  it('整批只消除已经逐份保留的差异说明；未知原字段仍导致整批拒绝',async()=>{
    const records=[original(10),original(11)];const archive:LegacyArchive={company:{id:3,name:'号码登记'},departments:[],positions:[],employees:[],employeePositions:[],positionPermissions:[],exclusions:[],loadFile:async()=>Buffer.alloc(0),records:records.map(r=>({...r.record,data:{...r.data,number:'139'+number.slice(3)}})),sourceRows:records.map(r=>({table:'phone_numbers',key:r.record.id,row:{...r.raw,number:'139'+number.slice(3)}}))};
    const opts={companyId:actor.companyId,actorId:actor.id,expectedName:archive.company.name,sourceRowsCrypto:svc.crypto,preserveLegacyStates:true};
    const dry=await runLegacyImport(ds,svc.resources,svc.files,archive,{...opts,apply:false});expect(dry.failures).toEqual([]);expect(dry.verified?.['phone-registration-history-view']).toBe(2);expect(dry.excluded.filter(e=>e.type.startsWith('phones.duplicate.'))).toEqual([]);
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:actor.companyId,type:TYPE}})).toBe(2);
    archive.sourceRows![1].row.monthly_fee='12.00';
    const bad=await runLegacyImport(ds,svc.resources,svc.files,archive,{...opts,apply:false});expect(bad.failures.some(e=>e.type===TYPE)).toBe(true);
    await expect(runLegacyImport(ds,svc.resources,svc.files,archive,{...opts,apply:true,expectedReport:bad})).rejects.toThrow('仍有失败');
  });
});
