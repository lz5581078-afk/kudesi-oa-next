import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Company,User,PositionDuty } from '../entities';
import { buildDataSourceOptions } from '../database/data-source';
import { buildServices } from '../test-support';
import type { AuthUser } from '../common/auth.decorators';
import type { LegacyArchive } from './protocol';
import { runLegacyImport } from './runner';
import { verifyResponsibilityDuplicates } from './responsibility-duplicates';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('旧岗位职责副本逐字段核对（MySQL）',()=>{
  let ds:DataSource,svc:ReturnType<typeof buildServices>,actor:AuthUser,archive:LegacyArchive,targetId:number,positionId:number;
  const original={id:'81',position_id:'11',category:'监督',title:'监督说明',description:'每日核对账目',frequency:'每日',related_module:'finance'};
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();svc=buildServices(ds);
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'岗位副本核对',status:'active'}));
    const u=await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,name:'管理员',account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:true,mustChangePassword:false}));actor={id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    const departments=[{id:7,company_id:3,name:'监督部',status:'active'}],positions=[{id:11,department_id:7,name:'监督员',status:'active',level:'staff',workspace_template_key:'general'}],positionDuties=[{id:31,position_id:11,company_id:3,duty_category:original.category,title:original.title,description:original.description,frequency:original.frequency,related_module:original.related_module,status:'active'}];
    archive={company:{id:3,name:c.name},departments,positions,employees:[],employeePositions:[],positionPermissions:[],positionDuties,records:[],exclusions:[],loadFile:async()=>Buffer.alloc(0),sourceRows:[...departments.map(row=>({table:'departments',key:String(row.id),row})),...positions.map(row=>({table:'positions',key:String(row.id),row})),...positionDuties.map(row=>({table:'position_duties',key:String(row.id),row})),{table:'position_responsibilities',key:'81',row:{...original}}]};
  });
  afterAll(async()=>{await ds?.destroy();});
  const options=()=>({companyId:actor.companyId,actorId:actor.id,expectedName:archive.company.name,sourceRowsCrypto:svc.crypto,preserveLegacyStates:true});
  it('内容、未知列、公司归属或多个匹配不符均拒绝，不把相似记录当完全副本',async()=>{
    for(const patch of [{description:'不同说明'},{unknown:'不可忽略新列'}]){
      const source={...archive,sourceRows:archive.sourceRows!.map(r=>r.table==='position_responsibilities'?{...r,row:{...r.row,...patch}}:r)};
      const report=await runLegacyImport(ds,svc.resources,svc.files,source,{...options(),apply:false});expect(report.failures.some(f=>f.type==='position-responsibility-duplicate-view')).toBe(true);
    }
    const foreign={...archive,sourceRows:archive.sourceRows!.map(r=>r.table==='departments'?{...r,row:{...r.row,company_id:4}}:r)};
    await expect(runLegacyImport(ds,svc.resources,svc.files,foreign,{...options(),apply:false})).rejects.toThrow('不属于指定旧公司');
    const ambiguous={...archive,positionDuties:[...archive.positionDuties!,{...archive.positionDuties![0],id:32}]};
    expect((await runLegacyImport(ds,svc.resources,svc.files,ambiguous,{...options(),apply:false})).failures.some(f=>f.type==='position-responsibility-duplicate-view')).toBe(true);
    expect(await ds.manager.count(PositionDuty,{where:{companyId:actor.companyId}})).toBe(0);
  });
  it('只生成一条原生职责，另一来源身份保留原始行和独立账本；可真实页面回读并幂等复用',async()=>{
    const dry=await runLegacyImport(ds,svc.resources,svc.files,archive,{...options(),apply:false});expect(dry.failures).toEqual([]);expect(dry.excluded).toEqual([]);expect(dry.verified?.['position-responsibility-duplicate-view']).toBe(1);
    expect(await ds.manager.count(PositionDuty,{where:{companyId:actor.companyId}})).toBe(0);
    const applied=await runLegacyImport(ds,svc.resources,svc.files,archive,{...options(),apply:true,expectedReport:dry});
    targetId=applied.mappings.find(m=>m.type==='position_duty')!.targetId;positionId=applied.mappings.find(m=>m.type==='position')!.targetId;
    expect(applied.mappings.find(m=>m.type==='position_responsibility')).toMatchObject({sourceId:'81',targetId});expect(await ds.manager.count(PositionDuty,{where:{companyId:actor.companyId}})).toBe(1);
    expect(await svc.resources.legacySourceRow(ds.manager,actor,3,'position_responsibilities','81')).toEqual(original);
    const again=await runLegacyImport(ds,svc.resources,svc.files,archive,{...options(),apply:true});expect(again.failures).toEqual([]);expect(again.reused['position-responsibility-link']).toBe(1);
  });
  it('原生职责被错误存储时拒绝核对，回滚后原说明仍可读取；跨公司证据不可读取',async()=>{
    const run=(em:DataSource['manager'],user=actor)=>verifyResponsibilityDuplicates({em,resources:svc.resources,user,sourceCompanyId:3,duties:archive.positionDuties!,lookup:(type)=>type==='position'?positionId:type==='position_duty'?targetId:undefined},[original]);
    await expect(ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;await em.update(PositionDuty,{id:targetId,companyId:actor.companyId},{description:'错误新说明'});return run(em);})).rejects.toThrow('副本未能逐字段');
    await expect(ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;return run(em,{...actor,companyId:actor.companyId+99999});})).rejects.toThrow('副本未能逐字段');
    expect((await ds.manager.findOneByOrFail(PositionDuty,{id:targetId})).description).toBe('每日核对账目（旧分类：监督）');
  });
});
