vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:{id:4,name:'登录中控'},can:()=>true})}));
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {StartDialog} from './StartDialog';
import {liveApi,type CheckinContext,type CheckinSession,type ScheduleRow} from './liveApi';
import {ApiError} from '../../api/client';
vi.mock('./liveApi',()=>({liveApi:{checkinContext:vi.fn(),options:vi.fn(),products:vi.fn(),start:vi.fn()}}));
const api=vi.mocked(liveApi),done=vi.fn();
const channels=[{accountId:20,accountName:'实际直播号',platform:'douyin',storeIds:[30],stores:[{id:30,name:'店铺',jstShopId:'S1'}]}];
const plan={id:1,roomId:10,roomName:'北1',date:'2020-01-01',start:'2020-01-01 10:00:00',end:'2020-01-01 12:00:00',startTime:'10:00',endTime:'12:00',anchor:{id:3,name:'主播'},control:{id:4,name:'中控'},operator:null,douyinAccount:{id:20,name:'旧计划账号'},store:{id:30,name:'店铺'},products:[{id:null,code:'',name:'旧计划产品',spec:''}],channels,status:'scheduled',mineRole:'control',canStart:true} as ScheduleRow;
const actual={id:7,scheduleId:1,roomId:10,roomName:'北1',date:plan.date,startAt:plan.start,endAt:null,plannedEnd:plan.end,anchor:plan.anchor,control:plan.control,operator:null,douyinAccount:{id:20,name:'实际直播号'},store:plan.store,channels,products:[{id:null,code:'',name:'实际产品',spec:''}],canJoinControl:true,canJoinAnchor:false,checkinMode:true,status:'live'} as CheckinSession;
const context=(joinable:CheckinSession[]=[])=>({identity:{isAnchor:false,isControl:true,canManage:false},schedules:[plan],joinable,active:[],rooms:[{id:10,name:'北1'}]}) as unknown as CheckinContext;
const props={schedule:plan,role:'control' as const,identity:{isAnchor:false,isControl:true,canManage:false},onClose:()=>{},onDone:done};
const confirm=()=>fireEvent.click(screen.getByRole('checkbox',{name:/已核对本场人员/}));
beforeEach(()=>{vi.resetAllMocks();api.checkinContext.mockResolvedValue(context());api.start.mockResolvedValue({id:7});api.products.mockResolvedValue([]);api.options.mockResolvedValue({rooms:[{id:10,name:'北1'}],anchors:[plan.anchor],controls:[plan.control],operators:[],douyinAccounts:[{id:20,name:'实际直播号',platform:'douyin',storeIds:[30]}],stores:[{id:30,name:'店铺',platform:'douyin'}]} as never);});
afterEach(cleanup);
it('主播先开播：旧排班入口直接核对实际场次，中控确认后按sessionId加入',async()=>{
 api.checkinContext.mockResolvedValue(context([actual]));render(<StartDialog {...props}/>);
 await screen.findByRole('dialog',{name:'核对本场并确认本人上播'});await screen.findByDisplayValue('实际产品');expect(screen.queryByDisplayValue('旧计划产品')).toBeNull();expect(api.start).not.toHaveBeenCalled();
 confirm();fireEvent.click(screen.getByRole('button',{name:'确认上播'}));await waitFor(()=>expect(done).toHaveBeenCalledWith(7));expect(api.start).toHaveBeenCalledWith(expect.objectContaining({sessionId:7,role:'control',confirmDetails:true,productEntries:[{name:'实际产品'}]}));
});
it('打开旧表单后主播才上播：提交前切换实际信息并清空确认，不自动上播',async()=>{
 api.checkinContext.mockResolvedValueOnce(context()).mockResolvedValue(context([actual]));render(<StartDialog {...props}/>);await screen.findByDisplayValue('旧计划产品');confirm();fireEvent.click(screen.getByRole('button',{name:'确认上播'}));
 await screen.findByDisplayValue('实际产品');expect(screen.getByRole('dialog',{name:'核对本场并确认本人上播'})).toBeTruthy();expect(api.start).not.toHaveBeenCalled();expect((screen.getByRole('checkbox',{name:/已核对本场人员/}) as HTMLInputElement).checked).toBe(false);
 confirm();fireEvent.click(screen.getByRole('button',{name:'确认上播'}));await waitFor(()=>expect(api.start).toHaveBeenCalledTimes(1));expect(api.start).toHaveBeenCalledWith(expect.objectContaining({sessionId:7}));
});
it('同时点击触发409：重新读取同一排班场次，要求重核对，绝不自动重发',async()=>{
 api.checkinContext.mockResolvedValueOnce(context()).mockResolvedValueOnce(context()).mockResolvedValue(context([actual]));api.start.mockRejectedValueOnce(new ApiError(409,'本场已经开播，请打开实际场次核对信息后确认本人上播')).mockResolvedValue({id:7});
 render(<StartDialog {...props}/>);await screen.findByDisplayValue('旧计划产品');confirm();fireEvent.click(screen.getByRole('button',{name:'确认上播'}));await screen.findByDisplayValue('实际产品');expect(api.start).toHaveBeenCalledTimes(1);expect(done).not.toHaveBeenCalled();
 confirm();fireEvent.click(screen.getByRole('button',{name:'确认上播'}));await waitFor(()=>expect(api.start).toHaveBeenCalledTimes(2));expect(api.start.mock.calls[1][0]).toMatchObject({sessionId:7,role:'control'});
});
it('其他房间或排班不能当作当前场次加入，原错误明确保留',async()=>{
 api.checkinContext.mockResolvedValue(context([{...actual,roomId:99},{...actual,id:8,scheduleId:2}]));api.start.mockRejectedValue(new ApiError(409,'本场不能加入'));
 render(<StartDialog {...props}/>);await screen.findByDisplayValue('旧计划产品');confirm();fireEvent.click(screen.getByRole('button',{name:'确认上播'}));await screen.findByText('本场不能加入');expect(api.start).toHaveBeenCalledTimes(1);expect(api.start.mock.calls[0][0].sessionId).toBeUndefined();expect(done).not.toHaveBeenCalled();
});
it('其他身份不可冒充加入，权限拒绝不会自动恢复或重发',async()=>{
 api.checkinContext.mockResolvedValue(context([{...actual,canJoinControl:false,canJoinAnchor:true}]));api.start.mockRejectedValue(new ApiError(403,'没有所选上播身份'));
 render(<StartDialog {...props}/>);await screen.findByDisplayValue('旧计划产品');confirm();fireEvent.click(screen.getByRole('button',{name:'确认上播'}));await screen.findByText('没有所选上播身份');expect(api.start).toHaveBeenCalledTimes(1);expect(api.checkinContext).toHaveBeenCalledTimes(2);
});
it('中控先上播时主播也从同一实际场次加入，按主播本人身份提交',async()=>{
 api.checkinContext.mockResolvedValue(context([{...actual,canJoinAnchor:true,canJoinControl:false}]));
 render(<StartDialog {...props} role="anchor" identity={{isAnchor:true,isControl:false,canManage:false}}/>);
 await screen.findByRole('dialog',{name:'核对本场并确认本人上播'});await screen.findByDisplayValue('实际产品');expect(api.start).not.toHaveBeenCalled();
 confirm();fireEvent.click(screen.getByRole('button',{name:'确认上播'}));
 await waitFor(()=>expect(api.start).toHaveBeenCalledWith(expect.objectContaining({sessionId:7,role:'anchor'})));
});
it('没有本人可开播排班或可加入场次时保留线上限制，不提供临时开播',async()=>{
 api.checkinContext.mockResolvedValue({...context(),schedules:[],joinable:[]});render(<StartDialog {...props} schedule={null}/>);
 await screen.findByText('没有可开播的排班，请联系人事安排。');expect(screen.queryByRole('button',{name:/临时开播|确认上播/})).toBeNull();expect(api.start).not.toHaveBeenCalled();
});

