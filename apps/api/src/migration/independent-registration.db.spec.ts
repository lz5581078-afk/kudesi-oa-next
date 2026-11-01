import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company,User,ResourceRecord } from '../entities';
import { buildServices } from '../test-support';
import type { AuthUser } from '../common/auth.decorators';
import type { LegacyArchive } from './protocol';
import { runLegacyImport } from './runner';
import { verifyPhoneRechargeView } from './phone-recharge-view';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('同号旧登记分别续用（MySQL）',()=>{
  let ds:DataSource,svc:ReturnType<typeof buildServices>,actor:AuthUser,archive:LegacyArchive,bankIds:number[],phoneIds:number[];
  const accountNo='6222000088887777',number='13800138009';
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();svc=buildServices(ds);
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'独立原登记',status:'active'}));
    const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,name:'管理员',account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:true,mustChangePassword:false}));
    actor={id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    const banks=[1,2].map(id=>({id,company_id:3,account_no:accountNo,account_scope:'company',account_kind:'company_card',keeper_employee_id:null,phone_number_id:id===1?11:12,reconciliation_cycle:id===1?'monthly':'quarterly',current_balance:'0.00',created_at:'2026-08-01 10:00:00',status:'normal'}));
    const phones=[11,12].map(id=>({id,company_id:3,number,status:'normal',phone_owner_name:'认证人'+id,package_name:'套餐'+id,has_forwarding_app:0,last_recharge_at:id===11?null:'2026-10-01',next_recharge_at:id===11?'2026-12-31':'2026-12-12',recharge_cycle:id===11?null:'90'}));
    archive={company:{id:3,name:c.name},departments:[],positions:[],employees:[],employeePositions:[],positionPermissions:[],exclusions:[],loadFile:async()=>Buffer.alloc(0),sourceRows:[...banks.map(row=>({table:'bank_accounts',key:String(row.id),row})),...phones.map(row=>({table:'phone_numbers',key:String(row.id),row}))],records:[...phones.map(row=>({type:'phones',id:String(row.id),status:'normal',data:{number,usageType:'company_kept',certifiedName:row.phone_owner_name,plan:row.package_name,lastRechargeAt:row.last_recharge_at,nextRechargeAt:row.next_recharge_at,rechargeCycleDays:row.recharge_cycle==null?null:Number(row.recharge_cycle)}})),...banks.map(row=>({type:'bank-accounts',id:String(row.id),status:'normal',data:{accountNo,accountName:'原户名',bank:'原银行',kind:row.account_kind,reconcileCycle:row.reconciliation_cycle,balance:0,phoneId:{legacyRef:{type:'phones',id:row.id===1?'11':'12'}},reservedPhoneNumber:number}}))]};
  });
  afterAll(async()=>{await ds?.destroy();});
  const options=()=>({companyId:actor.companyId,actorId:actor.id,expectedName:archive.company.name,preserveLegacyStates:true,sourceRowsCrypto:svc.crypto});
  it('逐条建档、各自关联；完整试跑回滚，核对后可提交和幂等复用',async()=>{
    const dry=await runLegacyImport(ds,svc.resources,svc.files,archive,{...options(),apply:false});expect(dry.failures).toEqual([]);expect(dry.excluded).toEqual([]);
    expect(dry.verified?.['phone-recharge-view']).toBe(2);expect(dry.created['bank-accounts']).toBe(2);expect(dry.created.phones).toBe(2);expect(await ds.manager.count(ResourceRecord,{where:{companyId:actor.companyId}})).toBe(0);
    const applied=await runLegacyImport(ds,svc.resources,svc.files,archive,{...options(),apply:true,expectedReport:dry});
    const ids=(type:string)=>applied.mappings.filter(m=>m.type===type).map(m=>m.targetId);bankIds=ids('bank-accounts');phoneIds=ids('phones');
    expect(new Set(bankIds).size).toBe(2);expect(new Set(phoneIds).size).toBe(2);
    const banks=await Promise.all(bankIds.map(id=>svc.resources.get(actor,'bank-accounts',id)));
    expect(banks.map(v=>v.data.reconcileCycle)).toEqual(['monthly','quarterly']);expect(banks.map(v=>v.data.phoneId)).toEqual(phoneIds);
    const again=await runLegacyImport(ds,svc.resources,svc.files,archive,{...options(),apply:true});expect(again.failures).toEqual([]);expect(again.reused['bank-accounts']).toBe(2);expect(again.reused.phones).toBe(2);
    expect(JSON.stringify(await ds.manager.find(ResourceRecord,{where:{companyId:actor.companyId,type:'bank-accounts'}}))).not.toContain(accountNo);
  });
  it('编辑原号码、套餐或对账周期不被同号阻塞；另一条登记和原绑定保持独立',async()=>{
    await svc.resources.update(actor,'phones',phoneIds[1],{number,plan:'更新第二条套餐'});
    await svc.resources.update(actor,'bank-accounts',bankIds[1],{accountNo,reconcileCycle:'yearly'});
    expect((await svc.resources.get(actor,'phones',phoneIds[0])).data.plan).toBe('套餐11');
    expect((await svc.resources.get(actor,'phones',phoneIds[1])).data.plan).toBe('更新第二条套餐');
    expect((await svc.resources.get(actor,'phones',phoneIds[0])).data.nextRechargeAt).toBe('2026-12-31');
    expect((await svc.resources.get(actor,'phones',phoneIds[1])).data.nextRechargeAt).toBe('2026-12-12');
    expect((await svc.resources.get(actor,'phones',phoneIds[0])).data.rechargeCycleDays).toBeUndefined();
    expect((await svc.resources.get(actor,'bank-accounts',bankIds[0])).data.reconcileCycle).toBe('monthly');
    expect((await svc.resources.get(actor,'bank-accounts',bankIds[1])).data.phoneId).toBe(phoneIds[1]);
  });
  it('新建重复仍拒绝；只给号码不猜首条，明确同公司登记可精确选择',async()=>{
    await expect(svc.resources.create(actor,'phones',{number,usageType:'company_kept'})).rejects.toThrow('已存在登记');
    await expect(svc.resources.create(actor,'bank-accounts',{kind:'company_card',accountName:'新户名',bank:'新银行',accountNo})).rejects.toThrow('已存在登记');
    await expect(svc.resources.findByUnique(ds.manager,actor.companyId,'phones',number)).rejects.toThrow('多份原登记');
    expect((await svc.resources.findByUnique(ds.manager,actor.companyId,'phones',number,phoneIds[1]))?.id).toBe(phoneIds[1]);
    expect(await svc.resources.findByUnique(ds.manager,actor.companyId+99999,'phones',number,phoneIds[1])).toBeNull();
  });
  it('改成新号码恢复普通查重；另一条原登记不会失去查重约束',async()=>{
    await svc.resources.update(actor,'phones',phoneIds[1],{number:'13800138010'});
    await expect(svc.resources.create(actor,'phones',{number,usageType:'company_kept'})).rejects.toThrow('已存在登记');
    expect((await svc.resources.findByUnique(ds.manager,actor.companyId,'phones',number))?.id).toBe(phoneIds[0]);
    await expect(svc.resources.update(actor,'phones',phoneIds[1],{number})).rejects.toThrow('已存在登记');
  });
  it('普通办理改变充值依据才自动推算；手工下次日期与原空值可准确保留',async()=>{
    await svc.resources.update(actor,'phones',phoneIds[1],{lastRechargeAt:'2026-11-01',rechargeCycleDays:30});
    expect((await svc.resources.get(actor,'phones',phoneIds[1])).data.nextRechargeAt).toBe('2026-12-01');
    await svc.resources.update(actor,'phones',phoneIds[1],{lastRechargeAt:'2026-11-02',nextRechargeAt:'2027-02-01'});
    expect((await svc.resources.get(actor,'phones',phoneIds[1])).data.nextRechargeAt).toBe('2027-02-01');
    await svc.resources.update(actor,'phones',phoneIds[1],{lastRechargeAt:null});
    expect((await svc.resources.get(actor,'phones',phoneIds[1])).data.nextRechargeAt).toBeUndefined();
    await svc.resources.update(actor,'phones',phoneIds[1],{nextRechargeAt:'2027-03-01'});
    await svc.resources.update(actor,'phones',phoneIds[1],{plan:'无关套餐编辑'});
    expect((await svc.resources.get(actor,'phones',phoneIds[1])).data.nextRechargeAt).toBe('2027-03-01');
    await expect(svc.resources.update(actor,'phones',phoneIds[1],{rechargeCycleDays:0})).rejects.toThrow('充值周期');
  });
  it('充值核对读取真实原生页面；原空周期不补30，错写日期即使导入对象正确也拒绝',async()=>{
    const record=archive.records.find(r=>r.type==='phones'&&r.id==='11')!,raw=archive.sourceRows!.find(r=>r.table==='phone_numbers'&&r.key==='11')!.row;
    await expect(ds.transaction(async em=>{await em.query("UPDATE resource_records SET data=JSON_SET(data,'$.nextRechargeAt','2028-01-01') WHERE company_id=? AND id=?",[actor.companyId,phoneIds[0]]);return verifyPhoneRechargeView({em,resources:svc.resources,user:actor,sourceCompanyId:3,parentId:phoneIds[0]},record,raw);})).rejects.toThrow('充值日期');
    expect((await svc.resources.get(actor,'phones',phoneIds[0])).data.nextRechargeAt).toBe('2026-12-31');
    for(const recharge_cycle of ['unknown-cycle','0','3651','90'])await expect(verifyPhoneRechargeView({em:ds.manager,resources:svc.resources,user:actor,sourceCompanyId:3,parentId:phoneIds[0]},record,{...raw,recharge_cycle})).rejects.toThrow('充值日期');
    await expect(verifyPhoneRechargeView({em:ds.manager,resources:svc.resources,user:actor,sourceCompanyId:3,parentId:phoneIds[0]},{...record,data:{...record.data,rechargeCycleDays:30}},raw)).rejects.toThrow('充值日期');
  });
  it('伪造客户端标记、受控事务外调用、篡改原始证明与跨公司来源均不能获得例外',async()=>{
    await expect(svc.resources.create(actor,'phones',{number,usageType:'company_kept',_legacyRegistration:{sourceId:'11'}})).rejects.toThrow('已存在登记');
    await expect(svc.resources.importRecord(ds.manager,actor,'phones',{number,usageType:'company_kept'},'normal',{sourceCompanyId:3,sourceId:'11'})).rejects.toThrow('受控迁移');
    await expect(ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;return svc.resources.importRecord(em,actor,'phones',{number,usageType:'company_kept'},'normal',{sourceCompanyId:4,sourceId:'11'});})).rejects.toThrow('核对失败');
    await expect(ds.transaction(async em=>{await em.query("UPDATE legacy_source_rows SET source_hash=? WHERE company_id=? AND source_table='phone_numbers' AND source_key='11'",['0'.repeat(64),actor.companyId]);return svc.resources.updateRecord(em,actor,'phones',phoneIds[0],{plan:'不能写入'});})).rejects.toThrow();
    expect((await svc.resources.get(actor,'phones',phoneIds[0])).data.plan).toBe('套餐11');
  });
});
