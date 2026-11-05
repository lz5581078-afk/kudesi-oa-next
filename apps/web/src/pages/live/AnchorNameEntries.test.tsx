import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { PersonPhotoName,personPhotoApi } from './PersonPhotoName';
import { anchorMonthApi } from './anchorMonthApi';
import { Modal } from './liveUi';
import { StartDialog } from './StartDialog';
import { SessionsTab } from './SessionsTab';
import { liveApi } from './liveApi';
import { CheckoutFeedbackRecords } from './CheckoutFeedback';
vi.mock('./liveApi',()=>({liveApi:{options:vi.fn(),sessions:vi.fn(),feedbackImageUrl:vi.fn(),checkinContext:vi.fn(),start:vi.fn()}}));
beforeEach(()=>{
 vi.spyOn(personPhotoApi,'read').mockImplementation(async id=>({userId:id,name:'主播甲',photo:null}));
 vi.spyOn(anchorMonthApi,'read').mockImplementation(async id=>({month:'2026-11',asOf:'2026-11-04 12:00:00',canViewCommission:true,canOpenSession:true,items:[{userId:id,name:'主播甲',employmentType:'part_time',summary:{wageCents:10000,pendingWageSessions:1,sessionCount:2,minutes:180,turnoverCents:100000,commissionCents:5000,missingTimeSessions:0,missingSalesSessions:0,missingCommissionSessions:0,estimatedSessions:1},sessions:[]}]}));
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.resetAllMocks();});
it('审核/详情里的姓名打开同一份月资料；Esc只关闭资料，不关闭外层业务弹窗',async()=>{
 const close=vi.fn();render(<Modal title="审核场次" onClose={close}><PersonPhotoName personId={7} name="主播甲"/></Modal>);
 const button=screen.getByRole('button',{name:'查看主播甲资料'});fireEvent.click(button);
 const profile=screen.getByRole('dialog',{name:'主播甲 · 主播资料'});await within(profile).findByText('2026-11');expect(anchorMonthApi.read).toHaveBeenCalledWith(7);expect(document.activeElement).toBe(within(profile).getByRole('button',{name:'关闭'}));
 fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('dialog',{name:'主播甲 · 主播资料'})).toBeNull();expect(screen.getByRole('dialog',{name:'审核场次'})).toBeTruthy();expect(close).not.toHaveBeenCalled();expect(document.activeElement).toBe(button);
});
it('确认标签内点击主播不会勾选确认框、提交或触发整行操作',async()=>{
 const toggle=vi.fn(),row=vi.fn(),submit=vi.fn();render(<form onSubmit={submit}><div onClick={row}><label><input type="checkbox" aria-label="确认主播" onChange={toggle}/>确认 <PersonPhotoName personId={7} name="主播甲"/></label></div></form>);
 fireEvent.click(screen.getByRole('button',{name:'查看主播甲资料'}));await screen.findByRole('dialog',{name:'主播甲 · 主播资料'});expect((screen.getByLabelText('确认主播') as HTMLInputElement).checked).toBe(false);expect(toggle).not.toHaveBeenCalled();expect(row).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
});
it.each([undefined,'submitted'])('场次列表与待审核列表的主播入口按员工编号读取，选项及详情动作互不触发（%s）',async presetStatus=>{
 vi.mocked(liveApi.options).mockResolvedValue({rooms:[],anchors:[{id:7,name:'主播甲'}],controls:[]} as never);
 vi.mocked(liveApi.sessions).mockResolvedValue({rows:[{id:11,date:'2026-11-04',startAt:'2026-11-04 10:00:00',endAt:null,roomName:'南7',anchor:{id:7,name:'主播甲'},control:null,operator:null,douyinAccount:{id:1,name:'账号'},finalSalesCents:null,status:'submitted',statusLabel:'待审核'}],total:1} as never);
 const open=vi.fn();render(<SessionsTab presetStatus={presetStatus} onOpen={open}/>);
 fireEvent.click(await screen.findByRole('button',{name:'查看主播甲资料'}));await screen.findByRole('dialog',{name:'主播甲 · 主播资料'});expect(personPhotoApi.read).toHaveBeenCalledWith(7);expect(open).not.toHaveBeenCalled();
});
it('互评与上下播记录中的主播都使用本人编号，查看资料不改分数',async()=>{
 render(<CheckoutFeedbackRecords sessionId={11} attendance={[{userId:7,name:'主播甲',role:'anchor',startAt:'10:00',endAt:'12:00'}]} records={[{reporterId:7,reporterName:'主播甲',role:'anchor',submittedAt:'2026-11-04 12:00',images:[],ratings:[{userId:7,name:'主播甲',role:'anchor',score:8}]}]}/>);
 const buttons=screen.getAllByRole('button',{name:'查看主播甲资料'});expect(buttons).toHaveLength(3);fireEvent.click(buttons[2]);await waitFor(()=>expect(anchorMonthApi.read).toHaveBeenCalledWith(7));expect(screen.getByText('8 / 10')).toBeTruthy();
});

it('加入场次卡片上的主播姓名只打开资料，不提前进入加入流程',async()=>{
 vi.mocked(liveApi.checkinContext).mockResolvedValue({schedules:[],joinable:[{id:11,roomId:1,roomName:'南7',date:'2026-11-04',anchor:{id:7,name:'主播甲'},control:{id:8,name:'中控'},canJoinAnchor:true,canJoinControl:false}]} as never);
 render(<StartDialog schedule={null} identity={{isAnchor:true,isControl:false,canManage:false}} onClose={vi.fn()} onDone={vi.fn()}/>);
 fireEvent.click(await screen.findByRole('button',{name:'查看主播甲资料'}));await screen.findByRole('dialog',{name:'主播甲 · 主播资料'});
 expect(screen.getByRole('dialog',{name:'选择本次排班'})).toBeTruthy();expect(liveApi.start).not.toHaveBeenCalled();expect(document.querySelector('button button')).toBeNull();
});