it('默认只显示本场资料，切换账号后收起其他账号并重新核对',async()=>{
 api.options.mockResolvedValue({rooms:[{id:10,name:'北1'},{id:11,name:'其他直播间'}],anchors:[plan.anchor],controls:[plan.control],operators:[],douyinAccounts:[{id:20,name:'实际直播号',platform:'douyin',storeIds:[30]},{id:21,name:'其他直播号',platform:'douyin',storeIds:[31]}],stores:[{id:30,name:'店铺',platform:'douyin'},{id:31,name:'另一店铺',platform:'douyin'}]} as never);
 render(<StartDialog {...props}/>);await screen.findByDisplayValue('旧计划产品');
 expect(screen.getByLabelText('直播间').textContent).toBe('北1');expect(screen.queryByText('其他直播间')).toBeNull();expect(screen.queryByText('其他直播号')).toBeNull();expect(screen.queryByRole('combobox')).toBeNull();
 confirm();fireEvent.click(screen.getByRole('button',{name:'切换直播账号 / 店铺'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'其他直播号'}));fireEvent.click(screen.getByRole('checkbox',{name:'实际直播号'}));
 expect((screen.getByRole('checkbox',{name:/已核对本场人员/}) as HTMLInputElement).checked).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'完成选择'}));expect(screen.queryByRole('checkbox',{name:'实际直播号'})).toBeNull();expect(screen.getByLabelText('本场已选账号与店铺').textContent).toContain('其他直播号');expect(screen.getByLabelText('本场已选账号与店铺').textContent).toContain('另一店铺');
 confirm();fireEvent.click(screen.getByRole('button',{name:'确认上播'}));await waitFor(()=>expect(api.start).toHaveBeenCalledWith(expect.objectContaining({channels:[{accountId:21,storeIds:[31]}],douyinAccountId:21,storeId:31})));
});
it('无本人排班时保留正式限制，不展示其他直播间或开放临时加场',async()=>{
 api.checkinContext.mockResolvedValue({...context(),schedules:[]});
 render(<StartDialog {...props} schedule={null}/>);
 await screen.findByText('没有可开播的排班，请联系人事安排。');expect(screen.queryByRole('combobox')).toBeNull();expect(screen.queryByRole('button',{name:'确认上播'})).toBeNull();expect(screen.queryByText('没有对应排班，临时开播')).toBeNull();expect(api.start).not.toHaveBeenCalled();
});
it('未安排本人的空缺中控场次默认收起，主动选择后才能加入',async()=>{
 api.checkinContext.mockResolvedValue({...context([{...actual,control:null}]),schedules:[]});
 render(<StartDialog {...props} schedule={null}/>);
 await screen.findByRole('button',{name:'选择其他可加入场次'});expect(screen.queryByRole('button',{name:/直播中 · 加入本场/})).toBeNull();expect(api.start).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'选择其他可加入场次'}));fireEvent.click(screen.getByRole('button',{name:/直播中 · 加入本场/}));
 await screen.findByRole('dialog',{name:'核对本场并确认本人上播'});expect(api.start).not.toHaveBeenCalled();
});

it('核对人员时显示排班中的姓名，候选列表缺少中控也不误显示登录人',async()=>{
 const options=await api.options();api.options.mockResolvedValue({...options,controls:[]});
 render(<StartDialog {...props}/>);
 await screen.findByDisplayValue('旧计划产品');
 expect(screen.getByLabelText('本场主播').textContent).toBe('主播');
 expect(screen.getByLabelText('本场中控').textContent).toBe('中控');
 expect(screen.getByLabelText('请核对本场主播和中控').className).toContain('live-identity-cards');
});
