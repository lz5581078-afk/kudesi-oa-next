import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ReviewPreviewAmounts} from './ReviewPreviewAmounts';
import {ReviewDialog} from './ReviewDialog';
import {liveApi,type ReviewPreview,type SessionDetail} from './liveApi';
import {flowApi} from '../flow/flowApi';
import {ApiError} from '../../api/client';
vi.mock('./liveApi',()=>({liveApi:{options:vi.fn(),reviewPreview:vi.fn()}}));
vi.mock('../flow/flowApi',()=>({flowApi:{pass:vi.fn(),back:vi.fn(),reject:vi.fn()}}));
const anchor={rateUnits:300,amountCents:2622},control={rateUnits:200,amountCents:1748},operator={rateUnits:100,amountCents:874};
const preview={finalSource:'anchor',finalSalesCents:87400,adSpendCents:0,roiScaled:null,belowRoi:false,ruleVersion:{id:1,effectiveFrom:'2026-01-01'},anchor,control,operator:null,operatorDoubledAsControl:false,wage:{minutes:180,hourlyRateCents:5000,amountCents:15000,rateSource:'archive',archiveHourlyRateCents:5000},controlWage:{minutes:180,hourlyRateCents:2000,amountCents:6000},platforms:[{platform:'douyin',finalSalesCents:87400,adSpendCents:0,anchor,control,operator}]} as ReviewPreview;
const session={id:7,date:'2026-11-01',roomName:'演示房间',startAt:'2026-11-01 18:00:00',endAt:'2026-11-01 21:00:00',anchor:{id:1,name:'演示主播'},control:{id:2,name:'演示中控'},operator:null,reports:[{role:'anchor',roleLabel:'主播',reporter:{id:1,name:'演示主播'},salesCents:87400,orderCount:0,ordersTotalCents:0}],flow:{id:9,revision:2,activeStep:{id:10},me:{canPass:true,canReturn:true,canReject:true}}} as unknown as SessionDetail;
beforeEach(()=>{vi.mocked(liveApi.options).mockResolvedValue({operators:[]} as never);vi.mocked(liveApi.reviewPreview).mockResolvedValue(preview);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe('审核计薪试算与失败反馈',()=>{
 it('审核时间显示个人打卡原值，跨日修改按北京时间送入试算和审核', async () => {
  render(<ReviewDialog session={{...session,checkinMode:true,attendance:[{userId:1,name:'演示主播',role:'anchor',startAt:'2026-11-01 18:03:21',endAt:session.endAt}]}} onClose={vi.fn()} onDone={vi.fn()}/>);
  const start=screen.getByLabelText('工资上播时间') as HTMLInputElement;
  expect(start.type).toBe('datetime-local');
  expect(start.value).toMatch(/^2026-11-01T18:03:21/);
  fireEvent.change(screen.getByLabelText('工资下播时间'),{target:{value:'2026-11-02T00:05'}});
  const expected=expect.objectContaining({wageEndAt:'2026-11-02 00:05:00'});
  await waitFor(()=>expect(liveApi.reviewPreview).toHaveBeenCalledWith(7,expected));
  fireEvent.click(screen.getByRole('button',{name:'审核通过'}));
  await waitFor(()=>expect(flowApi.pass).toHaveBeenCalledWith(9,expect.objectContaining({form:expected})));
 });
 it('自动下播显示缺报异常，修复该人员时间后才能提交；仅提成人员也必须修复',async()=>{
  render(<ReviewDialog session={{...session,checkinMode:true,controlCommissionOnly:true,attendance:[{userId:2,name:'演示中控',role:'control',startAt:session.startAt,endAt:session.endAt,autoCheckout:true}]}} onClose={vi.fn()} onDone={vi.fn()}/>);
  expect(screen.getAllByText(/未报下播.*下播时间异常/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button',{name:'审核通过'}));
  expect(flowApi.pass).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('中控计薪结束'),{target:{value:'2026-11-01T20:30:00'}});
  await waitFor(()=>expect(liveApi.reviewPreview).toHaveBeenCalledWith(7,expect.objectContaining({controlWageEndAt:'2026-11-01 20:30:00'})));
  fireEvent.click(screen.getByRole('button',{name:'审核通过'}));
  await waitFor(()=>expect(flowApi.pass).toHaveBeenCalledWith(9,expect.objectContaining({form:expect.objectContaining({controlWageEndAt:'2026-11-01 20:30:00'})})));
 });
 it('试播主播业绩明确标记中控代报，并保留真实中控报告和来源',async()=>{
  const trial={...session,anchorTrial:true,checkinMode:true,trialProxyReporter:{id:2,name:'演示中控'},reports:[{role:'control',roleLabel:'中控',reporter:{id:2,name:'演示中控'},salesCents:87400,orderCount:4,ordersTotalCents:87400,adSpendCents:0}]} as SessionDetail;
  render(<ReviewDialog session={trial} onClose={vi.fn()} onDone={vi.fn()}/>);
  const mark=screen.getByRole('region',{name:'主播业绩（试播代报）'});
  expect(mark.textContent).toContain('试播主播：演示主播');expect(mark.textContent).toContain('代报中控：演示中控');expect(mark.textContent).toContain('¥874.00');expect(mark.textContent).toContain('4 单');
  expect(within(screen.getByRole('table',{name:'上报对比'})).getAllByRole('row')).toHaveLength(2);
  expect(screen.getByRole('option',{name:/中控所报销售额.*试播代报依据/})).toBeTruthy();
  await waitFor(()=>expect(liveApi.reviewPreview).toHaveBeenCalledWith(7,expect.objectContaining({finalSource:'control'})));
 });
 it('正式主播审核不显示试播代报标识',()=>{
  render(<ReviewDialog session={session} onClose={vi.fn()} onDone={vi.fn()}/>);
  expect(screen.queryByRole('region',{name:'主播业绩（试播代报）'})).toBeNull();
 });

 it('874元单平台只显示一次提成，并明确工资和预计应发',()=>{
  render(<ReviewPreviewAmounts preview={preview}/>);
  expect(screen.getAllByText('¥26.22')).toHaveLength(1);expect(screen.getAllByText('¥17.48')).toHaveLength(1);
  const total=screen.getByRole('group',{name:'本场预计应发'});
  expect(within(total).getByText('¥176.22')).toBeTruthy();expect(within(total).getByText('¥77.48')).toBeTruthy();
  expect(screen.queryByRole('group',{name:'提成合计'})).toBeNull();
 });
 it('多平台显示分项与明确标注的提成合计，计时工资只加一次',()=>{
  render(<ReviewPreviewAmounts preview={{...preview,anchor:{...anchor,amountCents:3622},platforms:[...preview.platforms!,{...preview.platforms![0],platform:'kuaishou',anchor:{...anchor,amountCents:1000}}]}}/>);
  expect(screen.getByRole('group',{name:'抖音提成'})).toBeTruthy();expect(screen.getByRole('group',{name:'快手提成'})).toBeTruthy();
  expect(within(screen.getByRole('group',{name:'提成合计'})).getByText('¥36.22')).toBeTruthy();
  expect(within(screen.getByRole('group',{name:'本场预计应发'})).getByText('¥186.22')).toBeTruthy();
 });
 it('旧场次没有分平台数据时仍只显示一次提成',()=>{
  render(<ReviewPreviewAmounts preview={{...preview,platforms:undefined}}/>);
  expect(screen.getAllByText('¥26.22')).toHaveLength(1);
 });
 it('旧试算的慢响应不能覆盖修改时薪后的新结果',async()=>{
  let resolve!:(value:ReviewPreview)=>void;
  vi.mocked(liveApi.reviewPreview).mockReturnValueOnce(new Promise(r=>{resolve=r;}));
  render(<ReviewDialog session={session} onClose={vi.fn()} onDone={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('最终销售额来源'),{target:{value:'anchor'}});
  await waitFor(()=>expect(liveApi.reviewPreview).toHaveBeenCalledTimes(1));
  vi.mocked(liveApi.reviewPreview).mockResolvedValueOnce({...preview,wage:{...preview.wage,hourlyRateCents:8000,amountCents:24000}});
  fireEvent.change(screen.getByLabelText('主播时薪'),{target:{value:'80'}});
  await screen.findByText('¥266.22');
  await act(async()=>{resolve(preview);await Promise.resolve();});
  expect(screen.getByText('¥266.22')).toBeTruthy();expect(screen.queryByText('¥176.22')).toBeNull();
 });
 it('请求失败在固定底部显示HTTP状态；结果不明时先核对，不重复提交',async()=>{
  vi.mocked(flowApi.pass).mockRejectedValue(new ApiError(500,'请求失败'));
  const done=vi.fn();render(<ReviewDialog session={session} onClose={vi.fn()} onDone={done}/>);
  fireEvent.change(screen.getByLabelText('最终销售额来源'),{target:{value:'anchor'}});
  await screen.findByText('¥176.22');fireEvent.click(screen.getByRole('button',{name:'审核通过'}));
  const alert=await screen.findByRole('alert');expect(alert.textContent).toContain('HTTP 500');expect(alert.closest('.live-review-footer')).toBeTruthy();
  expect((screen.getByRole('button',{name:'审核通过'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'刷新场次核对结果'}));expect(done).toHaveBeenCalledTimes(1);expect(flowApi.pass).toHaveBeenCalledTimes(1);
 });
 it('明确的字段错误可修改后重试，不隐藏服务端原因',async()=>{
  vi.mocked(flowApi.pass).mockRejectedValue(new ApiError(400,'请填写中控时薪'));
  render(<ReviewDialog session={session} onClose={vi.fn()} onDone={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('最终销售额来源'),{target:{value:'anchor'}});await screen.findByText('¥176.22');fireEvent.click(screen.getByRole('button',{name:'审核通过'}));
  expect((await screen.findByRole('alert')).textContent).toContain('请填写中控时薪');
  await waitFor(()=>expect((screen.getByRole('button',{name:'审核通过'}) as HTMLButtonElement).disabled).toBe(false));
 });
});
