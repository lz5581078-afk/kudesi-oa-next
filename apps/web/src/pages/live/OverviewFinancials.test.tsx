import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OverviewTab } from './OverviewTab';
import { liveApi, type Overview } from './liveApi';
import { todayText } from './liveFormat';
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({can:()=>true})}));
vi.mock('./DailyWorkPanel',()=>({DailyOfficeCard:()=>null}));
vi.mock('./liveApi',()=>({liveApi:{overview:vi.fn()}}));
const response=(extra:Record<string,unknown>={})=>({date:todayText(),now:todayText()+' 14:23:00',corridorFound:false,daySummary:{sessions:0,live:0,people:0,roles:[]},groups:{north:[],south:[],none:[]},totals:{rooms:11,live:2,scheduled:4,pendingReview:3},financials:{adSpend:{totalCents:5678,missingSessions:0},sessions:5,turnoverCents:123456,costs:{wageCents:10000,commissionCents:2345,totalCents:12345,missingSessions:0},missingSalesSessions:0},...extra}) as Overview;
beforeEach(()=>vi.mocked(liveApi.overview).mockResolvedValue(response()));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('显示今日营业额和已发生费用，切换直播间筛选不改变全日汇总',async()=>{
 render(<OverviewTab onOpenSession={vi.fn()}/>);
 expect(await screen.findByText('¥1,234.56')).toBeTruthy();expect(screen.getByText('¥123.45')).toBeTruthy();
 expect(screen.getByText('今日直播营业额')).toBeTruthy();expect(screen.getByText('今日费用')).toBeTruthy();expect(screen.getByText('今日投流费用')).toBeTruthy();expect(screen.getByText('¥56.78')).toBeTruthy();expect(screen.getByText('实时预估 · 含未审核')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'正在直播'}));expect(screen.getByText('¥1,234.56')).toBeTruthy();expect(liveApi.overview).toHaveBeenCalledTimes(1);
});
it('缺失数据标明未完善；无费用权限不显示费用或分项',async()=>{
 vi.mocked(liveApi.overview).mockResolvedValue(response({financials:{sessions:5,turnoverCents:100,missingSalesSessions:2,costs:null}}));
 render(<OverviewTab onOpenSession={vi.fn()}/>);
 expect(await screen.findByText('已统计 · 2场待更新')).toBeTruthy();expect(screen.getAllByText('无全员费用查看权限')).toHaveLength(2);expect(screen.queryByText('¥123.45')).toBeNull();
});
it('切换日期清除原日期金额；晚到的旧请求不能覆盖新日期',async()=>{
 let resolveOld!:(o:Overview)=>void;
 vi.mocked(liveApi.overview).mockImplementationOnce(()=>new Promise(r=>{resolveOld=r;}));
 render(<OverviewTab onOpenSession={vi.fn()}/>);
 // Supply a response carrying the selected date.
 vi.mocked(liveApi.overview).mockResolvedValue(response({date:'2026-10-01',financials:{sessions:0,turnoverCents:0,missingSalesSessions:0,costs:{wageCents:0,commissionCents:0,totalCents:0,missingSessions:0}}}));
 fireEvent.change(screen.getByLabelText('全览日期'),{target:{value:'2026-10-01'}});
 expect(screen.queryByText('¥1,234.56')).toBeNull();
 await waitFor(()=>expect(screen.getAllByText('¥0.00')).toHaveLength(2));
 await act(async()=>resolveOld(response()));
 expect(screen.getAllByText('¥0.00')).toHaveLength(2);expect(screen.getByText('当日直播营业额')).toBeTruthy();
});

it('投流显示已填报金额和缺填场次，位置在今日费用之后',async()=>{
 const d=response();d.financials!.adSpend={totalCents:0,missingSessions:2};
 vi.mocked(liveApi.overview).mockResolvedValue(d);
 render(<OverviewTab onOpenSession={vi.fn()}/>);
 expect(await screen.findByText('已填报 · 2场待填报')).toBeTruthy();
 const labels=[...screen.getByLabelText('当日营业额与费用').querySelectorAll('.live-financial-stat > span')].map(e=>e.textContent);
 expect(labels).toEqual(['今日直播营业额','今日费用','今日投流费用']);
});
