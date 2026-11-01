import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company,User } from '../entities';
import { buildServices } from '../test-support';
import { OrgAdminService } from '../org/org-admin.service';
import type { AuthUser } from '../common/auth.decorators';
import type { LegacyArchive } from './protocol';
import { runLegacyImport } from './runner';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('全部任职履历与有效岗位真实回读（MySQL）',()=>{
  let ds:DataSource,svc:ReturnType<typeof buildServices>,user:AuthUser,source:LegacyArchive,nativeIds:number[];
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();svc=buildServices(ds);
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'旧任职完整保留',status:'active'}));
    const actor=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,name:'执行人',account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:true,mustChangePassword:false}));
    user={id:actor.id,companyId:c.id,name:actor.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    const departments=[{id:1,company_id:3,name:'来源部门',status:'active'}];
    const positions=[1,2].map(id=>({id,department_id:1,name:'原岗位'+id,level:'staff',status:'active',workspace_template_key:'general'}));
    const employees=[1,2,3].map(id=>({id,department_id:1,name:'原人员'+id,login_account:null,status:id===1?'active':'inactive'}));
    const memberships=[{id:11,employee_id:1,position_id:1,is_primary:1,started_at:'2025-01-02',ended_at:null,status:'active'},
      {id:12,employee_id:1,position_id:2,is_primary:0,started_at:null,ended_at:'2026-01-01',status:'inactive'},
      {id:13,employee_id:2,position_id:2,is_primary:1,started_at:null,ended_at:null,status:'inactive'},
      {id:14,employee_id:3,position_id:1,is_primary:1,started_at:null,ended_at:null,status:'active'}];
    source={company:{id:3,name:c.name},departments,positions,employees,employeePositions:memberships.filter(r=>r.status==='active'),positionPermissions:[],records:[],exclusions:[],loadFile:async()=>Buffer.alloc(0),sourceRows:[...Object.entries({departments,positions,employees,employee_positions:memberships}).flatMap(([table,rows])=>rows.map(row=>({table,key:String(row.id),row:{...row,private_payload:'never-return-raw-source'}})))]};
  });
  afterAll(async()=>{await ds?.destroy();});
  const opts=()=>({companyId:user.companyId,actorId:user.id,expectedName:source.company.name,preserveLegacyStates:true,sourceRowsCrypto:svc.crypto});
  it('停用兼任不再赋权，离职旧岗保留历史；停用人员仍保留其有效任职，日期空值不编造',async()=>{
    const dry=await runLegacyImport(ds,svc.resources,svc.files,source,{...opts(),apply:false});expect(dry.failures).toEqual([]);expect(dry.verified?.['employee-position-history-view']).toBe(4);
    expect(await ds.manager.count(User,{where:{companyId:user.companyId}})).toBe(1);
    const applied=await runLegacyImport(ds,svc.resources,svc.files,source,{...opts(),apply:true,expectedReport:dry});
    nativeIds=[1,2,3].map(id=>applied.mappings.find(m=>m.type==='user'&&m.sourceId===String(id))!.targetId);
    const employees=await Promise.all(nativeIds.map(id=>ds.manager.findOneByOrFail(User,{companyId:user.companyId,id})));
    expect(employees[0].positionId).toBeTruthy();expect(employees[0].extraPositionIds).toEqual([]);expect(employees[1].positionId).toBeNull();expect(employees[1].extraPositionIds).toEqual([]);expect(employees[2].status).toBe('disabled');expect(employees[2].positionId).toBe(employees[0].positionId);
    const view=await new OrgAdminService(ds,svc.resources).staffRecords(user,nativeIds[0]);
    expect(view.legacyAssignments).toEqual([{sourceId:'11',sourceEmployeeId:'1',sourcePositionId:'1',positionName:'原岗位1',departmentName:'来源部门',status:'active',isPrimary:true,startedAt:'2025-01-02',endedAt:null},{sourceId:'12',sourceEmployeeId:'1',sourcePositionId:'2',positionName:'原岗位2',departmentName:'来源部门',status:'inactive',isPrimary:false,startedAt:null,endedAt:'2026-01-01'}]);
    expect(JSON.stringify(view)).not.toContain('never-return-raw-source');
  });
  it('人员记录权限、跨公司及原文完整性独立校验，不允许任职原JSON泄露',async()=>{
    const org=new OrgAdminService(ds,svc.resources),viewer={...user,permissions:{isCompanyAdmin:false,allow:['org.staff.view'],deny:[]}};
    expect((await org.staffRecords(viewer,nativeIds[1])).legacyAssignments).toHaveLength(1);
    await expect(org.staffRecords({...viewer,permissions:{isCompanyAdmin:false,allow:[],deny:[]}},nativeIds[0])).rejects.toThrow('查看权限');
    await expect(org.staffRecords({...user,companyId:user.companyId+999999},nativeIds[0])).rejects.toThrow('不存在');
    await expect(new OrgAdminService(ds).staffRecords(user,nativeIds[0])).rejects.toThrow('未配置');
    await expect(ds.transaction(async em=>{
      await em.query("UPDATE legacy_source_rows SET source_hash=? WHERE company_id=? AND source_table='employee_positions' AND source_key='12'",['0'.repeat(64),user.companyId]);
      const bound=Object.create(ds) as DataSource;Object.defineProperty(bound,'manager',{value:em});return new OrgAdminService(bound,svc.resources).staffRecords(user,nativeIds[0]);
    })).rejects.toThrow('完整性');
    expect((await org.staffRecords(user,nativeIds[0])).legacyAssignments).toHaveLength(2);
  });
});
