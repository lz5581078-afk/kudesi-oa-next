import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import { AnchorMonthPanel } from './AnchorMonthPanel';
import { AnchorMonthSelect } from './AnchorMonthSelect';
import { anchorMonthApi,type AnchorMonthData } from './anchorMonthApi';
vi.mock('./SessionDetailDialog',()=>({SessionDetailDialog:({id,onClose}:{id:number;onClose:()=>void})=><div role="dialog" aria-label="场次详情">场次 {id}<button onClick={onClose}>关闭详情</button></div>}));
const data=(id=7):AnchorMonthData=>({month:'2026-11',asOf:'2026-11-04 14:00:00',canViewCommission:true,canOpenSession:true,items:[{userId:id,name:'主播甲',employmentType:'part_time',summary:{wageCents:12000,pendingWageSessions:1,sessionCount:2,minutes:120,turnoverCents:1860000,commissionCents:93000,missingTimeSessions:0,missingSalesSessions:0,missingCommissionSessions:0,estimatedSessions:1},sessions:[{id:11,date:'2026-11-03',roomId:1,roomName:'南7',status:'submitted',startAt:'2026-11-03 10:00:00',endAt:'2026-11-03 12:00:00',minutes:120,turnoverCents:1860000,commissionCents:93000,estimated:true}]}]});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('同一资料组件展示自然月汇总、未审核场次和每场实际时间，并可查看详情',async()=>{
 const read=vi.spyOn(anchorMonthApi,'read').mockResolvedValue(data()),overlay=vi.fn();
 render(<AnchorMonthPanel userId={7} onOverlayChange={overlay}/>);
 await screen.findByText('2026-11');expect(read).toHaveBeenCalledWith(7);expect(screen.getByText('¥120.00')).toBeTruthy();expect(screen.getByText('10:00 至 12:00')).toBeTruthy();expect(screen.getByText(/包含未审核场次/)).toBeTruthy();expect(screen.getAllByText('¥18,600.00')).toHaveLength(2);expect(screen.getByText('未审核 · 预估')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'场次详情'}));await screen.findByRole('dialog',{name:'场次详情'});expect(overlay).toHaveBeenCalledWith(true);
 fireEvent.click(screen.getByRole('button',{name:'关闭详情'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
});
it('未知金额不显示为零，无提成权限不能显示金额，读取失败可刷新',async()=>{
 const x=data();x.canViewCommission=false;x.items[0].summary.commissionCents=null;x.items[0].summary.missingSalesSessions=1;x.items[0].sessions![0].turnoverCents=null;
 vi.spyOn(anchorMonthApi,'read').mockRejectedValueOnce(new Error('网络失败')).mockResolvedValue(x);
 render(<AnchorMonthPanel userId={7}/>);await screen.findByText(/本月直播资料读取失败|网络失败/);fireEvent.click(screen.getByRole('button',{name:'刷新业绩'}));await screen.findByText(/1场营业额待补充/);expect(screen.getAllByText('无查看权限')).toHaveLength(4);expect(screen.queryByText('¥930.00')).toBeNull();expect(screen.getByText('待补充')).toBeTruthy();
});
it('人员变化时旧响应不能串入新人员资料',async()=>{
 let resolve!:(d:AnchorMonthData)=>void;vi.spyOn(anchorMonthApi,'read').mockImplementation(id=>id===7?new Promise(r=>resolve=r):Promise.resolve({...data(8),items:[{...data(8).items[0],sessions:[]}]}));
 const v=render(<AnchorMonthPanel userId={7}/>);v.rerender(<AnchorMonthPanel userId={8}/>);await screen.findByText('本月暂无实际直播场次');resolve(data());await waitFor(()=>expect(screen.queryByText('南7')).toBeNull());
});
it('排班候选和选中后的摘要使用服务器本月数据，保留兼职试播标记，不按排班日期重算',async()=>{
 const batch=vi.spyOn(anchorMonthApi,'batch').mockResolvedValue(data()),change=vi.fn();
 const v=render(<AnchorMonthSelect people={[{id:7,name:'主播甲',detail:'',partTime:true}]} value="" onChange={change}/>);
 const option=await screen.findByRole('option',{name:/主播甲（兼职）.*业绩 ¥18,600.00.*工资 ¥120.00.*提成 ¥930.00/});expect(option).toBeTruthy();expect(batch).toHaveBeenCalledWith([7]);fireEvent.change(screen.getByLabelText('主播'),{target:{value:'7'}});expect(change).toHaveBeenCalled();
 v.rerender(<AnchorMonthSelect people={[{id:7,name:'主播甲',detail:'',partTime:true}]} value="7" onChange={change}/>);await screen.findByText('2026-11 本月汇总 · 含未审核');expect(screen.getByText('本月直播时长')).toBeTruthy();
});

it('周期切换更新汇总和场次，慢响应不能覆盖新周期',async()=>{
 let resolve!:(d:AnchorMonthData)=>void;
 const read=vi.spyOn(anchorMonthApi,'read').mockImplementation((id,period)=>period==='3d'?new Promise(r=>resolve=r):Promise.resolve({...data(),from:'2026-10-06',through:'2026-11-04'}));
 render(<AnchorMonthPanel userId={7}/>);
 await screen.findByText('本月营业额');
 fireEvent.click(screen.getByRole('button',{name:'本月业绩'}));
 expect(screen.getByText('本月营业额')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'近 3 天业绩'}));
 fireEvent.click(screen.getByRole('button',{name:'近 30 天业绩'}));
 await screen.findByText('近 30 天营业额');
 expect(read).toHaveBeenLastCalledWith(7,'30d');
 resolve({...data(),items:[{...data().items[0],sessions:[]}]});
 await waitFor(()=>expect(screen.getByText('南7')).toBeTruthy());
 expect(screen.getByText('2026-10-06 至 2026-11-04')).toBeTruthy();
});

it('每场营业额后展示核定工资，待核定与零工资分开，表头和每行列数一致',async()=>{
 const x=data();const row=x.items[0].sessions![0];x.items[0].sessions=[{...row,id:11,wageCents:12345,status:'approved'},{...row,id:12,wageCents:0,status:'approved'},{...row,id:13,wageCents:null}];
 vi.spyOn(anchorMonthApi,'read').mockResolvedValue(x);render(<AnchorMonthPanel userId={7}/>);await screen.findByText('¥123.45');
 const rows=screen.getAllByRole('row');expect(within(rows[0]).getAllByRole('columnheader').map(c=>c.textContent)).toEqual(['日期 / 直播间','实际直播时间','时长','营业额','工资','提成','状态','操作']);
 expect(within(rows[1]).getAllByRole('cell')).toHaveLength(8);expect(within(rows[1]).getAllByRole('cell')[4].textContent).toBe('¥123.45');expect(within(rows[2]).getAllByRole('cell')[4].textContent).toBe('¥0.00');expect(within(rows[3]).getAllByRole('cell')[4].textContent).toBe('待核定');
});
