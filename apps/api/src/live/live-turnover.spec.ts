import { LiveTurnoverService } from './live-turnover.service';
import * as access from './live-access';
import * as core from './live-core';
import { LiveOrderSource, LiveTurnoverOrder } from './live-order-source';
import { JushuitanOrderSource } from './jushuitan-order-source';
import { JushuitanClient } from '../integrations/jushuitan.client';

const user = { id:1,companyId:10,name:'管理员',permissions:{isCompanyAdmin:true,allow:[],deny:[]} };
const at = (s:string) => new Date(s.replace(' ','T')+'+08:00');
const row = { id:7,company_id:10,room_name:'南1',start_text:'2026-11-02 10:00:00',end_text:null,status:'live',store_id:3,store_name:'店铺A',jst_shop_id:'101',channels_json:null };
const order = (id:string,time='2026-11-02 10:30:00',amountCents=10000):LiveTurnoverOrder=>({orderId:id,innerId:id,orderTime:time,payTime:time,paid:true,cancelled:false,amountCents,status:'Sent',statusLabel:'已发货'});

describe('本场营业额',()=>{
 let service:LiveTurnoverService, source:{turnoverOrders:jest.Mock;refunds:jest.Mock}, read:jest.SpyInstance;
 beforeEach(()=>{
  jest.spyOn(access,'loadLiveAccess').mockResolvedValue({companyId:10,canView:true} as never);
  read=jest.spyOn(core,'sessionRow').mockResolvedValue({...row});
  jest.spyOn(core.liveClock,'now').mockReturnValue(at('2026-11-02 11:00:00'));
  source={turnoverOrders:jest.fn().mockResolvedValue({available:true,reason:'',truncated:false,orders:[]}),refunds:jest.fn().mockImplementation(async(_c,_s,orders)=>new Map(orders.map((o:LiveTurnoverOrder)=>[o.orderId,{cents:0}])))};
  service=new LiveTurnoverService({manager:{}} as never,source as unknown as LiveOrderSource);
 });
 afterEach(()=>jest.restoreAllMocks());
 it('先按成单时间筛选，再仅核对本场订单售后；历史成单本场退款、跨场边界不混入',async()=>{
  source.turnoverOrders.mockResolvedValue({available:true,truncated:false,orders:[order('old','2026-11-01 10:30:00'),order('start','2026-11-02 10:00:00'),order('partial'),order('full'),order('boundary','2026-11-02 11:00:00'),{...order('cancel'),cancelled:true},{...order('unpaid'),paid:false}]});
  source.refunds.mockImplementation(async(_c,_s,orders)=>new Map(orders.map((o:LiveTurnoverOrder)=>[o.orderId,{cents:o.orderId==='partial'?2500:o.orderId==='full'?10000:0}])));
  const result=await service['calculate'](10,await core.sessionRow({} as never,10,7));
  expect(source.refunds.mock.calls[0][2].map((o:LiveTurnoverOrder)=>o.orderId)).toEqual(['start','partial','full']);
  expect(result).toMatchObject({available:true,orderCount:2,turnoverCents:17500,grossCents:30000,refundCents:12500,endAt:'2026-11-02 11:00:00'});
 });
 it('多账号同店铺只统计一次；部分店铺失败时合计为空，不能把漏查当零',async()=>{
  read.mockResolvedValue({...row,channels_json:[{platform:'douyin',stores:[{id:3,name:'A',jstShopId:'101'},{id:4,name:'B',jstShopId:'102'}]},{platform:'douyin',stores:[{id:3,name:'A',jstShopId:'101'},{id:5,name:'A的旧档案',jstShopId:'101'}]}]});
  source.turnoverOrders.mockResolvedValueOnce({available:true,orders:[order('A')],truncated:false}).mockResolvedValueOnce({available:false,reason:'授权过期',orders:[],truncated:false});
  const d=await service['calculate'](10,await core.sessionRow({} as never,10,7));expect(source.turnoverOrders).toHaveBeenCalledTimes(2);expect(d).toMatchObject({available:false,turnoverCents:null,orderCount:null});expect(d.stores[0].turnoverCents).toBe(10000);expect(d.stores[1].reason).toBe('授权过期');
 });
 it('退款缺失、分页不完整都不显示误导的零；真正无有效订单显示0',async()=>{
  source.turnoverOrders.mockResolvedValueOnce({available:true,truncated:true,orders:[]});expect((await service['calculate'](10,await core.sessionRow({} as never,10,7))).turnoverCents).toBeNull();
  jest.spyOn(core.liveClock,'now').mockReturnValue(at('2026-11-02 11:00:11'));
  source.turnoverOrders.mockResolvedValueOnce({available:true,truncated:false,orders:[order('1')]});source.refunds.mockResolvedValueOnce(new Map());expect((await service['calculate'](10,await core.sessionRow({} as never,10,7))).available).toBe(false);
  jest.spyOn(core.liveClock,'now').mockReturnValue(at('2026-11-02 11:00:22'));
  expect(await service['calculate'](10,await core.sessionRow({} as never,10,7))).toMatchObject({available:true,orderCount:0,turnoverCents:0});
 });
 it('读取接口只返回共享快照并逐次鉴权，不触发聚水潭查询',async()=>{
  const query=jest.fn().mockResolvedValue([{payload_json:{sessionId:7,available:true,turnoverCents:5000},locked_at:'2026-11-02 11:00:00',last_error:null}]);
  service=new LiveTurnoverService({manager:{},query} as never,source as unknown as LiveOrderSource);
  expect(await service.read(user,7)).toMatchObject({turnoverCents:5000,locked:true});
  await service.read(user,7);expect(source.turnoverOrders).not.toHaveBeenCalled();
  expect(query).toHaveBeenLastCalledWith(expect.any(String),[10,7]);
  jest.spyOn(access,'loadLiveAccess').mockResolvedValue({companyId:10,canView:false} as never);
  await expect(service.read(user,7)).rejects.toThrow(/权限/);
 });
 it('没有浏览器访问也在启动时及定时扫描，关闭后停止',async()=>{
  const env=process.env.NODE_ENV, off=process.env.LIVE_TURNOVER_WORKER;
  process.env.NODE_ENV='development';delete process.env.LIVE_TURNOVER_WORKER;
  jest.useFakeTimers();
  const scan=jest.spyOn(service,'scan').mockResolvedValue(0);
  try{
   service.onModuleInit();await jest.advanceTimersByTimeAsync(0);expect(scan).toHaveBeenCalledTimes(1);
   await jest.advanceTimersByTimeAsync(15_000);expect(scan).toHaveBeenCalledTimes(2);
   service.onModuleDestroy();await jest.advanceTimersByTimeAsync(30_000);expect(scan).toHaveBeenCalledTimes(2);
  }finally{service.onModuleDestroy();jest.useRealTimers();if(env===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=env;if(off===undefined)delete process.env.LIVE_TURNOVER_WORKER;else process.env.LIVE_TURNOVER_WORKER=off;}
 });
});

describe('聚水潭成单时间来源',()=>{
 const config={appKey:'fixture-app',appSecret:'fixture-secret',accessToken:'fixture-token',baseUrl:'https://openapi.jushuitan.com/',coid:1};
 const session={id:7,shopId:'101',startAt:'2026-11-02 10:00:00',endAt:'2026-11-02 11:00:00'};
 const raw=(id:string,date:string,extra={})=>({shop_id:101,so_id:id,o_id:id,order_date:date,pay_date:'2026-11-02 10:30:00',paid_amount:'100',status:'Sent',...extra});
 afterEach(()=>jest.restoreAllMocks());
 it('date_type=2并二次核对order_date，不用付款、修改或退款时间归属；边界半开避免重复',async()=>{
  const pages=jest.spyOn(JushuitanClient.prototype,'pages').mockImplementation(async(path)=>path==='/open/shops/query'?[{shop_id:101,co_id:1}]:[raw('old','2026-11-01 12:00:00'),raw('first',session.startAt),raw('second',session.endAt)]);
  const source=new JushuitanOrderSource({jst:async()=>config} as never);
  const d=await source.turnoverOrders(10,session);expect(d.available).toBe(true);expect(d.orders.map(o=>o.orderId)).toEqual(['first']);
  expect(pages).toHaveBeenCalledWith('/open/orders/single/query',expect.objectContaining({date_type:2,modified_begin:session.startAt,modified_end:session.endAt}),'orders',200);
 });
 it('只用实付金额，支付节点仅统计订单支付；不拿应付金额冒充实付',async()=>{
  const pages=jest.spyOn(JushuitanClient.prototype,'pages').mockImplementation(async(path)=>path==='/open/shops/query'?[{shop_id:101,co_id:1}]:[raw('x',session.startAt,{paid_amount:undefined,pay_amount:999,pay_date:null,pays:[{amount:80,is_order_pay:true},{amount:20,is_order_pay:false}]})]);
  const source=new JushuitanOrderSource({jst:async()=>config} as never);
  expect((await source.turnoverOrders(10,session)).orders[0]).toMatchObject({amountCents:8000,paid:true});
  pages.mockImplementation(async(path)=>path==='/open/shops/query'?[{shop_id:101,co_id:1}]:[raw('x',session.startAt,{paid_amount:undefined,pay_amount:999})]);
  expect((await source.turnoverOrders(10,session)).available).toBe(false);
 });
 it('跨店数据、重复/缺少成单时间、分页异常均拒绝，避免误报',async()=>{
  const pages=jest.spyOn(JushuitanClient.prototype,'pages');const source=new JushuitanOrderSource({jst:async()=>config} as never);
  for(const rows of [[raw('x',session.startAt,{shop_id:999})],[raw('x',session.startAt),raw('x',session.startAt)],[raw('x','')]]){
   pages.mockImplementation(async(path)=>path==='/open/shops/query'?[{shop_id:101,co_id:1}]:rows);
   expect((await source.turnoverOrders(10,session)).available).toBe(false);
  }
  pages.mockRejectedValue(new Error('分页超限'));expect((await source.turnoverOrders(10,session)).available).toBe(false);
 });
});
