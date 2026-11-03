import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoomSessionAccounts, RoomSessionPanel } from './RoomSessionPanel';
import { liveApi } from './liveApi';
vi.mock('./liveApi',()=>({liveApi:{turnover:vi.fn()}}));
const session={id:7,startAt:'2026-11-02 10:00:00',plannedEnd:'2026-11-02 12:00:00',anchor:{id:1,name:'主播甲'},control:{id:2,name:'中控乙'},operator:{id:3,name:'运营丙'},douyinAccount:{id:4,name:'账号'}};
const data={sessionId:7,roomName:'南1',startAt:session.startAt,endAt:'2026-11-02 11:00:00',live:true,queriedAt:'2026-11-02 11:00:02',available:true,reason:'',orderCount:3,turnoverCents:18000,grossCents:20000,refundCents:2000,stores:[{storeId:1,storeName:'抖音店A',platform:'douyin',available:true,reason:'',orderCount:2,turnoverCents:13000,grossCents:15000,refundCents:2000},{storeId:2,storeName:'快手店B',platform:'kuaishou',available:true,reason:'',orderCount:1,turnoverCents:5000,grossCents:5000,refundCents:0}]};
beforeEach(()=>{vi.mocked(liveApi.turnover).mockResolvedValue(data);});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.resetAllMocks();});
it('本场金额可点开，按店铺展示单数金额与合计，明确成单时间口径',async()=>{
 render(<RoomSessionPanel session={session} day="2026-11-02" now="2026-11-02 11:00:00"/>);
 await screen.findByText('¥180.00');fireEvent.click(screen.getByRole('button',{name:'查看本场营业额'}));
 expect(await screen.findByRole('dialog')).toBeTruthy();
 for(const text of ['抖音店A','快手店B','2 单','1 单','¥130.00','¥50.00'])expect(screen.getByText(text)).toBeTruthy();
 expect(screen.getByText(/历史订单在此期间退款不计入/)).toBeTruthy();expect(screen.getByText('合计')).toBeTruthy();
});
it('未开播不请求订单；读取失败与部分店铺失败不显示为0元',async()=>{
 const {rerender}=render(<RoomSessionPanel session={null} day="2026-11-02" now="2026-11-02 11:00:00"/>);
 expect(liveApi.turnover).not.toHaveBeenCalled();expect((screen.getByRole('button',{name:'查看本场营业额'}) as HTMLButtonElement).disabled).toBe(true);
 vi.mocked(liveApi.turnover).mockResolvedValue({...data,available:false,turnoverCents:null,orderCount:null,reason:'部分店铺查询失败',stores:[{...data.stores[0],available:false,turnoverCents:null,orderCount:null,reason:'授权过期'}]});
 rerender(<RoomSessionPanel session={session} day="2026-11-02" now="2026-11-02 11:00:00"/>);await screen.findByText('暂不可用');fireEvent.click(screen.getByRole('button',{name:'查看本场营业额'}));expect(screen.getByText('授权过期')).toBeTruthy();expect(screen.queryByText('¥0.00')).toBeNull();
});
it('场次变化丢弃旧请求结果，结束后保持实际下播时间和时长',async()=>{
 let resolve!:(v:typeof data)=>void;
 vi.mocked(liveApi.turnover).mockReturnValueOnce(new Promise(r=>{resolve=r;})).mockResolvedValue({...data,sessionId:8,turnoverCents:9000});
 const {rerender}=render(<RoomSessionPanel session={session} day="2026-11-02" now="2026-11-02 11:00:00"/>);
 rerender(<RoomSessionPanel session={{...session,id:8,endAt:'2026-11-02 10:40:00'}} day="2026-11-02" now="2026-11-02 15:00:00"/>);
 await screen.findByText('¥90.00');resolve(data);await waitFor(()=>expect(screen.queryByText('¥180.00')).toBeNull());expect(screen.getByText('40 分')).toBeTruthy();expect(screen.getByText('已下播')).toBeTruthy();
});
it('直播查询完成一分钟后再查，慢请求不叠加；下播立即查且保留下播后的刷新周期',async()=>{
 vi.useFakeTimers();
 vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
 let resolve!:(v:typeof data)=>void;
 vi.mocked(liveApi.turnover).mockReturnValueOnce(new Promise(r=>{resolve=r;})).mockResolvedValue(data);
 const {rerender,unmount}=render(<RoomSessionPanel session={session} day="2026-11-02" now="2026-11-02 11:00:00"/>);
 expect(liveApi.turnover).toHaveBeenCalledTimes(1);
 await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
 expect(liveApi.turnover).toHaveBeenCalledTimes(1);
 await act(async()=>{resolve(data);});
 await act(async()=>{await vi.advanceTimersByTimeAsync(59_999);});
 expect(liveApi.turnover).toHaveBeenCalledTimes(1);
 await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
 expect(liveApi.turnover).toHaveBeenCalledTimes(2);
 await act(async()=>{rerender(<RoomSessionPanel session={{...session,endAt:'2026-11-02 11:00:00'}} day="2026-11-02" now="2026-11-02 11:00:00"/>);});
 expect(liveApi.turnover).toHaveBeenCalledTimes(3);
 await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});
 expect(liveApi.turnover).toHaveBeenCalledTimes(4);
 unmount();
 await vi.advanceTimersByTimeAsync(60_000);
 expect(liveApi.turnover).toHaveBeenCalledTimes(4);
});

