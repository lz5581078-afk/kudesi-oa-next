import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company,User,ResourceRecord,IntegrationSetting,PlatformAdmin } from '../entities';
import { buildServices } from '../test-support';
import type { LegacyArchive } from './protocol';
import { runCutover,prepareCutoverSequences,type CompanyPlan } from './cutover';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('全部公司统一清理/导入/核对/提交（独立MySQL库）',()=>{
  let ds:DataSource,admin:DataSource,svc:ReturnType<typeof buildServices>,sources:LegacyArchive[],plans:CompanyPlan[],oldUserId:number,configEnc:string,db:string;
  beforeAll(async()=>{
    admin=await new DataSource(buildDataSourceOptions()).initialize();db='kudesi_cutover_'+randomBytes(6).toString('hex');await admin.query('CREATE DATABASE `'+db+'` CHARACTER SET utf8mb4');
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:db}),migrationsRun:true}).initialize();svc=buildServices(ds);
    const company=await ds.manager.save(Company,ds.manager.create(Company,{id:1,code:'existing',name:'原甲公司',status:'active'}));
    const old=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:'source-boss-1',name:'旧人工资料',passwordHash:'!no-login',status:'active',isCompanyAdmin:true,mustChangePassword:false}));oldUserId=old.id;
    await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:1,type:'locations',title:'清理前原资料',status:'active',data:{name:'清理前原资料'}}));
    configEnc=svc.crypto.encrypt(JSON.stringify({apiKey:'isolated-never-log-key',allEmployees:true,maxConcurrent:2000}));
    await ds.manager.save(IntegrationSetting,ds.manager.create(IntegrationSetting,{companyId:1,settingKey:'collector-speech',configEnc,updatedBy:old.id}));
    await ds.manager.save(PlatformAdmin,ds.manager.create(PlatformAdmin,{account:'platform-admin-cutover',name:'平台',passwordHash:'!no-login',status:'active'}));
    sources=[1,3].map((id,index)=>({company:{id,name:index?'原乙公司':'原甲公司'},departments:[{id:1,name:'原部门',status:'active'}],positions:[{id:1,department_id:1,name:'原岗位',level:'staff',status:'active',workspace_template_key:'general'}],employees:[{id:10,name:'原管理员',department_id:1,role_key:'boss',status:'active',login_account:'source-boss-'+id,password_salt:'ab'.repeat(16),password_hash:'cd'.repeat(64)},{id:11,name:'原员工',department_id:1,role_key:'staff',status:'active',login_account:null,manager_id:10}],employeePositions:[{employee_id:10,position_id:1,status:'active',is_primary:1},{employee_id:11,position_id:1,status:'active',is_primary:1}],positionPermissions:[],records:[],exclusions:[{type:'source-table.unmapped',id:'deferred_fixture',reason:'用户选择保留旧站后补的历史'}],loadFile:async()=>Buffer.alloc(0)}));
    plans=sources.map((s,i)=>({sourceCompanyId:s.company.id,companyId:i+1,actorId:1000000+i*100000,name:s.company.name}));
  });
  afterAll(async()=>{await ds?.destroy();if(admin){await admin.query('DROP DATABASE `'+db+'`');await admin.destroy();}});
  const opts=()=>({apply:false,plans,softwareFingerprint:'a'.repeat(64),backupDigest:'b'.repeat(64)});
  const run=(extra:Partial<Parameters<typeof runCutover>[5]>={})=>runCutover(ds,svc.resources,svc.files,svc.crypto,sources,{...opts(),...extra});
  it('第二家公司失败时恢复第一家公司及清理前数据，原管理员引导不增加虚假员工',async()=>{
    await prepareCutoverSequences(ds,1000000);sources[1].employees[1].name='x'.repeat(60);
    await expect(run()).rejects.toThrow('员工姓名');sources[1].employees[1].name='原员工';
    expect(await ds.manager.count(User)).toBe(1);expect((await ds.manager.findOneByOrFail(User,{id:oldUserId})).name).toBe('旧人工资料');
    expect(await ds.manager.count(ResourceRecord)).toBe(1);expect(await ds.manager.count(Company)).toBe(1);
    expect(Number((await ds.query('SELECT COUNT(*) n FROM legacy_import_links'))[0].n)).toBe(0);
  });
  it('统一回滚报告不能放行变化的来源；核对后同一事务提交两家，配置密文保持且人员引用重映射',async()=>{
    await prepareCutoverSequences(ds,1000000);const dry=await run();expect(dry.phase).toBe('dry-run-rollback');expect(dry.reports).toHaveLength(2);expect(dry.counts.users).toBe(4);
    expect(await ds.manager.count(User)).toBe(1);expect(await ds.manager.count(ResourceRecord)).toBe(1);
    sources[1].exclusions[0].reason='不同处置范围';await prepareCutoverSequences(ds,1000000);await expect(run({apply:true,expected:dry})).rejects.toThrow('核对试迁不一致');sources[1].exclusions[0].reason='用户选择保留旧站后补的历史';
    await prepareCutoverSequences(ds,1000000);const actual=await run({apply:true,expected:dry});expect(actual.phase).toMatch(/^committed/);
    expect(await ds.manager.count(User)).toBe(4);expect(await ds.manager.count(Company)).toBe(2);expect(await ds.manager.count(ResourceRecord)).toBe(0);
    const boss=await ds.manager.findOneByOrFail(User,{id:plans[0].actorId});expect(boss.account).toBe('source-boss-1');expect(boss.departmentId).toBeGreaterThanOrEqual(1000000);expect(boss.positionId).toBeGreaterThanOrEqual(1000000);
    const config=await ds.manager.findOneByOrFail(IntegrationSetting,{companyId:1});expect(config.configEnc).toBe(configEnc);expect(config.updatedBy).toBe(boss.id);
    expect(await ds.manager.count(PlatformAdmin)).toBe(1);expect(Number((await ds.query('SELECT COUNT(*) n FROM outbox_jobs'))[0].n)).toBe(0);expect(Number((await ds.query('SELECT COUNT(*) n FROM outbox_switches WHERE enabled<>0'))[0].n)).toBe(0);
    expect(await ds.manager.findOneBy(User,{id:oldUserId})).toBeNull();
  });
});
