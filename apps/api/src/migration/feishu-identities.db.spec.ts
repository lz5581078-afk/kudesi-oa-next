import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company,User } from '../entities';
import { importFeishuIdentity } from './feishu-identities';
import { legacyWallTime as wall } from './legacy-time';
import { buildServices } from '../test-support';
import { runLegacyImport } from './runner';
import type { LegacyArchive } from './protocol';

const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
suite('飞书原身份迁入（MySQL）',()=>{
  let ds:DataSource,companyId:number,userId:number,otherId:number;
  const links=new Map<string,number>();
  const source={company_id:3,employee_id:10,app_id:'fixture-app',tenant_key:'fixture-tenant',open_id:'fixture-open',union_id:'fixture-union',bound_at:'2026-08-01 10:00:00'};
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true}).initialize();
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomBytes(6).toString('hex'),name:'原飞书绑定',status:'active'}));companyId=c.id;
    for(const name of ['原人','其他人']){const u=await ds.manager.save(User,ds.manager.create(User,{companyId,name,account:null,passwordHash:'!no-login',status:'active',isCompanyAdmin:false,mustChangePassword:false}));if(name==='原人')userId=u.id;else otherId=u.id;}
  });
  afterAll(async()=>{await ds?.destroy();});
  const context=(em:DataSource['manager'],mapped=userId)=>({em,companyId,sourceCompanyId:3,lookup:(type:string,id:unknown)=>type==='user'&&String(id)==='10'?mapped:links.get(`${type}:${id}`),register:async(type:string,key:string,id:number)=>{links.set(`${type}:${key}`,id);}});
  it('保留原人、标识与绑定时点，重复迁入不覆盖新站同身份较新绑定；不恢复授权会话、不发消息',async()=>{
    await ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;const first=await importFeishuIdentity(context(em),source);expect(first.reused).toBe(false);expect((await importFeishuIdentity(context(em),source)).reused).toBe(true);});
    const [row]=await ds.query('SELECT * FROM feishu_identities WHERE company_id=?',[companyId]);expect(row.bound_at).toEqual(wall(source.bound_at));expect(Number(row.user_id)).toBe(userId);expect(row.open_id).toBe(source.open_id);
    const newer=wall('2026-09-01 11:00:00');await ds.query('UPDATE feishu_identities SET bound_at=? WHERE id=?',[newer,row.id]);
    await ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;expect((await importFeishuIdentity(context(em),source)).reused).toBe(true);});
    expect((await ds.query('SELECT bound_at FROM feishu_identities WHERE id=?',[row.id]))[0].bound_at).toEqual(newer);
    for(const table of ['feishu_oauth_states','outbox_jobs','notifications'])expect(Number((await ds.query(`SELECT COUNT(*) n FROM ${table} WHERE company_id=?`,[companyId]))[0].n)).toBe(0);
  });
  it('相同主体指向别人、同人另一个绑定、跨公司及无原时间均拒绝；回滚不留下身份',async()=>{
    for(const [patch,mapped] of [[{},otherId],[{open_id:'different-subject'},userId],[{union_id:'different-union'},userId],[{company_id:999},userId],[{bound_at:null},userId]] as const){
      await expect(ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;return importFeishuIdentity(context(em,mapped),{...source,...patch});})).rejects.toThrow();
    }
    await expect(ds.transaction(async em=>{em.queryRunner!.data.legacyImport=true;await importFeishuIdentity({...context(em),register:async()=>{}},{...source,employee_id:10,app_id:'rollback-app',open_id:'rollback-open'});throw Error('rollback');})).rejects.toThrow('rollback');
    expect(Number((await ds.query('SELECT COUNT(*) n FROM feishu_identities WHERE company_id=?',[companyId]))[0].n)).toBe(1);
  });
  it('正式导入器保存原始证据、核对指纹与复跑；身份失败时即便没有流程段也必须全批回滚',async()=>{
    await ds.manager.update(User,{id:otherId},{isCompanyAdmin:true});
    const svc=buildServices(ds),binding={...source,app_id:'runner-app',open_id:'runner-open'};
    const archive:LegacyArchive={company:{id:3,name:'原飞书绑定'},departments:[{id:1,name:'来源部门',status:'active'}],positions:[],employees:[{id:10,name:'迁入身份员工',login_account:null,status:'active',department_id:1,role_key:'employee'}],employeePositions:[],positionPermissions:[],records:[],exclusions:[],loadFile:async()=>Buffer.alloc(0),feishuBindings:[binding],sourceRows:[{table:'oa_feishu_bindings',key:'[3,10,"runner-app"]',row:binding}]};
    const opts={companyId,actorId:otherId,expectedName:'原飞书绑定',preserveLegacyStates:true,sourceRowsCrypto:svc.crypto};
    const dry=await runLegacyImport(ds,svc.resources,svc.files,archive,{...opts,apply:false});
    expect(dry.failures).toEqual([]);expect(dry.verified?.['feishu-identity']).toBe(1);
    expect(Number((await ds.query('SELECT COUNT(*) n FROM feishu_identities WHERE company_id=? AND app_id=?',[companyId,binding.app_id]))[0].n)).toBe(0);
    const applied=await runLegacyImport(ds,svc.resources,svc.files,archive,{...opts,apply:true,expectedReport:dry});expect(applied.failures).toEqual([]);
    const repeat=await runLegacyImport(ds,svc.resources,svc.files,archive,{...opts,apply:true});expect(repeat.created).toEqual({});expect(repeat.reused['feishu-identity']).toBe(1);
    const changed={...archive,feishuBindings:[{...binding,open_id:'changed-subject'}]};
    await expect(runLegacyImport(ds,svc.resources,svc.files,changed,{...opts,apply:true})).rejects.toThrow('来源资料已变化');
    const wrong={...binding,app_id:'rejected-app',open_id:'fixture-open',employee_id:999};
    const failed:LegacyArchive={...archive,departments:[],employees:[],feishuBindings:[wrong],sourceRows:[{table:'oa_feishu_bindings',key:'[3,999,"rejected-app"]',row:wrong}]};
    await expect(runLegacyImport(ds,svc.resources,svc.files,failed,{...opts,apply:true})).rejects.toThrow('整批回滚');
    expect(Number((await ds.query("SELECT COUNT(*) n FROM legacy_source_rows WHERE company_id=? AND source_key=?",[companyId,'[3,999,"rejected-app"]']))[0].n)).toBe(0);
  });
});
