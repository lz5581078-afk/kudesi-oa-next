import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { AuditLog, Company, User } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { ExternalConfigService, FeishuConfig } from '../integrations/external-config.service';
import { FeishuAuthService } from '../auth/feishu-auth.service';
import { FeishuBindingPolicy } from '../auth/feishu-binding-policy';
import { StaffFeishuService } from './staff-feishu.service';

const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('全员取消飞书关联（隔离 MySQL）',()=>{
  let ds:DataSource,service:StaffFeishuService,external:ExternalConfigService,actor:AuthUser,other:number,part:number,disabled:number;
  const cfg:FeishuConfig={appId:'reset-app',tenantKey:'reset-tenant',appSecret:'test-only',enabled:true,origin:'https://test.example',channels:[]};
  const mk=async(companyId:number,name:string,extra:Partial<User>={})=>ds.manager.save(User,{companyId,name,account:randomBytes(8).toString('hex'),passwordHash:'test-only',status:'active',...extra});
  const bind=(companyId:number,userId:number,app='reset-app')=>ds.query('INSERT INTO feishu_identities(company_id,user_id,app_id,tenant_key,open_id,oa_notifications) VALUES(?,?,?,?,?,0)',[companyId,userId,app,cfg.tenantKey,'ou_'+userId+'_'+app]);
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();
    const c=await ds.manager.save(Company,{code:randomBytes(8).toString('hex'),name:'重绑本公司',status:'active'});
    other=(await ds.manager.save(Company,{code:randomBytes(8).toString('hex'),name:'其他公司',status:'active'})).id;
    const admin=await mk(c.id,'管理员',{isCompanyAdmin:true});
    actor={id:admin.id,companyId:c.id,name:admin.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    part=(await mk(c.id,'兼职',{employmentType:'part_time'})).id;disabled=(await mk(c.id,'停用人员',{status:'disabled'})).id;
    const foreign=await mk(other,'外公司');await bind(other,foreign.id);
    external={ds,read:async()=>cfg} as unknown as ExternalConfigService;service=new StaffFeishuService(ds,external);
  },30000);
  beforeEach(async()=>{
    await ds.query('DELETE FROM feishu_identities WHERE company_id=?',[actor.companyId]);await ds.query('DELETE FROM feishu_oauth_states WHERE company_id=?',[actor.companyId]);
    await bind(actor.companyId,actor.id);await bind(actor.companyId,part);await bind(actor.companyId,disabled,'old-app');
  });
  afterAll(async()=>{await ds?.destroy();});
  it('只允许数据库内仍有效的本公司管理员；普通人事即使有编辑权限也拒绝',async()=>{
    await expect(service.resetPreview({...actor,permissions:{isCompanyAdmin:false,allow:['org.staff.view','org.staff.edit'],deny:[]}})).rejects.toThrow('仅公司管理员');
    await expect(service.resetBindings({...actor,id:part},'0'.repeat(64))).rejects.toThrow('仅公司管理员');
    await expect(service.resetPreview({...actor,companyId:other})).rejects.toThrow('仅公司管理员');
    expect(await ds.query('SELECT id FROM feishu_identities WHERE company_id=?',[actor.companyId])).toHaveLength(3);
  });
  it('预览包含管理员、兼职、停用和旧应用；范围变化拒绝整个操作且不删授权状态',async()=>{
    const plan=await service.resetPreview(actor);expect(plan).toMatchObject({bindingCount:3,employeeCount:3,includesSelf:true});
    expect(JSON.stringify(plan)).not.toMatch(/open_id|test-only|ou_/);
    await bind(actor.companyId,part,'another-app');
    await expect(service.resetBindings(actor,plan.fingerprint)).rejects.toMatchObject({status:409});
    expect(await ds.query('SELECT id FROM feishu_identities WHERE company_id=?',[actor.companyId])).toHaveLength(4);
  });
  it('一次事务清除本公司全部关联和旧授权，保留其他公司，原账号仍在且绑定策略立即拒绝',async()=>{
    const auth=new FeishuAuthService(external,{} as never,{} as never);await auth.start(actor.companyId,actor);
    const plan=await service.resetPreview(actor);expect(await service.resetBindings(actor,plan.fingerprint)).toEqual({bindingCount:3,employeeCount:3,includesSelf:true,remainingBindings:0});
    expect(await ds.query('SELECT id FROM feishu_identities WHERE company_id=?',[actor.companyId])).toHaveLength(0);
    expect(await ds.query('SELECT state_hash FROM feishu_oauth_states WHERE company_id=?',[actor.companyId])).toHaveLength(0);
    expect(await ds.query('SELECT id FROM feishu_identities WHERE company_id=?',[other])).toHaveLength(1);
    expect(await ds.manager.count(User,{where:{companyId:actor.companyId}})).toBe(3);
    expect(await new FeishuBindingPolicy(external).isBound(actor.companyId,actor.id)).toBe(false);
    const logs=await ds.manager.find(AuditLog,{where:{companyId:actor.companyId,action:'staff.feishu.reset_all'}});expect(logs).toHaveLength(1);expect(logs[0].detail).toMatchObject({employeeCount:3});
    await expect(service.resetBindings(actor,plan.fingerprint)).rejects.toMatchObject({status:409});
  });
  it('取消前已在交换身份的旧回调不能偷偷恢复关联；新授权才能重绑并开启本人通知',async()=>{
    let entered!:()=>void,release!:(v:any)=>void;
    const waiting=new Promise<void>(r=>{entered=r;}),identity=new Promise<any>(r=>{release=r;});
    const client={identity:jest.fn(async()=>{entered();return identity;})};
    const auth=new FeishuAuthService(external,client as never,{} as never),old=await auth.start(actor.companyId,actor);
    const complete=auth.complete('old-code',old.state,old.browser,actor).then(()=>null,e=>e);
    await waiting;
    await service.resetBindings(actor,(await service.resetPreview(actor)).fingerprint);
    release({openId:'ou_fresh_'+actor.id,unionId:null,tenantKey:cfg.tenantKey});
    expect((await complete)?.message).toMatch(/重置/);
    expect(await new FeishuBindingPolicy(external).isBound(actor.companyId,actor.id)).toBe(false);
    const fresh=await auth.start(actor.companyId,actor);expect(await auth.complete('fresh-code',fresh.state,fresh.browser,actor)).toMatchObject({bound:true,allNotificationsEnabled:true});
    expect(await new FeishuBindingPolicy(external).isBound(actor.companyId,actor.id)).toBe(true);
    expect((await ds.query('SELECT oa_notifications FROM feishu_identities WHERE company_id=?',[actor.companyId]))[0].oa_notifications).toBe(1);
  });
});
