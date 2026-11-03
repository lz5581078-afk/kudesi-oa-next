import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { liveApi } from './liveApi';
import { CheckOutDialog } from './CheckOutDialog';
import { StartDialog, JoinDialog } from './StartDialog';
import { LiveCheckinPanel } from './LiveCheckinPanel';
import { clearLiveRoom,consumeLiveRoom,liveRoomTarget,rememberLiveRoom } from '../../auth/liveRoomIntent';
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:{id:3,companyId:1,name:'小主播'}})}));
vi.mock('./liveApi',()=>({liveApi:{checkinContext:vi.fn(),checkoutFeedback:vi.fn(),feedbackImageUrl:vi.fn(),uploadFeedbackImage:vi.fn(),checkoutPreview:vi.fn(),report:vi.fn(),options:vi.fn(),products:vi.fn(),start:vi.fn()}}));
const api=vi.mocked(liveApi),done=vi.fn();
const plan={id:1,fingerprint:'snapshot',roomId:10,roomName:'北1',date:'2099-12-01',start:'2099-12-01 10:00:00',end:'2099-12-01 12:00:00',startTime:'10:00',endTime:'12:00',anchor:{id:3,name:'主播'},control:{id:4,name:'中控'},operator:null,douyinAccount:{id:20,name:'直播号'},store:{id:30,name:'店铺'},products:[{id:null,code:'',name:'玉米',spec:''}],channels:[{accountId:20,platform:'douyin',storeIds:[30],stores:[{id:30,name:'店铺',jstShopId:'S1'}]}],status:'scheduled',canStart:true,mineRole:'anchor'};
const options={rooms:[{id:10,name:'北1'}],anchors:[{id:3,name:'主播'}],controls:[{id:4,name:'中控'}],operators:[],douyinAccounts:[{id:20,name:'直播号',platform:'douyin',storeIds:[30]}],stores:[{id:30,name:'店铺',platform:'douyin'}]};
beforeEach(()=>{vi.resetAllMocks();const feedbackApi=vi.mocked(liveApi);feedbackApi.checkoutFeedback.mockResolvedValue({targets:[],records:[{role:'control',images:[{id:91,name:'data.png',mime:'image/png',size:10}],ratings:[]}] as never,locked:false});feedbackApi.feedbackImageUrl.mockResolvedValue({url:'data:image/png;base64,'});api.options.mockResolvedValue(options as never);api.products.mockResolvedValue([]);api.start.mockResolvedValue({id:7});api.checkinContext.mockResolvedValue({identity:{isAnchor:true,isControl:false,canManage:false},schedules:[],active:[],rooms:options.rooms} as never);clearLiveRoom();});
afterEach(()=>cleanup());
describe('直播间与岗位打卡',()=>{
 it('读取排班预填、未到时间必须再次点击，不接受手填时间',async()=>{render(<StartDialog schedule={plan as never} identity={{isAnchor:true,isControl:false,canManage:false}} onClose={()=>{}} onDone={done}/>);const button=await screen.findByRole('button',{name:'确认上播'});await screen.findByLabelText('直播间');await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));fireEvent.click(button);expect(api.start).not.toHaveBeenCalled();fireEvent.click(await screen.findByRole('button',{name:'仍要提前开播'}));await waitFor(()=>expect(done).toHaveBeenCalledWith(7));expect(api.start.mock.calls[0][0]).toMatchObject({scheduleId:1,scheduleFingerprint:'snapshot',confirmEarly:true});expect(api.start.mock.calls[0][0]).not.toHaveProperty('startAt');});
 it('中控确认核对后才可提交上播',async()=>{render(<StartDialog schedule={plan as never} identity={{isAnchor:false,isControl:true,canManage:false}} onClose={()=>{}} onDone={done}/>);const button=await screen.findByRole('button',{name:'确认上播'});await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));fireEvent.click(button);expect((await screen.findByRole('alert')).textContent).toContain('核对');expect(api.start).not.toHaveBeenCalled();});
 it('中控加入已开播场次时可修正产品，确认后按同一场次上播',async()=>{render(<JoinDialog session={{...plan,id:7,scheduleId:1,startAt:'2020-01-01 10:00:00',endAt:null,plannedEnd:'2020-01-01 12:00:00',products:plan.products} as never} role="control" onClose={()=>{}} onDone={done}/>);const dlg=await screen.findByRole('dialog',{name:'核对本场并确认本人上播'});const button=within(dlg).getByRole('button',{name:'确认上播'});await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));fireEvent.change(within(dlg).getByLabelText('场次产品 1'),{target:{value:'核对后的产品'}});fireEvent.click(within(dlg).getByRole('checkbox',{name:/已核对本场人员/}));fireEvent.click(button);await waitFor(()=>expect(api.start).toHaveBeenCalledWith(expect.objectContaining({sessionId:7,confirmDetails:true,productEntries:[{name:'核对后的产品'}]})));});
 it('下播展示本人收入，订单失败仍能记录实际下播并明确待核对',async()=>{api.checkoutPreview.mockResolvedValue({role:'anchor',startAt:'2026-11-01 10:00:00',endAt:'2026-11-01 11:00:00',salesCents:null,orderCount:null,reason:'聚水潭超时',wage:{minutes:60,amountCents:5000,hourlyRateCents:5000},commission:null,locked:false});api.report.mockResolvedValue({ok:true});render(<CheckOutDialog session={{id:7,roomName:'北1',me:{reportRoles:['anchor']},channels:[]} as never} onClose={()=>{}} onDone={done}/>);expect(await screen.findByText('¥50.00')).toBeTruthy();expect(screen.getByText(/聚水潭超时/)).toBeTruthy();await waitFor(()=>expect((screen.getByRole('button',{name:'确认下播'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'确认下播'}));await waitFor(()=>expect(done).toHaveBeenCalled());expect(api.report).toHaveBeenCalledWith(7,expect.objectContaining({role:'anchor'}));});
 it('到期锁场时禁用下播，扫码公司不符不能读取场次',async()=>{render(<MemoryRouter><LiveCheckinPanel roomId={10} companyId={2}/></MemoryRouter>);expect(screen.getByRole('alert').textContent).toContain('另一家公司');expect(api.checkinContext).not.toHaveBeenCalled();cleanup();api.checkoutPreview.mockResolvedValue({role:'anchor',startAt:'2026-11-01 10:00:00',endAt:'2026-11-01 11:00:00',salesCents:0,orderCount:0,reason:'',wage:null,commission:null,locked:true});render(<CheckOutDialog session={{id:7,roomName:'北1',me:{reportRoles:['anchor']},channels:[]} as never} onClose={()=>{}} onDone={done}/>);await screen.findByText('¥0.00');expect(screen.getByRole('button',{name:'确认下播'}).hasAttribute('disabled')).toBe(true);});
 it('扫码携带令牌，旧码刷新失败时清掉已显示的上下播操作',async()=>{
  api.checkinContext.mockResolvedValue({identity:{isAnchor:true,isControl:false,isOperations:false},active:[],schedules:[],rooms:[]} as never);
  render(<LiveCheckinPanel roomId={10} companyId={1} token={'a'.repeat(43)}/>);
  await screen.findByRole('button',{name:'上播'});expect(api.checkinContext).toHaveBeenCalledWith(10,'a'.repeat(43),true);
  api.checkinContext.mockRejectedValue(new Error('二维码已失效，请扫描直播间最新二维码'));fireEvent.focus(window);
  expect((await screen.findByRole('alert')).textContent).toContain('已失效');expect(screen.queryByRole('button',{name:'上播'})).toBeNull();
 });
 it('飞书登录和强制绑定返回固定房间，拒绝任意跳转地址',()=>{history.replaceState(null,'','/features/live-desk?room=10&company=1');rememberLiveRoom();history.replaceState(null,'','/feishu-bind');expect(consumeLiveRoom()).toBe('/features/live-desk?room=10&company=1');expect(consumeLiveRoom()).toContain('room=10');expect(liveRoomTarget('https://evil.example/features/live-desk?room=1&company=1')).toBeNull();expect(liveRoomTarget('//evil.example')).toBeNull();clearLiveRoom();history.replaceState(null,'','/');});
 it('试播上播必须具名确认，不能更换排班试播主播',async()=>{
  const trialPlan={...plan,anchorTrial:true,anchor:{id:3,name:'试播小李'},start:'2020-01-01 10:00:00'};
  render(<StartDialog role="control" schedule={trialPlan as never} identity={{isAnchor:false,isControl:true,canManage:false}} onClose={()=>{}} onDone={done}/>);
  const button=await screen.findByRole('button',{name:'确认上播'});await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));
  expect(screen.getByLabelText('本场主播').textContent).toBe('试播小李');fireEvent.click(screen.getByRole('button',{name:'调整本场人员'}));expect(screen.getByLabelText('主播').hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('checkbox',{name:/已核对本场人员/}));fireEvent.click(button);
  expect((await screen.findByRole('alert')).textContent).toContain('试播主播');expect(api.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox',{name:/确认本场由试播主播「试播小李」上播/}));fireEvent.click(button);
  await waitFor(()=>expect(api.start).toHaveBeenCalledWith(expect.objectContaining({confirmTrialAnchorId:3,role:'control'})));
 });
 it('试播下播再次具名确认，中控报告携带确切试播主播ID',async()=>{
  api.checkoutPreview.mockResolvedValue({role:'control',startAt:'2026-11-01 10:00:00',endAt:'2026-11-01 11:00:00',salesCents:0,orderCount:0,reason:'',wage:null,commission:null,locked:false});api.report.mockResolvedValue({ok:true});
  render(<CheckOutDialog session={{id:7,anchorTrial:true,anchor:{id:3,name:'试播小李'},roomName:'北1',me:{reportRoles:['control']},channels:[]} as never} onClose={()=>{}} onDone={done}/>);
  await screen.findByText('¥0.00');fireEvent.click(screen.getByRole('checkbox',{name:/已核对本场投流费用/}));await waitFor(()=>expect((screen.getByRole('button',{name:'确认下播'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'确认下播'}));
  expect((await screen.findByRole('alert')).textContent).toContain('试播主播');expect(api.report).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox',{name:/确认本场下播的仍是试播主播「试播小李」/}));await waitFor(()=>expect((screen.getByRole('button',{name:'确认下播'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'确认下播'}));
  await waitFor(()=>expect(api.report).toHaveBeenCalledWith(7,expect.objectContaining({confirmTrialAnchorId:3,role:'control'})));
 });

});
