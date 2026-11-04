import { LIVE_DEFAULT_RULES, livePlatformCommissions } from '@kudesi/shared';
import { computeDayEstimate, dayEstimate } from './live-day-estimate';
import { type Row } from './live-core';
const now='2026-11-04 11:00:00';
const session=(extra:Row={})=>({id:1,status:'live',session_day:'2026-11-04',start_text:'2026-11-04 10:00:00',end_text:null,anchor_user_id:10,control_user_id:20,operator_user_id:30,checkin_mode:0,...extra});
const input=()=>({snapshots:[{session_id:1,payload_json:{available:true,turnoverCents:150000,stores:[{storeId:1,platform:'douyin',available:true,turnoverCents:100000},{storeId:2,platform:'kuaishou',available:true,turnoverCents:50000}]}}],reports:[] as Row[],checkins:[] as Row[],profiles:[{id:10,pay_type:'hourly',hourly_rate:5000},{id:20,pay_type:'hourly',hourly_rate:3000}],wages:[] as Row[],commissions:[] as Row[],versions:[{id:1,effectiveFrom:'2026-01-01',rules:LIVE_DEFAULT_RULES}],commissionOnly:new Set<number>()});

describe('全览按当前时刻预估当日营业额和费用',()=>{
 it('多平台分别计算提成，主播和中控工资每人每场只计一次，未审核也纳入',()=>{
  const x=input(), r=computeDayEstimate([session()],now,x,true);
  const commission=livePlatformCommissions(LIVE_DEFAULT_RULES,[{platform:'douyin',salesCents:100000,adSpendCents:null},{platform:'kuaishou',salesCents:50000,adSpendCents:null}]).reduce((n,p)=>n+p.anchor.amountCents+p.control.amountCents+p.operator.amountCents,0);
  expect(r).toMatchObject({turnoverCents:150000,missingSalesSessions:0,costs:{wageCents:8000,commissionCents:commission,totalCents:8000+commission,missingSessions:0}});
 });
 it('已结束场次按本人上下播时间计算，不随现在时间增长；未来下播不预付',()=>{
  const x=input();x.checkins=[{session_id:1,user_id:10,role:'anchor',start_text:'2026-11-04 10:30:00',end_text:'2026-11-04 10:50:00'},{session_id:1,user_id:20,role:'control',start_text:'2026-11-04 10:00:00',end_text:'2026-11-04 12:00:00'}];
  expect(computeDayEstimate([session({checkin_mode:1,status:'submitted',end_text:'2026-11-04 10:55:00'})],now,x,true).costs?.wageCents).toBe(4417);
 });
 it('已审核采用工资和提成账本，不叠加预估；最终核定营业额只算一份',()=>{
  const x=input();x.wages=[{session_id:1,role:'anchor',amount_cents:9000},{session_id:1,role:'control',amount_cents:4000}];x.commissions=[{session_id:1,amount_cents:1000},{session_id:1,amount_cents:500}];
  expect(computeDayEstimate([session({status:'approved',final_sales_cents:170000})],now,x,true)).toMatchObject({turnoverCents:170000,costs:{wageCents:13000,commissionCents:1500,totalCents:14500}});
 });
 it('运营兼任中控不重复运营提成；传统电商中控只提成不计工资',()=>{
  const x=input();x.commissionOnly.add(20);
  const r=computeDayEstimate([session({operator_user_id:20})],now,x,true);
  const expected=livePlatformCommissions(LIVE_DEFAULT_RULES,[{platform:'douyin',salesCents:100000,adSpendCents:null},{platform:'kuaishou',salesCents:50000,adSpendCents:null}]).reduce((n,p)=>n+p.anchor.amountCents+p.control.amountCents,0);
  expect(r.costs).toMatchObject({wageCents:5000,commissionCents:expected});
 });
 it('缺数据保留已统计金额并提示不完整，不把缺失工资/营业额当成完整零',()=>{
  const x=input();x.snapshots=[];x.profiles=[];
  expect(computeDayEstimate([session()],now,x,true)).toMatchObject({turnoverCents:0,missingSalesSessions:1,costs:{wageCents:0,commissionCents:0,missingSessions:1}});
 });
 it('漏报本人上播不按排班默认计薪，刚上播零分钟不报错',()=>{
  const x=input();
  expect(computeDayEstimate([session({checkin_mode:1})],now,x,true).costs).toMatchObject({wageCents:0,missingSessions:1});
  expect(computeDayEstimate([session({start_text:now})],now,x,true).costs).toMatchObject({wageCents:0,missingSessions:0});
 });
 it('已结束无快照时只采用一个主报告，多店合计后分平台；不累加主播和中控所报营业额',()=>{
  const x=input();x.snapshots=[];x.reports=[{session_id:1,role:'anchor',sales_cents:100000,store_lines_json:[{storeId:1,platform:'douyin',salesCents:100000,adSpendCents:0}]},{session_id:1,role:'control',sales_cents:200000,store_lines_json:[{storeId:1,platform:'douyin',salesCents:200000,adSpendCents:5000}]}];
  expect(computeDayEstimate([session({status:'submitted',end_text:now})],now,x,true).turnoverCents).toBe(100000);
 });
 it('没有全员提成权限时不查询工资/时薪和提成，不返回费用',async()=>{
  const em={query:jest.fn().mockResolvedValue([])};
  const result=await dayEstimate(em as never,{companyId:7,canViewAll:false} as never,[session()],now);
  expect(result.costs).toBeNull();expect(result.adSpend).toBeNull();expect(em.query).toHaveBeenCalledTimes(2);
  for(const [sql,params]of em.query.mock.calls){expect(sql).toMatch(/company_id=\?/);expect(params).toEqual([7,[1]]);expect(sql).not.toMatch(/live_wage|live_commission|FROM users/);}
 });
 it('试播优先采用本场时薪，缺少本场试播时薪时不挪用旧档案工资',()=>{
  const x=input();
  expect(computeDayEstimate([session({scheduled_trial_rate:8000,trial_proxy:1})],now,x,true).costs?.wageCents).toBe(11000);
  expect(computeDayEstimate([session({trial_proxy:1})],now,x,true).costs).toMatchObject({wageCents:3000,missingSessions:1});
 });
 it('未审核投流只取中控的一份合计，不重复累加主播和运营报告',()=>{
  const x=input();x.reports=[{session_id:1,role:'anchor',ad_spend_cents:9999},{session_id:1,role:'control',ad_spend_cents:3500},{session_id:1,role:'operator',ad_spend_cents:9999}];
  expect(computeDayEstimate([session()],now,x,true).adSpend).toEqual({totalCents:3500,missingSessions:0});
 });
 it('审核后的投流按平台去重，不把主播中控运营三份账本重复累加',()=>{
  const x=input();x.reports=[{session_id:1,role:'control',ad_spend_cents:300}];
  x.commissions=['anchor','control','operator'].flatMap(()=>[{session_id:1,platform:'douyin',ad_spend_cents:2000,amount_cents:100},{session_id:1,platform:'kuaishou',ad_spend_cents:1000,amount_cents:100}]);
  expect(computeDayEstimate([session({status:'approved',final_sales_cents:150000})],now,x,true).adSpend).toEqual({totalCents:3000,missingSessions:0});
 });
 it('未填报与明确填零区分，投流独立统计不重复加到工资提成费用',()=>{
  const x=input();
  expect(computeDayEstimate([session()],now,x,true).adSpend).toEqual({totalCents:0,missingSessions:1});
  x.reports=[{session_id:1,role:'control',ad_spend_cents:0}];
  const zero=computeDayEstimate([session()],now,x,true);
  expect(zero.adSpend).toEqual({totalCents:0,missingSessions:0});
  x.reports[0].ad_spend_cents=500;
  const paid=computeDayEstimate([session()],now,x,true);
  expect(paid.adSpend?.totalCents).toBe(500);expect(paid.costs?.totalCents).toBe(zero.costs?.totalCents);
  expect(computeDayEstimate([session()],now,x,false).adSpend).toBeNull();
 });
 it('未来日期的记录不提前计入当前已发生金额',()=>{
  expect(computeDayEstimate([session({start_text:'2026-11-05 10:00:00'})],now,input(),true)).toMatchObject({sessions:0,turnoverCents:0,costs:{totalCents:0}});
 });
 it('空日期为零且不触发任何订单或数据库查询',async()=>{
  const em={query:jest.fn()};
  expect(await dayEstimate(em as never,{companyId:7,canViewAll:true} as never,[],now)).toMatchObject({sessions:0,turnoverCents:0,costs:{totalCents:0,missingSessions:0}});
  expect(em.query).not.toHaveBeenCalled();
 });
});
