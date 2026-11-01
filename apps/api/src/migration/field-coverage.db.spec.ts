import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company,User } from '../entities';
import { buildServices } from '../test-support';
import type { LegacyArchive } from './protocol';
import { runLegacyImport } from './runner';
const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('完整模式字段未验收不可提交（MySQL）',()=>{
  let ds:DataSource,svc:ReturnType<typeof buildServices>,companyId:number,actorId:number,archive:LegacyArchive;
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();svc=buildServices(ds);
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'字段验收门禁',status:'active'}));companyId=c.id;
    actorId=(await ds.manager.save(User,ds.manager.create(User,{companyId,name:'管理员',account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:true,mustChangePassword:false}))).id;
    archive={company:{id:3,name:c.name},departments:[],positions:[],employees:[],employeePositions:[],positionPermissions:[],records:[],exclusions:[],loadFile:async()=>Buffer.alloc(0),sourceRows:[{table:'legacy_schema_inventory',key:'current',row:{version:1,tables:[{table:'source_fixture_records',totalRows:'1',companyRowsRead:1,readInCompanyScope:true,fields:['id','company_id','value'].map((name,i)=>({name,type:'varchar(100)',nullable:'YES',primary:false,ordinal:i+1}))}]}},{table:'source_fixture_records',key:'1',row:{id:'1',company_id:3,value:'private-fixture-content'}}]};
  });
  afterAll(async()=>{await ds?.destroy();});
  const opts=()=>({companyId,actorId,expectedName:archive.company.name,preserveLegacyStates:true,sourceRowsCrypto:svc.crypto});
  const residue=async()=>Number((await ds.query('SELECT COUNT(*) n FROM legacy_source_rows WHERE company_id=?',[companyId]))[0].n);
  it('原文已保存/写入失败0仍明确列出未验收字段，正式提交拒绝且原文/审计全回滚',async()=>{
    const dry=await runLegacyImport(ds,svc.resources,svc.files,archive,{...opts(),apply:false});expect(dry.failures).toEqual([]);expect(dry.created['legacy-source-row']).toBe(2);
    expect(dry.fieldCoverage?.totals).toMatchObject({columns:3,pendingColumns:3,verifiedColumns:0,unretainedColumns:0});expect(dry.excluded).toHaveLength(1);expect(dry.excluded[0].type).toBe('source-fields.pending');expect(JSON.stringify(dry.fieldCoverage)).not.toContain('private-fixture-content');expect(await residue()).toBe(0);
    const rejected=jest.fn();await expect(runLegacyImport(ds,svc.resources,svc.files,archive,{...opts(),apply:true,expectedReport:dry,rollbackReport:rejected})).rejects.toThrow('未验收');
    expect(rejected).toHaveBeenCalledTimes(1);expect(rejected.mock.calls[0][0].phase).toBe('apply-rejected-rollback');expect(await residue()).toBe(0);
    expect(Number((await ds.query('SELECT COUNT(*) n FROM audit_logs WHERE company_id=?',[companyId]))[0].n)).toBe(0);
  });
  it('字段报告被改为通过也不能放行，完整比较并输出明确回滚报告',async()=>{
    const dry=await runLegacyImport(ds,svc.resources,svc.files,archive,{...opts(),apply:false}),changed=structuredClone(dry);
    changed.fieldCoverage!.tables[0].fields[0].state='verified-native';changed.fieldCoverage!.totals.verifiedColumns=1;
    const rejected=jest.fn();await expect(runLegacyImport(ds,svc.resources,svc.files,archive,{...opts(),apply:true,expectedReport:changed,rollbackReport:rejected})).rejects.toThrow('核对试迁不一致');
    expect(rejected).toHaveBeenCalledTimes(1);expect(rejected.mock.calls[0][0].phase).toBe('apply-rejected-rollback');expect(await residue()).toBe(0);
  });
});
