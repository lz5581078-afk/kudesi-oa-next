import 'reflect-metadata';
import {randomBytes} from 'node:crypto';
import {DataSource} from 'typeorm';
import type {AuthUser} from '../common/auth.decorators';
import {buildDataSourceOptions} from '../database/data-source';
import {AuditLog,Company,Department,User} from '../entities';
import {OrgService} from './org.service';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('财务经办人目录的部门名称（真实隔离库）',()=>{
  let ds:DataSource,service:OrgService,actor:AuthUser,other:AuthUser;
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true}).initialize();service=new OrgService(ds.getRepository(Department),ds.getRepository(AuditLog),ds.getRepository(User));
    const company=async(name:string)=>await ds.manager.save(Company,ds.manager.create(Company,{code:`od${randomBytes(5).toString('hex')}`,name,status:'active'}));
    const a=await company('合成财务目录公司'),b=await company('合成其他目录公司');
    const department=await ds.manager.save(Department,ds.manager.create(Department,{companyId:a.id,name:'合成财务部',status:'active',sortOrder:0,isSystem:false})),foreign=await ds.manager.save(Department,ds.manager.create(Department,{companyId:b.id,name:'其他公司私有部门',status:'active',sortOrder:0,isSystem:false}));
    const employee=async(companyId:number,name:string,departmentId:number|null,status:'active'|'disabled'='active')=>await ds.manager.save(User,ds.manager.create(User,{companyId,name,departmentId,status,account:`synthetic-${randomBytes(4).toString('hex')}`,passwordHash:'x',isCompanyAdmin:false,mustChangePassword:false}));
    const owner=await employee(a.id,'合成有部门人员',department.id),foreignUser=await employee(b.id,'其他公司人员',foreign.id);await employee(a.id,'合成未分部门人员',null);await employee(a.id,'合成停用人员',department.id,'disabled');await employee(a.id,'合成错误跨公司引用',foreign.id);
    actor={id:owner.id,companyId:a.id,name:owner.name,permissions:{isCompanyAdmin:false,allow:[],deny:[]}};other={...actor,id:foreignUser.id,companyId:b.id,name:foreignUser.name};
  });
  afterAll(async()=>{await ds?.destroy();});
  it('按当前公司批量读取部门名，空部门/错误跨公司引用返回null且不泄露账号或其他员工字段',async()=>{
    const rows=await service.directory(actor);expect(rows).toHaveLength(4);
    expect(rows.find(row=>row.name==='合成有部门人员')).toMatchObject({active:true,departmentName:'合成财务部'});expect(rows.find(row=>row.name==='合成停用人员')).toMatchObject({active:false,departmentName:'合成财务部'});
    expect(rows.find(row=>row.name==='合成未分部门人员')?.departmentName).toBeNull();expect(rows.find(row=>row.name==='合成错误跨公司引用')?.departmentName).toBeNull();
    for(const row of rows)expect(Object.keys(row).sort()).toEqual(['active','departmentName','id','name']);expect(JSON.stringify(rows)).not.toContain('其他公司');
    expect(await service.directory(other)).toEqual([expect.objectContaining({name:'其他公司人员',departmentName:'其他公司私有部门'})]);
  });
});
