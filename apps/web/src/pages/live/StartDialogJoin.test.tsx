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
