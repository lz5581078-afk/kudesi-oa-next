import { reportsLocked, primaryReport } from './live-checkin-core';
import { captureOrders } from './live-order-capture';
import { LiveOrderSource } from './live-order-source';
import { requireReports } from './live-review';
const at=(s:string)=>new Date(s.replace(' ','T')+'+08:00');
const session={id:7,start_text:'2026-11-01 10:00:00',channels_json:[{accountId:1,platform:'douyin',storeIds:[1],stores:[{id:1,name:'一店',jstShopId:'A'}]},{accountId:2,platform:'kuaishou',storeIds:[2],stores:[{id:2,name:'二店',jstShopId:'B'}]}]};
const order=(id:string,time:string)=>({orderId:id,innerId:id,orderTime:time,payTime:time,paid:true,amountCents:10000,status:'Confirmed',statusLabel:'已付款',cancelled:false});
describe('直播打卡与订单归集',()=>{
  it('试播缺报锁场后可进入异常审核，锁场前仍要求中控代报',()=>{
    const s={checkin_mode:1,trial_proxy:1,control_user_id:2};
    expect(()=>requireReports(s,[{role:'operator',reporter_user_id:3}])).toThrow(/中控/);
    expect(()=>requireReports({...s,report_locked_at:'2026-11-01 11:30:00'},[{role:'operator',reporter_user_id:3}])).not.toThrow();
    expect(()=>requireReports({...s,report_locked_at:'2026-11-01 11:30:00'},[])).toThrow(/中控/);
  });
  it('30分钟边界与任务延迟：不依赖定时任务是否已执行',()=>{const s={report_deadline:'2026-11-01 11:30:00'};expect(reportsLocked(s,at('2026-11-01 11:29:59'))).toBe(false);expect(reportsLocked(s,at('2026-11-01 11:30:00'))).toBe(true);expect(reportsLocked({report_locked_at:'2026-11-01 11:30:00'},at('2026-11-01 11:31:00'))).toBe(true);});
  it('优先运营，缺少运营时以主播报告审核',()=>{expect(primaryReport([{role:'anchor'},{role:'operator'},{role:'control'}])?.role).toBe('operator');expect(primaryReport([{role:'control'},{role:'anchor'}])?.role).toBe('anchor');});
  it('按成单时间半开区间归集、同店去重、跨店同号各自退款',async()=>{
    const source={turnoverOrders:jest.fn(async()=>({available:true,truncated:false,reason:'',orders:[order('SAME','2026-11-01 10:00:00'),order('SAME','2026-11-01 10:00:00'),order('BEFORE','2026-11-01 09:59:59'),order('AFTER','2026-11-01 11:00:00')]})),refunds:jest.fn(async(_c:number,shop:string)=>new Map([['SAME',{cents:shop==='A'?1000:3000,source:'refund',details:[]}]]))} as unknown as LiveOrderSource;
    const result=await captureOrders(source,3,session,'2026-11-01 11:00:00');expect(result.orders).toHaveLength(2);expect(result.sales).toBe(16000);expect(result.lines.map(l=>l.salesCents)).toEqual([9000,7000]);expect(result.orders.map(o=>o.accountIds)).toEqual([[1],[2]]);
  });
  it('退款缺失和订单截断必须失败，不返回零退款或部分业绩',async()=>{
    const source={turnoverOrders:async()=>({available:true,truncated:false,reason:'',orders:[order('A','2026-11-01 10:01:00')]}),refunds:async()=>new Map()} as unknown as LiveOrderSource;
    await expect(captureOrders(source,3,session,'2026-11-01 11:00:00')).rejects.toThrow(/未核实/);
    source.turnoverOrders=async()=>({available:true,truncated:true,reason:'分页未完成',orders:[]});await expect(captureOrders(source,3,session,'2026-11-01 11:00:00')).rejects.toThrow(/分页未完成/);
  });
});
