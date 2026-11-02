import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, Position, User } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { liveClock } from './live-core';
import { LiveLedgerService } from './live-ledger.service';

const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('个人工作台直播收入（隔离 MySQL）',()=>{
  let ds:DataSource,ledger:LiveLedgerService,company:number,other:number,actor:AuthUser,anchor:AuthUser,outsider:AuthUser,colleague:number,controlPosition:number;
  const originalNow=liveClock.now;
  let session=0;
  const identity=(u:User):AuthUser=>({id:u.id,companyId:u.companyId,name:u.name,permissions:{isCompanyAdmin:false,allow:[],deny:[]}});
  const comm=(uid:number,role:string,amount:number,options:{date?:string;companyId?:number;commissionOnly?:boolean;platform?:string;sessionId?:number}={})=>ds.query(`INSERT INTO live_commission_records(company_id,session_id,user_id,role,session_date,final_sales_cents,rate_units,amount_cents,rule_version_id,rule_snapshot,approved_by,approved_at,platform) VALUES(?,?,?,?,?,100000,100,?,1,?,?,NOW(),?)`,[options.companyId??company,options.sessionId??++session,uid,role,options.date??'2026-11-02',amount,JSON.stringify({controlCommissionOnly:options.commissionOnly??false}),actor.id,options.platform??'douyin']);
  const wage=(role:string,amount:number,minutes:number)=>ds.query(`INSERT INTO live_wage_records(company_id,session_id,user_id,role,session_date,start_at,end_at,minutes,hourly_rate_cents,rate_source,amount_cents,approved_by,approved_at) VALUES(?,?,?,?,'2026-11-02','2026-11-02 10:00:00','2026-11-02 12:00:00',?,5000,'archive',?,?,NOW())`,[company,++session,actor.id,role,minutes,amount,actor.id]);
  beforeAll(async()=>{
    ds=await new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never).initialize();ledger=new LiveLedgerService(ds);
    const c=await ds.manager.save(Company,{code:randomBytes(8).toString('hex'),name:'个人收入公司',status:'active'});company=c.id;
    other=(await ds.manager.save(Company,{code:randomBytes(8).toString('hex'),name:'其他公司',status:'active'})).id;
    const position=async(workspaceType:Position['workspaceType'])=>(await ds.manager.save(Position,{companyId:company,name:workspaceType,workspaceType,status:'active'})).id;
    const ap=await position('live_anchor');controlPosition=await position('live_control');const op=await position('operations');
    const mk=async(name:string,extra:Partial<User>={})=>ds.manager.save(User,{companyId:company,name,account:randomBytes(8).toString('hex'),passwordHash:'test-only',status:'active',...extra});
    actor=identity(await mk('兼岗员工',{positionId:controlPosition,extraPositionIds:[ap,op]}));
    anchor=identity(await mk('兼职主播',{positionId:ap,employmentType:'part_time'}));outsider=identity(await mk('普通员工'));colleague=(await mk('同事')).id;
  },30000);
  beforeEach(async()=>{
    liveClock.now=()=>new Date('2026-11-02T08:00:00Z');
    await ds.query('DELETE FROM live_commission_records WHERE company_id IN (?,?)',[company,other]);await ds.query('DELETE FROM live_wage_records WHERE company_id=?',[company]);
    await ds.manager.update(User,{id:actor.id},{positionId:controlPosition,extraPositionIds:[]});
  });
  afterAll(async()=>{liveClock.now=originalNow;await ds?.destroy();});
  it('没有直播菜单权限也能看本人收入；兼职主播零收入显示真实0，普通无记录人员隐藏',async()=>{
    expect(await ledger.personalIncome(anchor)).toMatchObject({month:'2026-11',anchor:{visible:true,wageCents:0,commissionCents:0},control:{visible:false},operator:{visible:false}});
    const no=await ledger.personalIncome(outsider);expect([no.anchor.visible,no.control.visible,no.operator.visible]).toEqual([false,false,false]);
  });
  it('主播、中控工资与提成分项，多平台提成累加；运营原生及传统中控提成单列；管理员也不扩大范围',async()=>{
    const sameSession=++session;
    await comm(actor.id,'anchor',100,{sessionId:sameSession});await comm(actor.id,'anchor',200,{sessionId:sameSession,platform:'kuaishou'});
    await comm(actor.id,'control',400);await comm(actor.id,'operator',500);await comm(actor.id,'control',600,{commissionOnly:true});
    await wage('anchor',10000,120);await wage('control',7000,60);
    await comm(colleague,'anchor',999999);await comm(actor.id,'operator',999999,{companyId:other});
    const result=await ledger.personalIncome({...actor,permissions:{isCompanyAdmin:true,allow:[],deny:[]}});
    expect(result).toEqual({month:'2026-11',anchor:{visible:true,wageCents:10000,wageMinutes:120,commissionCents:300},control:{visible:true,wageCents:7000,wageMinutes:60,commissionCents:400},operator:{visible:true,commissionCents:1100}});
  });
  it('按北京时间进入新月份，使用直播日期范围排除上月和下月，不按审批日期串月',async()=>{
    liveClock.now=()=>new Date('2026-10-31T16:00:00Z');
    await comm(actor.id,'control',100,{date:'2026-10-31'});await comm(actor.id,'control',200,{date:'2026-11-01'});await comm(actor.id,'control',300,{date:'2026-11-30'});await comm(actor.id,'control',400,{date:'2026-12-01'});
    expect(await ledger.personalIncome(actor)).toMatchObject({month:'2026-11',control:{commissionCents:500}});
  });
  it('调岗后按审核快照保留本人历史归属，不把旧运营提成改成中控提成',async()=>{
    await comm(actor.id,'control',12345,{commissionOnly:true});
    await ds.manager.update(User,{id:actor.id},{positionId:null,extraPositionIds:[]});
    expect(await ledger.personalIncome(actor)).toMatchObject({anchor:{visible:false},control:{visible:false,commissionCents:0},operator:{visible:true,commissionCents:12345}});
  });
  it('汇总不受明细100条限制',async()=>{
    for(let i=0;i<105;i++)await comm(actor.id,'anchor',101);
    expect((await ledger.personalIncome(actor)).anchor.commissionCents).toBe(10605);
  });
});
