import 'reflect-metadata';
import { randomBytes, createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { DataSource } from 'typeorm';
import { alignSessionTimeZone, buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, SessionAuditLog, SessionDevice, SessionShop, User } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { buildServices } from '../test-support';
import { MaintenanceService } from './maintenance.service';
import { SessionService } from './session.service';
import { MaintenanceRemoteAssistService, RemoteAssistService } from './remote.service';

const db = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
db('店铺维护与提现对照回归（隔离 MySQL）', () => {
  let ds:DataSource, services:ReturnType<typeof buildServices>, maintenance:MaintenanceService, finance:SessionService;
  let boss:AuthUser, other:AuthUser, viewer:AuthUser, manager:AuthUser;
  let device:{deviceId:number;token:string}, storeId:number, maintenanceId:number, financeId:number;
  beforeAll(async()=>{
    ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test'}),migrationsRun:true} as never);
    await ds.initialize();await alignSessionTimeZone(ds); services=buildServices(ds);
    maintenance=new MaintenanceService(ds,services.crypto,services.files,services.resources);finance=new SessionService(ds,services.crypto,services.files);
    const make=async()=>{const c=await ds.manager.save(Company,{code:`sp${randomBytes(6).toString('hex')}`,name:'隔离验收公司',status:'active'});const u=await ds.manager.save(User,{companyId:c.id,account:`sp${randomBytes(6).toString('hex')}`,passwordHash:'x',name:'测试管理员',status:'active',isCompanyAdmin:true,mustChangePassword:false});return {id:u.id,companyId:c.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}} as AuthUser;};
    boss=await make();other=await make();viewer={...boss,permissions:{isCompanyAdmin:false,allow:['resource.company-store-maintenance.view'],deny:[]}};
    manager={...boss,permissions:{isCompanyAdmin:false,allow:['resource.company-store-maintenance.view','resource.company-store-maintenance.manage','resource.company-store-maintenance.remote'],deny:[]}};
    storeId=(await services.resources.create(boss,'stores',{name:'回归合成店',platform:'pdd',platformStoreId:'SYNTHETIC-101'})).id;
    device=await finance.agentRegister({code:(await maintenance.createBindCode(manager)).code,name:'合成维护电脑',agentVersion:'1.1.1'});
    await maintenance.addShops(manager,{storeIds:[storeId],deviceId:device.deviceId});await finance.addShops(boss,{storeIds:[storeId],deviceId:device.deviceId});
    maintenanceId=(await maintenance.overview(manager)).shops[0].id;financeId=(await finance.overview(boss)).shops[0].id;
  });
  afterAll(async()=>{await ds?.destroy();});

  it('维护专属权限可绑定与备注，不借用财务权限；跨公司和只读用户拒绝',async()=>{
    await maintenance.remarkDevice(manager,device.deviceId,'01-维护');
    expect((await maintenance.devices(manager))[0].remark).toBe('01-维护');
    await expect(maintenance.remarkDevice(viewer,device.deviceId,'bad')).rejects.toThrow(/权限/);
    await expect(maintenance.remarkDevice(other,device.deviceId,'bad')).rejects.toThrow(/不存在/);
    await expect(maintenance.remarkDevice(manager,device.deviceId,'a'.repeat(81))).rejects.toThrow(/80/);
    await maintenance.remarkDevice(manager,device.deviceId,'');
    expect((await ds.manager.findOneByOrFail(SessionDevice,{id:device.deviceId})).remark).toBeNull();
  });

  it('状态、原因、变更日志与维护审计同事务；后续失败全部回滚',async()=>{
    const reason=await services.resources.create(boss,'store-abnormal-reasons',{reason:'合成异常原因'});
    const original=services.resources.saveChecked.bind(services.resources);
    const spy=jest.spyOn(services.resources,'saveChecked').mockImplementationOnce(async(...args)=>{await original(...args);throw new Error('模拟事务失败');});
    await expect(maintenance.setStoreStatus(manager,maintenanceId,{status:'abnormal',abnormalReasonId:reason.id})).rejects.toThrow('模拟事务失败');spy.mockRestore();
    expect((await services.resources.get(boss,'stores',storeId)).status).toBe('normal');
    await maintenance.setStoreStatus(manager,maintenanceId,{status:'abnormal',abnormalReasonId:reason.id});
    expect(await services.resources.get(boss,'stores',storeId)).toMatchObject({status:'abnormal',data:{abnormalReason:reason.id}});
    const reason2=await services.resources.create(boss,'store-abnormal-reasons',{reason:'另一合成异常原因'});
    await maintenance.setStoreStatus(manager,maintenanceId,{status:'abnormal',abnormalReasonId:reason2.id});
    expect((await services.resources.get(boss,'stores',storeId)).data.abnormalReason).toBe(reason2.id);
    const foreign=await services.resources.create(other,'store-abnormal-reasons',{reason:'外公司原因'});
    await expect(maintenance.setStoreStatus(manager,maintenanceId,{status:'abnormal',abnormalReasonId:foreign.id})).rejects.toThrow(/已有的异常原因/);
    await expect(maintenance.setStoreStatus(manager,maintenanceId,{status:'inactive'})).rejects.toThrow(/原因/);
    await expect(maintenance.setStoreStatus(manager,financeId,{status:'normal'})).rejects.toThrow(/不在/);
    await maintenance.setStoreStatus(manager,maintenanceId,{status:'normal'});
    expect((await services.resources.get(boss,'stores',storeId)).data.abnormalReason).toBeUndefined();
  });

  it('账号密码、登录环境标识和新增审计按工作区独立；日志没有密码',async()=>{
    await maintenance.updateShop(manager,maintenanceId,{loginAccount:'main-synthetic',loginPassword:'Main-Synthetic-Secret'});
    await finance.updateShop(boss,financeId,{loginAccount:'cash-synthetic',loginPassword:'Cash-Synthetic-Secret'});
    const req=await maintenance.requestOpen(manager,maintenanceId);
    const claim=await finance.agentClaim(device.token);
    expect(claim.request).toMatchObject({id:req.id,profileKey:`${boss.companyId}:company_store_maintenance:${storeId}`,credentials:{account:'main-synthetic'}});
    await finance.agentReport(device.token,req.id,{status:'progress',step:'waiting_login',progress:80});
    expect((await maintenance.overview(manager)).shops[0].request).toMatchObject({percent:80,step:'等待人工完成验证'});
    await expect(finance.agentReport(device.token,req.id,{status:'progress',step:'arbitrary secret',progress:99})).rejects.toThrow(/进度/);
    await finance.agentReport(device.token,req.id,{status:'failed',errorText:'Main-Synthetic-Secret'});
    expect(JSON.stringify(await maintenance.audit(manager))).not.toContain('Main-Synthetic-Secret');
    const logs=await maintenance.audit(manager), financeLogs=await finance.audit(boss);
    const statusLog=logs.find((x:{eventType:string})=>x.eventType==='store_status_changed');expect(statusLog).toBeDefined();
    expect(financeLogs.some((x:{id:number})=>x.id===statusLog.id)).toBe(false);
    expect(await ds.manager.count(SessionAuditLog,{where:{companyId:boss.companyId,workspace:'company_store_maintenance'}})).toBeGreaterThan(0);
  });

  it('维护与提现的远程会话不能通过另一工作区读取或结束',async()=>{
    const m=new MaintenanceRemoteAssistService(ds),f=new RemoteAssistService(ds);
    await m.setDevice(manager,device.deviceId,{enabled:true,allowControl:false,maxMinutes:5});
    const request=await m.request(manager,maintenanceId,{mode:'view',reason:'合成资料对照验收'});
    await expect(f.get(boss,request.id)).rejects.toThrow(/工作区/);
    await expect(f.end(boss,request.id)).rejects.toThrow(/工作区/);
    expect(await f.history(boss)).toHaveLength(0);expect((await m.history(manager))[0].id).toBe(request.id);
    await expect(m.request(viewer,maintenanceId,{mode:'view',reason:'无权操作'})).rejects.toThrow(/权限/);
    await m.end(manager,request.id);
  });

  it('候选清单无100/500条截断，支持平台/运营搜索，归档资料不能加入',async()=>{
    const rows=Array.from({length:505},(_,i)=>({companyId:boss.companyId,type:'stores',title:`候选${i}`,status:'normal',data:{name:`候选${i}`,platform:'pdd'},searchText:`候选${i}`,uniqueKey:null}));
    await ds.manager.insert(ResourceRecord,rows);
    expect((await maintenance.availableStores(manager,'候选0')).some(r=>r.name==='候选0')).toBe(true);
    expect((await maintenance.availableStores(manager)).length).toBeGreaterThan(500);
    expect((await maintenance.availableStores(manager,'拼多多')).length).toBeGreaterThan(500);
    await ds.manager.update(ResourceRecord, { companyId: boss.companyId, title: '候选0' }, { data: { name: '候选0', platform: 'pdd', operatorUserId: boss.id } });
    expect((await maintenance.availableStores(manager,boss.name)).some(r=>r.name==='候选0' && r.operatorName===boss.name)).toBe(true);
    const archived=(await services.resources.create(boss,'stores',{name:'已归档合成店',platform:'pdd'})).id;
    await services.resources.archive(boss,'stores',archived,'合成验收');
    expect((await maintenance.availableStores(manager,'已归档合成店')).length).toBe(0);
    await expect(maintenance.addShops(manager,{storeIds:[archived],deviceId:device.deviceId})).rejects.toThrow(/归档/);
  });

  it('下载安装包需要管理权限、按公司隔离，内容损坏会拒绝',async()=>{
    await expect(maintenance.downloadInstaller(viewer)).rejects.toThrow(/权限/);
    await expect(maintenance.downloadInstaller(manager)).rejects.toThrow(/未发布/);
    const files=['package.json','dist/cli.js','dist/main.js','dist/launcher.js'].map(path=>{const data=Buffer.from(path==='package.json'?JSON.stringify({name:'@kudesi/agent',version:'1.1.1',dependencies:{}}):'// synthetic installer fixture');return {path,data:data.toString('base64'),size:data.length,sha256:createHash('sha256').update(data).digest('hex')};});
    const buffer=gzipSync(JSON.stringify({format:'kudesi-assistant-package',formatVersion:1,version:'1.1.1',files}));
    await maintenance.publishRelease(manager,{buffer},{});
    const result=await maintenance.downloadInstaller(manager);
    expect(result.version).toBe('1.1.1');expect(result.buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(createHash('sha256').update(result.buf).digest('hex')).toBe(result.sha256);
    expect(result.buf.includes(Buffer.from('install.ps1'))).toBe(true);
    await expect(maintenance.downloadInstaller(other)).rejects.toThrow(/未发布/);
    await ds.query('UPDATE agent_releases SET package = ? WHERE company_id = ?',[Buffer.from('corrupt'),boss.companyId]);
    await expect(maintenance.downloadInstaller(manager)).rejects.toThrow(/校验失败/);
  });
  it('旧助手不能领取维护凭据；降级后的待办安全失败；提现截图携带独立环境标识',async()=>{
    await ds.manager.update(SessionDevice,device.deviceId,{agentVersion:'1.1.0'});
    expect((await maintenance.overview(manager)).shops[0].requiresAgentUpgrade).toBe(true);
    await expect(maintenance.requestOpen(manager,maintenanceId)).rejects.toThrow(/1.1.1/);
    await expect(new MaintenanceRemoteAssistService(ds).request(manager,maintenanceId,{mode:'view',reason:'合成版本兼容检查'})).rejects.toThrow(/1.1.1/);
    await ds.manager.update(SessionDevice,device.deviceId,{agentVersion:'1.1.1'});
    const pending=await maintenance.requestOpen(manager,maintenanceId);
    await ds.manager.update(SessionDevice,device.deviceId,{agentVersion:'1.1.0'});
    expect((await finance.agentClaim(device.token)).request).toBeNull();
    expect((await maintenance.history(manager,maintenanceId)).find((r:{id:number})=>r.id===pending.id)).toMatchObject({status:'failed',errorCode:'agent_upgrade_required'});
    await ds.manager.update(SessionDevice,device.deviceId,{agentVersion:'1.1.1'});
    await ds.manager.update(SessionShop,financeId,{loginState:'valid'});
    const capture=await finance.requestCapture(boss,financeId);
    expect((await finance.agentClaim(device.token)).request).toMatchObject({id:capture.id,kind:'capture',profileKey:`${boss.companyId}:finance_withdrawal:${storeId}`});
    await finance.agentReport(device.token,capture.id,{status:'failed',errorCode:'synthetic',errorText:'合成截图检查结束'});
  });

});
