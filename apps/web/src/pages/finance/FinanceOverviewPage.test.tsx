import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FinanceOverviewPage } from './FinanceOverviewPage';
import { financeApi, type Overview } from './financeApi';
const auth=vi.hoisted(()=>({companyId:1,id:1,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:auth})}));
vi.mock('./financeApi',()=>({financeApi:{overview:vi.fn()}}));
vi.mock('recharts',async original=>{
  const module=await original<typeof import('recharts')>();const {cloneElement}=await import('react');
  return {...module,ResponsiveContainer:({children}:{children:ReactElement<{width:number;height:number}>})=>cloneElement(children,{width:500,height:280})};
});
const result=(name='合成甲店'):Overview=>({
  month:'all',trend:[{date:'2026-01-01',revenueCents:99999999,expenseCents:0,profitCents:99999999}],
  storeTrend:[{date:'2026-01-01',salesCents:12000,costCents:7800,profitCents:4200},{date:'2026-01-02',salesCents:500,costCents:100,profitCents:400}],
  stores:[{storeId:1,name,platform:'pdd',licenseName:'合成主体',salesCents:12500,adCostCents:1000,profitCents:4600}],
  ledger:[],revenueCents:0,cogsCents:0,grossProfitCents:0,expenseCents:0,otherIncomeCents:0,netProfitCents:0,receivableCents:0,payableCents:0,advanceReceiptCents:0,prepaymentCents:0,bankCents:0,drafts:0,issued:0,
});
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();auth.companyId=1;});afterEach(cleanup);
it('图表只画店铺日报利润与成本，保留原币种负号和台账20行边界',async()=>{
  const data=result();data.stores[0].profitCents=-1000;
  data.ledger=Array.from({length:21},(_,index)=>({date:'2026-01-01',direction:'in',kind:'revenue',amountCents:index+1,documentId:index+1,docNo:`合成单${index}`,docType:'sale',storeName:`合成台账${index}`,source:'手工制单'}));
  vi.mocked(financeApi.overview).mockResolvedValue(data);render(<FinanceOverviewPage/>);
  await screen.findByText('pdd / 合成甲店');expect(screen.getByText('-¥10.00')).toBeTruthy();
  const chart=screen.getByRole('img',{name:'店铺利润和成本趋势'});
  expect(within(chart).getByText('80')).toBeTruthy();
  await waitFor(()=>expect(chart.querySelectorAll('.recharts-area-curve')).toHaveLength(2),{timeout:3000});
  expect(chart.textContent).not.toContain('999999');
  expect(screen.getByText('合成台账19')).toBeTruthy();expect(screen.queryByText('合成台账20')).toBeNull();
  expect(financeApi.overview).toHaveBeenCalledWith('all');
});
it('旧公司迟到响应不混入新公司，也不保留旧公司的筛选输入',async()=>{
  let finish!:(value:Overview)=>void;
  vi.mocked(financeApi.overview).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce(result('合成乙店'));
  const view=render(<FinanceOverviewPage/>);
  fireEvent.change(screen.getByRole('textbox',{name:'店铺利润搜索'}),{target:{value:'甲公司条件'}});
  auth.companyId=2;view.rerender(<FinanceOverviewPage/>);
  await screen.findByText('pdd / 合成乙店');
  await act(async()=>finish(result('旧公司迟到资料')));
  expect(screen.queryByText(/旧公司迟到资料/)).toBeNull();
  expect(screen.getByRole('textbox',{name:'店铺利润搜索'})).toHaveProperty('value','');
});
it('读取失败不显示假零值，重试读取实际资料',async()=>{
  vi.mocked(financeApi.overview).mockRejectedValueOnce(new Error('合成网络失败')).mockResolvedValueOnce(result());
  render(<FinanceOverviewPage/>);await screen.findByRole('alert');
  expect(screen.queryByText('共 0 条')).toBeNull();expect(screen.queryByText('¥0.00')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'重试'}));await screen.findByText('pdd / 合成甲店');
  expect(financeApi.overview).toHaveBeenCalledTimes(2);
});