it('姓名后小字分别显示已报未报，缺少历史记录不误判，无人员不显示状态',async()=>{
 const {rerender}=render(<RoomSessionPanel session={{...session,startReports:{anchor:false,control:true,operator:false}}} day="2026-11-02" now="2026-11-02 11:00:00"/>);
 expect(screen.getByLabelText('主播甲：未报上播').textContent).toBe('未报');expect(screen.getByLabelText('中控乙：已报上播').textContent).toBe('已报');expect(screen.getByLabelText('运营丙：未报上播').textContent).toBe('未报');
 rerender(<RoomSessionPanel session={{...session,startReports:{anchor:null,control:true,operator:null},operator:null}} day="2026-11-02" now="2026-11-02 11:00:00"/>);
 expect(screen.getByLabelText('主播甲：未记录').textContent).toBe('未记录');expect(screen.queryByLabelText('运营丙：未记录')).toBeNull();
 await screen.findByText('¥180.00');
});
it('显示实际多账号完整名称，历史账号回退，未开播不冒用下一场账号',()=>{
 const {rerender}=render(<RoomSessionAccounts session={{...session,accounts:[{id:8,name:'实际抖音账号完整名称',platform:'douyin'},{id:9,name:'实际快手直播号',platform:'kuaishou'}]}}/>);
 expect(screen.getByLabelText('本场实际直播号：实际抖音账号完整名称 / 实际快手直播号')).toBeTruthy();expect(screen.queryByText('账号')).toBeNull();
 rerender(<RoomSessionAccounts session={{...session,endAt:'2026-11-02 11:00:00'}}/>);expect(screen.getByText('上场直播号')).toBeTruthy();expect(screen.getByText('账号')).toBeTruthy();
 rerender(<RoomSessionAccounts session={null}/>);expect(screen.queryByText('账号')).toBeNull();
});

it('下播最终快照锁定后不再轮询或因页面重新可见而刷新，不显示更新时间',async()=>{
 vi.useFakeTimers();vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
 vi.mocked(liveApi.turnover).mockResolvedValue({...data,live:false,locked:true});
 await act(async()=>{render(<RoomSessionPanel session={{...session,endAt:'2026-11-02 11:00:00'}} day="2026-11-02" now="2026-11-02 12:00:00"/>);});
 expect(screen.getByText('本场营业额已锁定')).toBeTruthy();expect(screen.queryByText(/更新于/)).toBeNull();
 await act(async()=>{await vi.advanceTimersByTimeAsync(120_000);document.dispatchEvent(new Event('visibilitychange'));});
 expect(liveApi.turnover).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button',{name:'查看本场营业额'}));
 expect(screen.queryByRole('button',{name:'刷新营业额'})).toBeNull();
});
