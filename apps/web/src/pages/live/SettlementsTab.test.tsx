import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettlementsTab } from './SettlementsTab';
import { liveApi, type SettlementDetail } from './liveApi';
vi.mock('./PersonPhotoName',()=>({PersonPhotoName:({name}:{name:string})=><span>{name}</span>}));
vi.mock('./liveApi',()=>({liveApi:{settlements:vi.fn(),settlement:vi.fn(),generateSettlement:vi.fn(),submitSettlement:vi.fn(),previewSettlement:vi.fn(),paySettlement:vi.fn(),voidSettlement:vi.fn(),adjustSettlement:vi.fn()}}));
const api=vi.mocked(liveApi);
const detail: SettlementDetail={id:1,kind:'wage',userIds:[3],month:'2026-10',from:'2026-10-01',to:'2026-10-31',status:'draft',statusLabel:'待提交',recordCount:1,wageTotalCents:5000,commissionTotalCents:0,refundTotalCents:0,deductionTotalCents:0,payableTotalCents:5000,refundsCheckedAt:null,note:'',returnReason:null,flowRunId:null,creatorName:'人事',submittedAt:null,approvedAt:null,revision:1,canManage:true,byPerson:[{userId:3,name:'主播甲',role:'anchor',roleLabel:'主播',commissionCents:0,wageCents:5000,deductionCents:0,payableCents:5000,sessions:1}],lines:[{id:10,sessionId:7,userId:3,userName:'主播甲',role:'anchor',roleLabel:'主播',date:'2026-10-15',roomName:'北1',startTime:'10:00',finalSalesCents:0,rateUnits:0,commissionCents:0,wageCents:5000,orderCount:0,ordersTotalCents:0,refundCents:0,deductionCents:0,payableCents:5000}],refunds:[],events:[]};
const open=()=>render(<MemoryRouter><SettlementsTab onOpenSession={vi.fn()}/></MemoryRouter>);
afterEach(cleanup);
beforeEach(()=>{vi.clearAllMocks();api.settlements.mockResolvedValue({canManage:true,defaultMonth:'2026-10',people:[{id:3,name:'主播甲'},{id:4,name:'主播乙'}],rows:[]});api.settlement.mockResolvedValue(detail);api.generateSettlement.mockResolvedValue({id:1});});
describe('独立结算界面',()=>{
  it('按提成、指定人员和起止日期生成；重核保持原范围及单号',async()=>{
    open();await screen.findByLabelText('结算类型');fireEvent.change(screen.getByLabelText('结算类型'),{target:{value:'commission'}});
    const select=screen.getByLabelText('结算人员') as HTMLSelectElement;select.options[0].selected=true;fireEvent.change(select);
    fireEvent.change(screen.getByLabelText('结算方式'),{target:{value:'range'}});fireEvent.change(screen.getByLabelText('结算开始日期'),{target:{value:'2026-10-12'}});fireEvent.change(screen.getByLabelText('结算结束日期'),{target:{value:'2026-10-15'}});
    fireEvent.click(screen.getByRole('button',{name:'生成 / 重新核对'}));await waitFor(()=>expect(api.generateSettlement).toHaveBeenCalledWith('2026-10',undefined,{kind:'commission',userIds:[3],from:'2026-10-12',to:'2026-10-15'}));
    const dialog=await screen.findByRole('dialog');fireEvent.click(within(dialog).getByRole('button',{name:'重新核对明细'}));await waitFor(()=>expect(api.generateSettlement).toHaveBeenLastCalledWith('2026-10',undefined,{kind:'wage',userIds:[3],settlementId:1,from:'2026-10-01',to:'2026-10-31'}));
  });
  it('空范围预览列出未到结算日原因；预览不生成单据',async()=>{
    api.previewSettlement.mockResolvedValue({lines:[],excluded:[{userId:3,sessionId:7,date:'2026-10-15',kind:'commission',reason:'未到可结算日期 2026-11-10'}]});open();fireEvent.click(await screen.findByRole('button',{name:'预览可结算范围'}));expect(await screen.findByText(/未到可结算日期/)).toBeTruthy();expect(api.generateSettlement).not.toHaveBeenCalled();
  });
  it('审批确认与付款分开；付款需要人员、金额和凭证',async()=>{
    api.settlements.mockResolvedValue({canManage:true,defaultMonth:'2026-10',rows:[{...detail,status:'approved'}]});api.settlement.mockResolvedValue({...detail,status:'approved',statusLabel:'已结算',paidTotalCents:0});api.paySettlement.mockResolvedValue({id:1});open();fireEvent.click(await screen.findByRole('button',{name:'查看'}));const dialog=await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button',{name:'提交审批'})).toBeNull();const button=within(dialog).getByRole('button',{name:'登记付款 / 追回'}) as HTMLButtonElement;expect(button.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('收款人员'),{target:{value:'3'}});fireEvent.change(within(dialog).getByLabelText('付款金额'),{target:{value:'12.34'}});fireEvent.change(within(dialog).getByLabelText('付款凭证编号'),{target:{value:'银行凭证1'}});fireEvent.click(button);
    await waitFor(()=>expect(api.paySettlement).toHaveBeenCalledWith(1,expect.objectContaining({userId:3,amountCents:1234,reference:'银行凭证1',requestKey:expect.any(String)})));
  });
  it('历史混合单重新核对仍使用原流程',async()=>{
    api.settlements.mockResolvedValue({canManage:true,defaultMonth:'2026-10',rows:[detail]});api.settlement.mockResolvedValue({...detail,legacy:true,kind:'mixed'});open();fireEvent.click(await screen.findByRole('button',{name:'查看'}));const dialog=await screen.findByRole('dialog');fireEvent.click(within(dialog).getByRole('button',{name:'重新核对明细'}));await waitFor(()=>expect(api.generateSettlement).toHaveBeenCalledWith('2026-10',undefined,{from:'2026-10-01',to:'2026-10-31'}));
  });
});
