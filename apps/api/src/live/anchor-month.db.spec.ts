import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { Company,User } from '../entities';
import { buildDataSourceOptions } from '../database/data-source';
import { AuthUser } from '../common/auth.decorators';
import { AnchorMonthService } from './anchor-month.controller';
import { liveClock } from './live-core';
const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('主播本月业绩真实MySQL、未审核纳入及权限隔离',()=>{
 let ds:DataSource,service:AnchorMonthService,boss:AuthUser,viewer:AuthUser,hr:AuthUser,foreign:AuthUser,personId:number;
 const actor=(u:User,allow:string[]=[],admin=false):AuthUser=>({id:u.id,companyId:u.companyId,name:u.name,permissions:{isCompanyAdmin:admin,allow,deny:[]}});
 beforeAll(async()=>{
  ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true}).initialize();service=new AnchorMonthService(ds);
  const tag=randomBytes(5).toString('hex'),c=await ds.manager.save(Company,{code:'month'+tag,name:'月统计隔离测试',status:'active'}),f=await ds.manager.save(Company,{code:'monthForeign'+tag,name:'其他公司',status:'active'});
  const make=(companyId:number,name:string)=>ds.manager.save(User,{companyId,name,account:tag+name,passwordHash:'!',status:'active'});
  boss=actor(await make(c.id,'管理员'),[],true);viewer=actor(await make(c.id,'直播查看'),['features.live.view']);hr=actor(await make(c.id,'人事'),['resource.workforce.view']);foreign=actor(await make(f.id,'外公司'),[],true);personId=(await make(c.id,'主播')).id;
  await ds.query("INSERT INTO resource_records(company_id,type,title,status,data) VALUES(?,'workforce','主播','active',?)",[c.id,JSON.stringify({userId:personId})]);
  for(const day of ['2026-10-31','2026-11-01','2026-11-03','2026-12-01'])await ds.query("INSERT INTO live_sessions(company_id,room_id,room_name,anchor_user_id,douyin_account_id,douyin_account_name,session_date,start_at,end_at,status,started_by,started_role) VALUES(?,1,'南7',?,1,'账号',?,?,?,'pending_report',?,'anchor')",[c.id,personId,day,day+' 10:00:00',day+' 11:00:00',personId]);
  jest.spyOn(liveClock,'now').mockReturnValue(new Date('2026-11-04T04:00:00Z'));
 });
 afterAll(async()=>{jest.restoreAllMocks();if(ds?.isInitialized)await ds.destroy();});
 it('仅自然月实际场次，包含未审核；批量摘要与详情一致，缺数据明确提示',async()=>{
  const x=await service.read(boss,[personId],true),batch=await service.read(boss,[personId]);
  expect(x.month).toBe('2026-11');expect(x.items[0].summary).toMatchObject({sessionCount:2,minutes:120,missingSalesSessions:2,missingCommissionSessions:2,estimatedSessions:2});
  expect(x.items[0].sessions?.map(s=>s.date)).toEqual(['2026-11-03','2026-11-01']);expect(batch.items[0].summary).toEqual(x.items[0].summary);expect(batch.items[0].sessions).toBeUndefined();
 });
 it('直播查看者和档案查看者可见业绩，但服务器不返回无权限的提成金额',async()=>{
  for(const user of [viewer,hr]){const r=await service.read(user,[personId],true);expect(r.items[0].summary.commissionCents).toBeNull();expect(r.canViewCommission).toBe(false);expect(r.items[0].sessions?.every(s=>s.commissionCents===null)).toBe(true);}
 });
 it('拒绝跨公司编号、无权限读取、档案权限不能扩大到没有档案的员工',async()=>{
  await expect(service.read(foreign,[personId])).rejects.toThrow('人员不存在');
  await expect(service.read({...viewer,permissions:{allow:[],deny:[],isCompanyAdmin:false}},[personId])).rejects.toThrow('没有查看');
  await expect(service.read(hr,[boss.id])).rejects.toThrow('人员不存在');
 });
});
