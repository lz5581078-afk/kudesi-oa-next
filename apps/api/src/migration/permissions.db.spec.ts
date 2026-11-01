import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, PositionPermission, User, UserPermissionOverride } from '../entities';
import { buildServices } from '../test-support';
import { runLegacyImport } from './runner';
import { LegacyArchive } from './protocol';

const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('旧权限合并的边界（隔离MySQL）',()=>{
  let ds:DataSource,svc:ReturnType<typeof buildServices>;
  beforeAll(async()=>{
    process.env.JWT_SECRET||='isolated-migration-test-signing-key-32bytes';
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();
    svc=buildServices(ds);
  });
  afterAll(async()=>{await ds?.destroy();});
  it.each([false,true])('岗位不跨组补足，个人拒绝优先且不受来源顺序影响 reverse=%s',async reverse=>{
    const tag=randomBytes(6).toString('hex');
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:tag,name:'权限迁入',status:'active'}));
    const actor=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,name:'执行人',account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:true,mustChangePassword:false}));
    const pages=['company-public-accounts','company-bank-cards','cashier-accounts','store-public-accounts','store-personal-cards'];
    const overrides=[
      {id:1,employee_id:1,permission_key:'finance-product-bundles.view',effect:'deny'},
      {id:2,employee_id:1,permission_key:'finance-product-bundles.sync',effect:'allow'},
      {id:3,employee_id:1,permission_key:'resources.business-licenses.detail',effect:'deny'},
      {id:4,employee_id:1,permission_key:'resources.business-licenses.view',effect:'allow'},
      ...pages.map((p,i)=>({id:10+i,employee_id:1,permission_key:`resources.${p}.edit`,effect:i===4?'deny':'allow'})),
    ];
    const source:LegacyArchive={company:{id:3,name:c.name},departments:[{id:1,name:'原部门',status:'active'}],
      positions:[1,2,3].map(id=>({id,department_id:1,name:`原岗位${id}`,level:'staff',status:'active',workspace_template_key:'finance'})),
      employees:[{id:1,name:'原员工',department_id:1,login_account:null,status:'active'}],employeePositions:[],
      positionPermissions:pages.flatMap((p,i)=>[
        {position_id:1,permission_key:`resources.${p}.edit`},
        {position_id:i===4?3:2,permission_key:`resources.${p}.edit`},
      ]),employeeOverrides:reverse?overrides.reverse():overrides,records:[],exclusions:[],loadFile:async()=>Buffer.alloc(0)};
    const run=(apply:boolean)=>runLegacyImport(ds,svc.resources,svc.files,source,{companyId:c.id,actorId:actor.id,expectedName:c.name,apply});
    const dry=await run(false);
    expect(dry.failures).toEqual([]);
    expect(await ds.manager.count(User,{where:{companyId:c.id}})).toBe(1);
    const result=await run(true);
    expect(result.failures).toEqual([]);
    const positions=result.mappings.filter(m=>m.type==='position');
    for(const p of positions){
      const keys=(await ds.manager.findBy(PositionPermission,{positionId:p.targetId})).map(x=>x.permission);
      expect(keys).toEqual(p.sourceId==='1'?['resource.bank-accounts.edit']:[]);
    }
    const userId=result.mappings.find(m=>m.type==='user'&&m.sourceId==='1')!.targetId;
    const grants=await ds.manager.findBy(UserPermissionOverride,{userId});
    expect(grants.map(x=>[x.permission,x.effect]).sort()).toEqual([
      ['finance.bundle-sync.manage','deny'],['resource.finance-bundles.view','deny'],['resource.licenses.view','deny'],
    ].sort());
    expect(result.excluded.filter(x=>x.type==='position.permission')).toHaveLength(5);
    expect(result.excluded.filter(x=>x.type==='user.permission')).toHaveLength(5);
    expect(Number((await ds.query('SELECT COUNT(*) n FROM outbox_jobs WHERE company_id=?',[c.id]))[0].n)).toBe(0);
  });
});
