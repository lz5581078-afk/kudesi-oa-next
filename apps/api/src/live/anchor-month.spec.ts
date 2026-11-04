import { LIVE_DEFAULT_RULES,livePlatformCommissions } from '@kudesi/shared';
import { anchorWorkedTime,computeAnchorMonth,currentAnchorMonth } from './anchor-month.controller';
import type { Inputs } from './live-day-estimate';
const input=():Inputs=>({snapshots:[],reports:[],checkins:[],profiles:[],wages:[],commissions:[],versions:[{id:1,effectiveFrom:'2026-01-01',rules:LIVE_DEFAULT_RULES}],commissionOnly:new Set()});
const session=(id=1)=>({id,anchor_user_id:7,control_user_id:8,operator_user_id:9,room_id:1,room_name:'南7',session_day:'2026-11-03',start_text:'2026-11-03 10:00:00',end_text:'2026-11-03 11:00:00',status:'submitted',checkin_mode:0});
const now='2026-11-04 12:00:00';
it('北京时间自然月边界，月末不是滚动30天，12月正确跨年',()=>{
 expect(currentAnchorMonth(new Date('2026-10-31T16:00:00Z'))).toMatchObject({month:'2026-11',from:'2026-11-01',until:'2026-12-01'});
 expect(currentAnchorMonth(new Date('2026-12-31T15:59:59Z'))).toMatchObject({month:'2026-12',until:'2027-01-01'});
});
it('未审核场次纳入本人时长和多平台主播提成，不加中控运营提成；已审核直接取账本不重复预估',()=>{
 const x=input();x.snapshots=[{session_id:1,payload_json:{available:true,turnoverCents:150000,stores:[{storeId:11,available:true,platform:'douyin',turnoverCents:100000},{storeId:12,available:true,platform:'kuaishou',turnoverCents:50000}]}}];
 x.commissions=[{session_id:2,user_id:7,role:'anchor',amount_cents:2000},{session_id:2,user_id:8,role:'control',amount_cents:9000}];
 x.wages=[{session_id:2,user_id:7,role:'anchor',amount_cents:12000},{session_id:2,user_id:8,role:'control',amount_cents:8000}];
 const pending=livePlatformCommissions(LIVE_DEFAULT_RULES,[{platform:'douyin',salesCents:100000,adSpendCents:null},{platform:'kuaishou',salesCents:50000,adSpendCents:null}]).reduce((n,r)=>n+r.anchor.amountCents,0);
 const result=computeAnchorMonth([session(),{...session(2),status:'approved',final_sales_cents:200000}],x,7,now,true);
 expect(result.summary).toMatchObject({wageCents:12000,pendingWageSessions:1,sessionCount:2,minutes:120,turnoverCents:350000,commissionCents:pending+2000,estimatedSessions:1,missingCommissionSessions:0});
});
it('本人提前下播立即停止计时，未报下播自动锁场的时间异常不当成真实时长；审核修复后使用核定时间',()=>{
 const x=input(),s={...session(),checkin_mode:1,status:'live',end_text:null};
 x.checkins=[{session_id:1,user_id:7,role:'anchor',start_text:'2026-11-03 10:10:00',end_text:'2026-11-03 10:40:00'}];
 expect(anchorWorkedTime(s,x,now).minutes).toBe(30);
 x.checkins[0].confirmation_json={autoCheckout:{reason:'missing-report'}};
 expect(anchorWorkedTime(s,x,now).minutes).toBeNull();
 x.wages=[{session_id:1,user_id:7,role:'anchor',start_text:'2026-11-03 10:20:00',end_text:'2026-11-03 10:50:00'}];
 expect(anchorWorkedTime({...s,status:'approved'},x,now)).toMatchObject({minutes:30,startAt:'2026-11-03 10:20:00',endAt:'2026-11-03 10:50:00'});
});
it('未审核不漏算，缺金额和缺时长分别提示，查看者无提成权限时返回null而不是金额',()=>{
 const x=input(),r=computeAnchorMonth([{...session(),checkin_mode:1}],x,7,now,false);
 expect(r.summary).toMatchObject({sessionCount:1,minutes:0,wageCents:null,commissionCents:null,missingTimeSessions:1,missingSalesSessions:1});
 expect(r.sessions[0]).toMatchObject({minutes:null,turnoverCents:null,commissionCents:null,estimated:true});
});
it('不同人员不能串场；同场多岗位报告只取一个营业额，不相加',()=>{
 const x=input();x.reports=[{session_id:1,role:'anchor',sales_cents:5000},{session_id:1,role:'control',sales_cents:99000}];
 const r=computeAnchorMonth([session(),{...session(2),anchor_user_id:77}],x,7,now,true);
 expect(r.summary).toMatchObject({sessionCount:1,turnoverCents:5000});
});
