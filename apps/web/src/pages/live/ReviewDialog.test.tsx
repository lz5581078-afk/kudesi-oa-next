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
