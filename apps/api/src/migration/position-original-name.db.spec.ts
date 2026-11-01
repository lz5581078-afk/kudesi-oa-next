import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog,Company,Department,Position,User } from '../entities';
import { buildServices } from '../test-support';
import { OrgAdminService } from '../org/org-admin.service';
import { OrgService } from '../org/org.service';
import type { AuthUser } from '../common/auth.decorators';
import type { LegacyArchive } from './protocol';
import { runLegacyImport } from './runner';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('同名岗位原名称只读保留（MySQL）',()=>{
  let ds:DataSource,svc:ReturnType<typeof buildServices>,user:AuthUser,archive:LegacyArchive,id:number;
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();svc=buildServices(ds);
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'原岗位名字',status:'active'}));
    const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,name:'管理员',account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:true,mustChangePassword:false}));
    user={id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    const departments=[{id:1,company_id:3,name:'一部',status:'active'},{id:2,company_id:3,name:'二部',status:'active'},{id:3,company_id:3,name:'离职员工',status:'active',is_system:1}];
    const positions=[{id:11,name:'经理',department_id:1,level:'manager',status:'active',workspace_template_key:'general'},{id:12,name:'经理',department_id:2,level:'manager',status:'active',workspace_template_key:'general'}];
    const employees=[{id:21,department_id:1,name:'原登录时间员工',login_account:null,role_key:'staff',status:'active',last_login_at:'2026-10-30 23:45:06'}];
    archive={company:{id:3,name:c.name},departments,positions,employees,employeePositions:[],positionPermissions:[],records:[],exclusions:[],loadFile:async()=>Buffer.alloc(0),sourceRows:[...departments.map(r=>({table:'departments',key:String(r.id),row:{...r,private_payload:'fixture-hidden-raw'}})),...positions.map(r=>({table:'positions',key:String(r.id),row:{...r,private_payload:'fixture-hidden-raw'}})),...employees.map(r=>({table:'employees',key:String(r.id),row:r}))]};
  });
  afterAll(async()=>{await ds?.destroy();});
  const options=()=>({companyId:user.companyId,actorId:user.id,expectedName:archive.company.name,sourceRowsCrypto:svc.crypto,preserveLegacyStates:true});
  it('真实岗位详情保留原名/原部门，不创建重名岗位或返回原始JSON；试跑完整回滚',async()=>{
    archive.departments[2].is_system=2;await expect(runLegacyImport(ds,svc.resources,svc.files,archive,{...options(),apply:false})).rejects.toThrow('系统标志无效');archive.departments[2].is_system=1;
    archive.employees[0].last_login_at='invalid';await expect(runLegacyImport(ds,svc.resources,svc.files,archive,{...options(),apply:false})).rejects.toThrow('最后登录时间无效');archive.employees[0].last_login_at='2026-10-30 23:45:06';
    const dry=await runLegacyImport(ds,svc.resources,svc.files,archive,{...options(),apply:false});
    expect(dry.failures).toEqual([]);expect(dry.excluded).toEqual([]);expect(dry.verified?.['position-original-name-view']).toBe(1);
    expect(await ds.manager.count(Position,{where:{companyId:user.companyId}})).toBe(0);expect(await ds.manager.count(Department,{where:{companyId:user.companyId}})).toBe(0);
    const applied=await runLegacyImport(ds,svc.resources,svc.files,archive,{...options(),apply:true,expectedReport:dry});
    id=applied.mappings.find(m=>m.type==='position'&&m.sourceId==='12')!.targetId;
    const view=await new OrgAdminService(ds,svc.resources).positionProfile(user,id);
    expect((await ds.manager.findOneByOrFail(Department,{companyId:user.companyId,name:'离职员工'})).isSystem).toBe(true);
    const tree=await new OrgService(ds.getRepository(Department),ds.getRepository(AuditLog),ds.getRepository(User)).departmentTree(user);expect(tree.map(d=>d.name)).toEqual(['一部','二部']);
    const employee=await ds.manager.findOneByOrFail(User,{id:applied.mappings.find(m=>m.type==='user'&&m.sourceId==='21')!.targetId,companyId:user.companyId});expect(employee.lastLoginAt?.toISOString()).toBe('2026-10-30T15:45:06.000Z');
    expect(dry.verified?.['user-last-login']).toBe(1);expect(dry.verified?.['department-system-flag']).toBe(3);
    expect(view.position.name).toBe('二部 / 经理');expect(view.legacyName).toEqual({name:'经理',departmentName:'二部'});
    expect(JSON.stringify(view)).not.toContain('fixture-hidden-raw');expect(await ds.manager.count(Position,{where:{companyId:user.companyId}})).toBe(2);
  });
  it('仅在已有岗位查看权限下返回原名；跨公司和缺失读取服务拒绝',async()=>{
    const org=new OrgAdminService(ds,svc.resources),viewer={...user,permissions:{isCompanyAdmin:false,allow:['org.structure.view'],deny:[]}};
    expect((await org.positionProfile(viewer,id)).legacyName?.name).toBe('经理');
    await expect(org.positionProfile({...viewer,permissions:{isCompanyAdmin:false,allow:[],deny:[]}},id)).rejects.toThrow('没有岗位查看权限');
    await expect(org.positionProfile({...user,companyId:user.companyId+99999},id)).rejects.toThrow('不存在');
    await expect(new OrgAdminService(ds).positionProfile(user,id)).rejects.toThrow('未配置');
  });
  it('原始证据损坏不能回退成猜测名称，失败后仍可读取原值',async()=>{
    await expect(ds.transaction(async em=>{
      await em.query("UPDATE legacy_source_rows SET source_hash=? WHERE company_id=? AND source_table='positions' AND source_key='12'",['0'.repeat(64),user.companyId]);
      const bound=Object.create(ds) as DataSource;Object.defineProperty(bound,'manager',{value:em});
      return new OrgAdminService(bound,svc.resources).positionProfile(user,id);
    })).rejects.toThrow();
    expect((await new OrgAdminService(ds,svc.resources).positionProfile(user,id)).legacyName?.name).toBe('经理');
  });
  it('完整重迁不能仅用正确目标名掩盖错误来源公司，写入前拒绝混导',async()=>{
    const before=await ds.manager.count(Position,{where:{companyId:user.companyId}});
    await expect(runLegacyImport(ds,svc.resources,svc.files,{...archive,company:{...archive.company,name:'另一家公司'}},{...options(),apply:false})).rejects.toThrow('禁止将公司混导');
    expect(await ds.manager.count(Position,{where:{companyId:user.companyId}})).toBe(before);
    expect((await ds.manager.findOneByOrFail(Company,{id:user.companyId})).name).toBe(archive.company.name);
  });

});
