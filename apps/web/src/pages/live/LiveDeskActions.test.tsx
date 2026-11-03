import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { LiveCheckinPanel } from './LiveCheckinPanel';
import { liveApi } from './liveApi';
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:{id:3,companyId:1,name:'本人'}})}));
vi.mock('./liveApi',()=>({liveApi:{checkinContext:vi.fn(),session:vi.fn(),start:vi.fn(),report:vi.fn(),checkoutFeedback:vi.fn(),feedbackImageUrl:vi.fn(),uploadFeedbackImage:vi.fn(),checkoutPreview:vi.fn(),options:vi.fn(),products:vi.fn(),integrationStatus:vi.fn()}}));
const a=vi.mocked(liveApi);
const person=(id:number,name:string)=>({id,name});
const session={id:7,roomId:10,roomName:'南1',date:'2026-11-02',startAt:'2026-11-02 10:00:00',endAt:null,checkinMode:true,reportsLocked:false,status:'live',anchor:person(3,'本人'),control:person(4,'中控'),operator:null,douyinAccount:person(20,'直播号'),store:person(30,'店铺'),channels:[],products:[{id:null,code:'',name:'玉米',spec:''}]};
const context=(o:Record<string,unknown>={})=>({identity:{isAnchor:true,isControl:false,isOperations:false},active:[],schedules:[],joinable:[],rooms:[],...o});
beforeEach(()=>{vi.resetAllMocks();const feedbackApi=vi.mocked(liveApi);feedbackApi.checkoutFeedback.mockResolvedValue({targets:[],records:[{role:'control',images:[{id:91,name:'data.png',mime:'image/png',size:10}],ratings:[]}] as never,locked:false});feedbackApi.feedbackImageUrl.mockResolvedValue({url:'data:image/png;base64,'});a.checkinContext.mockResolvedValue(context() as never);a.options.mockResolvedValue({rooms:[{id:10,name:'南1'}],anchors:[person(3,'本人')],controls:[person(4,'中控')],operators:[],douyinAccounts:[],stores:[]} as never);a.start.mockResolvedValue({id:7});});
afterEach(()=>cleanup());
describe('本人岗位工作台直播按钮',()=>{
 it('通用码要求先选房，只加入所选房间，不自动使用其他房间场次',async()=>{
   a.checkinContext.mockResolvedValue(context({rooms:[{id:10,name:'南1'},{id:20,name:'北2'}],joinable:[{...session,canJoinAnchor:true},{...session,id:8,roomId:20,roomName:'北2',canJoinAnchor:true}]}) as never);
   a.options.mockResolvedValue({rooms:[{id:10,name:'南1'},{id:20,name:'北2'}],anchors:[person(3,'本人')],controls:[],operators:[],douyinAccounts:[],stores:[]} as never);
   render(<LiveCheckinPanel companyId={1} token={'a'.repeat(43)}/>);
   fireEvent.click(await screen.findByRole('button',{name:'上播'}));expect((await screen.findByRole('alert')).textContent).toContain('请选择上播直播间');expect(screen.queryByRole('dialog')).toBeNull();
   fireEvent.change(screen.getByLabelText('上播直播间'),{target:{value:'20'}});fireEvent.click(screen.getByRole('button',{name:'上播'}));
   const dlg=await screen.findByRole('dialog',{name:'核对本场并确认本人上播'});await waitFor(()=>expect((within(dlg).getByLabelText('直播间') as HTMLSelectElement).value).toBe('20'));
 });
 it('通用码已有本人实际场次时直接下播，无需选择房间',async()=>{
   a.checkinContext.mockResolvedValue(context({rooms:[{id:10,name:'南1'},{id:20,name:'北2'}],active:[{...session,myCheckin:{role:'anchor',startAt:session.startAt,endAt:null}}]}) as never);
   a.session.mockResolvedValue({...session,me:{reportRoles:['anchor']},reports:[]} as never);a.checkoutPreview.mockResolvedValue({role:'anchor',startAt:session.startAt,endAt:'2026-11-02 11:00:00',salesCents:0,orderCount:0,reason:'',wage:null,commission:null,locked:false});
   render(<LiveCheckinPanel companyId={1} token={'a'.repeat(43)}/>);fireEvent.click(await screen.findByRole('button',{name:'下播'}));expect(screen.queryByLabelText('上播直播间')).toBeNull();expect(a.session).toHaveBeenCalledWith(7);await screen.findByRole('dialog',{name:'确认本人下播'});
 });
 it('运营用通用码选择房间后，身份候选仅显示该房间场次',async()=>{
   a.checkinContext.mockResolvedValue(context({identity:{isAnchor:false,isControl:true,isOperations:true},rooms:[{id:10,name:'南1'},{id:20,name:'北2'}],joinable:[{...session,canJoinOperator:true},{...session,id:8,roomId:20,roomName:'北2',canJoinOperator:true}]}) as never);
   render(<LiveCheckinPanel companyId={1} token={'a'.repeat(43)}/>);fireEvent.change(await screen.findByLabelText('上播直播间'),{target:{value:'20'}});fireEvent.click(screen.getByRole('button',{name:'上播'}));
   const dlg=await screen.findByRole('dialog',{name:'选择本场身份'});fireEvent.click(within(dlg).getByRole('radio',{name:/运营/}));expect(dlg.textContent).toContain('北2');expect(dlg.textContent).not.toContain('南1');fireEvent.click(within(dlg).getByRole('button',{name:'确认运营身份上播'}));await waitFor(()=>expect(a.start).toHaveBeenCalledWith({sessionId:8,role:'operator',confirmDetails:true}));
 });
 it('已实际上播的本人按钮直接显示下播，提交后原位置恢复上播',async()=>{
   a.checkinContext.mockResolvedValue(context({active:[{...session,myCheckin:{role:'anchor',startAt:session.startAt,endAt:null}}]}) as never);
   a.session.mockResolvedValue({...session,me:{reportRoles:['anchor'],canSubmit:false,isManager:false},reports:[]} as never);
   a.checkoutPreview.mockResolvedValue({role:'anchor',startAt:session.startAt,endAt:'2026-11-02 11:00:00',minutes:60,salesCents:0,orderCount:0,reason:'',wage:null,commission:null,locked:false});a.report.mockResolvedValue({ok:true});
   const changed=vi.fn();render(<LiveCheckinPanel workspaceType="live_anchor" onChanged={changed}/>);fireEvent.click(await screen.findByRole('button',{name:'下播'}));
   const dlg=await screen.findByRole('dialog',{name:'确认本人下播'});await within(dlg).findByText('¥0.00');
   a.checkinContext.mockResolvedValue(context({active:[{...session,myCheckin:{role:'anchor',startAt:session.startAt,endAt:'2026-11-02 11:00:00'}}]}) as never);
   fireEvent.click(within(dlg).getByRole('button',{name:'确认下播'}));expect(await screen.findByRole('button',{name:'上播'})).toBeTruthy();expect(screen.queryByRole('button',{name:'下播'})).toBeNull();expect(changed).toHaveBeenCalledTimes(1);
 });
 it('主播确认上播后原按钮变下播，不另开详情入口',async()=>{a.checkinContext.mockResolvedValue(context({joinable:[{...session,canJoinAnchor:true,canJoinControl:false,canJoinOperator:false}]}) as never);render(<LiveCheckinPanel workspaceType="live_anchor"/>);fireEvent.click(await screen.findByRole('button',{name:'上播'}));const dlg=await screen.findByRole('dialog',{name:'核对本场并确认本人上播'});const button=within(dlg).getByRole('button',{name:'确认上播'});await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));a.checkinContext.mockResolvedValue(context({active:[{...session,myCheckin:{role:'anchor',startAt:session.startAt,endAt:null}}]}) as never);fireEvent.click(button);expect(await screen.findByRole('button',{name:'下播'})).toBeTruthy();expect(screen.queryByRole('dialog')).toBeNull();});
 it('只是排定参与、本人尚未打卡时仍是上播',async()=>{a.checkinContext.mockResolvedValue(context({active:[{...session,myCheckin:null}]}) as never);render(<LiveCheckinPanel workspaceType="live_anchor"/>);expect(await screen.findByRole('button',{name:'上播'})).toBeTruthy();expect(screen.queryByRole('button',{name:'下播'})).toBeNull();});
 it('运营点击上播先选身份，默认中控；没有中控的场次禁用运营，不展示比例',async()=>{a.checkinContext.mockResolvedValue(context({identity:{isAnchor:false,isControl:true,isOperations:true}}) as never);render(<LiveCheckinPanel workspaceType="operations"/>);fireEvent.click(await screen.findByRole('button',{name:'上播'}));const dlg=await screen.findByRole('dialog',{name:'选择本场身份'});expect((within(dlg).getByRole('radio',{name:/^中控/}) as HTMLInputElement).checked).toBe(true);expect((within(dlg).getByRole('radio',{name:/运营/}) as HTMLInputElement).disabled).toBe(true);expect(within(dlg).getByText('本场有中控时才可选择运营身份')).toBeTruthy();expect(dlg.textContent).not.toMatch(/提成|%/);});
 it('运营默认中控无可加入场次时仍读取本人排班，无排班不提供临时开播',async()=>{a.checkinContext.mockResolvedValue(context({identity:{isAnchor:false,isControl:true,isOperations:true}}) as never);render(<LiveCheckinPanel workspaceType="operations"/>);fireEvent.click(await screen.findByRole('button',{name:'上播'}));fireEvent.click(await screen.findByRole('button',{name:'下一步：核对本场信息'}));expect(await screen.findByText('没有可开播的排班，请联系人事安排。')).toBeTruthy();expect(screen.queryByRole('button',{name:'确认上播'})).toBeNull();});
 it('有中控后运营可以选择运营身份加入，原按钮立即变下播',async()=>{a.checkinContext.mockResolvedValue(context({identity:{isAnchor:false,isControl:true,isOperations:true},joinable:[{...session,anchor:person(8,'主播'),canJoinControl:false,canJoinOperator:true}]}) as never);render(<LiveCheckinPanel workspaceType="operations"/>);fireEvent.click(await screen.findByRole('button',{name:'上播'}));const dlg=await screen.findByRole('dialog',{name:'选择本场身份'});fireEvent.click(within(dlg).getByRole('radio',{name:/运营/}));a.checkinContext.mockResolvedValue(context({identity:{isControl:true,isOperations:true},active:[{...session,myCheckin:{role:'operator',startAt:session.startAt,endAt:null}}]}) as never);fireEvent.click(within(dlg).getByRole('button',{name:'确认运营身份上播'}));await waitFor(()=>expect(a.start).toHaveBeenCalledWith({sessionId:7,role:'operator',confirmDetails:true}));expect(await screen.findByRole('button',{name:'下播'})).toBeTruthy();});
 it('飞书扫码或其他标签操作后，回到工作台会刷新本人按钮状态',async()=>{render(<LiveCheckinPanel workspaceType="live_control"/>);await screen.findByRole('button',{name:'上播'});a.checkinContext.mockResolvedValue(context({active:[{...session,myCheckin:{role:'control',startAt:session.startAt,endAt:null}}]}) as never);fireEvent.focus(window);expect(await screen.findByRole('button',{name:'下播'})).toBeTruthy();});
});
