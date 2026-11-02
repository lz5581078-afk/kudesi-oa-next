import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonalLiveIncome } from './PersonalLiveIncome';
import { liveApi } from '../live/liveApi';
import type { PersonalLiveIncome as Income } from '@kudesi/shared';
const income:Income={month:'2026-11',anchor:{visible:true,wageCents:10000,wageMinutes:120,commissionCents:300},control:{visible:true,wageCents:7000,wageMinutes:60,commissionCents:400},operator:{visible:true,commissionCents:1100}};
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('本人本月直播收入',()=>{
  it('主播和中控工资、提成分项展示，运营直播提成独立展示且无运营工资',async()=>{
    vi.spyOn(liveApi,'personalIncome').mockResolvedValue(income);render(<PersonalLiveIncome/>);await screen.findByText('2026-11 · 已审核');
    expect(within(screen.getByRole('group',{name:'本月主播工资与提成'})).getByText('¥100.00')).toBeTruthy();
    expect(within(screen.getByRole('group',{name:'本月中控工资与提成'})).getByText('¥70.00')).toBeTruthy();
    expect(within(screen.getByRole('group',{name:'本月运营直播提成'})).getByText('¥11.00')).toBeTruthy();
    expect(screen.queryByText('本月运营工资')).toBeNull();expect(screen.getByText(/最终应发以工资结算为准/)).toBeTruthy();
  });
  it('零收入显示0；没有对应身份和本月记录的分组隐藏',async()=>{
    vi.spyOn(liveApi,'personalIncome').mockResolvedValue({...income,anchor:{...income.anchor,wageCents:0,commissionCents:0},control:{...income.control,visible:false},operator:{...income.operator,visible:false}});
    render(<PersonalLiveIncome/>);await screen.findByText('本月主播工资');expect(screen.getAllByText('¥0.00')).toHaveLength(2);expect(screen.queryByText('本月中控工资')).toBeNull();expect(screen.queryByText('本月运营直播提成')).toBeNull();
  });
  it('读取失败明确提示而非显示0；可重试，刷新工作台重新获取月份和金额',async()=>{
    const load=vi.spyOn(liveApi,'personalIncome').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(income);
    const view=render(<PersonalLiveIncome/>);await screen.findByRole('alert');expect(screen.queryByText('¥0.00')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'重试'}));await screen.findByText('本月主播工资');
    load.mockResolvedValue({...income,month:'2026-12'});view.rerender(<PersonalLiveIncome refreshKey={1}/>);await screen.findByText('2026-12 · 已审核');expect(load).toHaveBeenCalledTimes(3);
  });
  it('无本人直播身份及收入时不显示无关面板',async()=>{
    vi.spyOn(liveApi,'personalIncome').mockResolvedValue({...income,anchor:{...income.anchor,visible:false},control:{...income.control,visible:false},operator:{...income.operator,visible:false}});
    render(<PersonalLiveIncome/>);await waitFor(()=>expect(screen.queryByRole('region',{name:'我的本月直播收入'})).toBeNull());
  });
});
