import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Company, User } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { buildServices } from '../test-support';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { FlowService } from '../flow/flow.service';
import { LiveOrderSource } from './live-order-source';
import { LiveSettlementService } from './live-settlement.service';
import { assertCommissionDate, commissionAvailableOn } from './live-payroll-core';
import { approveSettlement, markSubmitted, validateSettlementSources } from './live-settlement-core';
import { closedDay, liveClock } from './live-core';

const suite=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
const instant=(s:string)=>new Date(`${s}T00:00:00+08:00`);
describe('提成可结算日',()=>{
  it('次月10日北京时间边界、跨年及闰年',()=>{
    expect(commissionAvailableOn('2026-12-31')).toBe('2027-01-10');
    expect(commissionAvailableOn('2028-02-29')).toBe('2028-03-10');
    expect(()=>assertCommissionDate(['2026-10-01'],new Date('2026-11-09T15:59:59Z'))).toThrow(/次月10日/);
    expect(()=>assertCommissionDate(['2026-10-31'],new Date('2026-11-09T16:00:00Z'))).not.toThrow();
  });
});
suite('独立结算真实MySQL',()=>{
  let ds:DataSource,service:LiveSettlementService,admin:AuthUser,person:number,other:number,session:number,foreign:AuthUser;
  const now=liveClock.now;
  const source={status:jest.fn(async()=>({ready:false,message:'退款接口不可用'})),refunds:jest.fn()} as unknown as LiveOrderSource;
  beforeAll(async()=>{
    ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME}),migrationsRun:true} as never);await ds.initialize();
    service=new LiveSettlementService(ds,{} as FlowService,source);
  });
  afterAll(async()=>{liveClock.now=now;await ds?.destroy();});
  beforeEach(async()=>{
    liveClock.now=()=>instant('2026-11-10');jest.clearAllMocks();
    const c=await ds.manager.save(Company,ds.manager.create(Company,{code:randomUUID().slice(0,16),name:'独立结算测试',status:'active'}));
    const mk=async(name:string)=> (await ds.manager.save(User,ds.manager.create(User,{companyId:c.id,account:randomUUID(),passwordHash:'x',name,status:'active'}))).id;
    person=await mk('主播甲');other=await mk('主播乙');
    admin={id:await mk('人事'),companyId:c.id,name:'人事',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    foreign={...admin,companyId:c.id+100000};
    const inserted=await ds.query("INSERT INTO live_sessions(company_id,room_id,room_name,anchor_user_id,control_user_id,douyin_account_id,douyin_account_name,session_date,start_at,end_at,status,started_by,started_role,report_source,manual_reason) VALUES(?,1,'直播间',?,?,1,'账号','2026-10-15','2026-10-15 10:00:00','2026-10-15 11:00:00','approved',?,'anchor','manual','人工核定')",[c.id,person,other,admin.id]);session=Number(inserted.insertId);
    for(const [userId,role] of [[person,'anchor'],[other,'control']] as const){
      await ds.query("INSERT INTO live_wage_records(company_id,session_id,user_id,role,session_date,start_at,end_at,minutes,hourly_rate_cents,rate_source,amount_cents,approved_by,approved_at) VALUES(?,?,?,?,'2026-10-15','2026-10-15 10:00:00','2026-10-15 11:00:00',60,5000,'archive',5000,?,'2026-10-16')",[c.id,session,userId,role,admin.id]);
      await ds.query("INSERT INTO live_commission_records(company_id,session_id,user_id,role,session_date,final_sales_cents,rate_units,amount_cents,rule_version_id,rule_snapshot,approved_by,approved_at) VALUES(?,?,?,?,'2026-10-15',10000,1000,1000,1,'{}',?,'2026-10-16')",[c.id,session,userId,role,admin.id]);
    }
  });
  const make=(kind:'wage'|'commission',userIds:number[]=[])=>service.generate(admin,'2026-10',undefined,{kind,userIds});
  async function approve(id:number){
    await ds.transaction(async em=>{await markSubmitted(em,{companyId:admin.companyId,actorId:admin.id,now:liveClock.now()},id,123);await approveSettlement(em,{companyId:admin.companyId,actorId:admin.id,runId:123,now:liveClock.now()},id);});
  }
  it('工资不查询退款、单人独立、同场提成另结、不同人日期重叠允许',async()=>{
    const a=await make('wage',[person]),b=await make('wage',[other]),c=await make('commission',[person]);
    expect((await service.detail(admin,a.id))).toMatchObject({wageTotalCents:5000,commissionTotalCents:0,recordCount:1});
    expect((await service.detail(admin,c.id))).toMatchObject({wageTotalCents:0,commissionTotalCents:1000});
    expect(new Set([a.id,b.id,c.id]).size).toBe(3);expect(source.status).not.toHaveBeenCalled();
    await approve(a.id);expect(await closedDay(ds.manager,admin.companyId,'2026-10-15')).toBe(false);expect(await closedDay(ds.manager,admin.companyId,'2026-10-15',{sessionId:session})).toBe(true);
  });
  it('未到10日工资可结、提成不可结，10日及更早月份可补结',async()=>{
    liveClock.now=()=>instant('2026-11-09');await make('wage',[person]);await expect(make('commission',[person])).rejects.toThrow(/次月10日/);
    liveClock.now=()=>instant('2026-11-10');const a=await make('commission',[person]);expect(a.id).toBeGreaterThan(0);
    liveClock.now=()=>instant('2027-02-01');expect((await make('commission',[other])).id).toBeGreaterThan(a.id);
  });
  it('并发和日期交叉不重复占用；草稿作废保留明细并释放',async()=>{
    const results=await Promise.allSettled([make('wage',[person]),make('wage',[person])]);
    const [n]=await ds.query('SELECT COUNT(*) n FROM live_settlement_lines WHERE company_id=? AND wage_record_id IS NOT NULL',[admin.companyId]);expect(Number(n.n)).toBe(1);
    const done=results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<{id:number}>;await service.void(admin,done.value.id,'选错范围');
    expect((await service.detail(admin,done.value.id)).lines).toHaveLength(1);
    expect((await make('wage',[person])).id).not.toBe(done.value.id);
    await expect(service.generate(admin,'',undefined,{kind:'wage',userIds:[person],from:'2026-10-14',to:'2026-10-16'})).rejects.toThrow(/被占用/);
  });
  it('数据变化阻止提交；旧结算单明细也参与防重',async()=>{
    const a=await make('wage',[person]);await ds.query('UPDATE live_wage_records SET amount_cents=6000 WHERE company_id=? AND user_id=?',[admin.companyId,person]);
    const [row]=await ds.query("SELECT *,DATE_FORMAT(period_from,'%Y-%m-%d') period_from,DATE_FORMAT(period_to,'%Y-%m-%d') period_to FROM live_settlements WHERE id=?",[a.id]);
    await expect(validateSettlementSources(ds.manager,admin.companyId,row)).rejects.toThrow(/变化/);
    await ds.query("UPDATE live_settlements SET source_fingerprint=NULL,scope_key='legacy' WHERE id=?",[a.id]);await expect(make('wage',[person])).rejects.toThrow(/被占用/);
  });
  it('历史快照、付款按人限额、请求幂等与公司隔离',async()=>{
    const a=await make('wage',[person]);await approve(a.id);
    await ds.query("UPDATE users SET name='改名' WHERE company_id=? AND id=?",[admin.companyId,person]);expect((await service.detail(admin,a.id)).lines[0].userName).toBe('主播甲');
    const input={userId:person,amountCents:3000,reference:'银行流水123',requestKey:randomUUID()};await service.payment(admin,a.id,input);await service.payment(admin,a.id,input);
    expect((await service.detail(admin,a.id)).paidTotalCents).toBe(3000);
    await expect(service.payment(admin,a.id,{...input,requestKey:randomUUID(),reference:'银行流水456',amountCents:2001})).rejects.toThrow(/超过/);
    await expect(service.detail(foreign,a.id)).rejects.toThrow(/不存在/);await expect(make('wage',[99999999])).rejects.toThrow(/本公司/);
    await expect(service.void(admin,a.id,'修改')).rejects.toThrow(/只能作废/);
  });
  it('退款追扣另建审批单、凭证防重、金额上限及追回留痕',async()=>{
    const a=await make('commission',[person]);await approve(a.id);const d=await service.detail(admin,a.id);
    const input={lineId:d.lines[0].id,amountCents:-300,reference:'退款R1',reason:'结算后退款'};
    const b=await service.adjustment(admin,a.id,input);expect((await service.adjustment(admin,a.id,input)).id).toBe(b.id);
    expect((await service.detail(admin,a.id)).payableTotalCents).toBe(1000);
    await expect(service.adjustment(admin,a.id,{...input,reference:'退款R2',amountCents:-701})).rejects.toThrow(/超过/);
    await expect(service.payment(admin,b.id,{userId:person,amountCents:-300,reference:'退回凭证',requestKey:randomUUID()})).rejects.toThrow(/已结算/);
    await approve(b.id);await service.payment(admin,b.id,{userId:person,amountCents:-300,reference:'退回凭证',requestKey:randomUUID()});expect((await service.detail(admin,b.id)).paidTotalCents).toBe(-300);
  });
  it('工资与调整沿用统一流程提交和审批完成',async()=>{
    const deps=buildServices(ds),flow=new FlowService(ds,deps.resources,new FinanceDocumentsService(ds),undefined,undefined,undefined,source);
    const svc=new LiveSettlementService(ds,flow,source);
    await flow.saveDraft(admin,'live-settlement',[
      {key:'apply',name:'提交',type:'submit',assignee:{source:'requester'}},
      {key:'approve',name:'审批',type:'approval',assignee:{source:'employee',id:admin.id}},
      {key:'end',name:'结束',type:'end'},
    ],[]);await flow.publish(admin,'live-settlement');
    const draft=await make('wage',[person]);await expect(svc.submit(admin,draft.id,999)).rejects.toThrow(/重新核对/);const submitted=await svc.submit(admin,draft.id);
    let f=await flow.detail(admin,submitted.runId);
    await flow.pass(admin,f.id,{revision:f.revision,stepId:f.activeStep!.id});
    expect((await svc.detail(admin,draft.id)).status).toBe('approved');
    const original=(await svc.detail(admin,draft.id)).lines[0];
    const correction=await svc.adjustment(admin,draft.id,{lineId:original.id,kind:'wage',amountCents:-100,reference:'工资更正',reason:'审核差错'});
    const started=await svc.submit(admin,correction.id);f=await flow.detail(admin,started.runId);
    await flow.pass(admin,f.id,{revision:f.revision,stepId:f.activeStep!.id});
    expect((await svc.detail(admin,correction.id)).status).toBe('approved');
  });

});
