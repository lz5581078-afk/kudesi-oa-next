import { ApiError } from '../../api/client';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ManualReportsTab} from './ManualReportsTab';
import {liveApi,type SessionDetail} from './liveApi';
import {manualSessionDraft} from './manualSessionDraft';
vi.mock('./liveApi',()=>({liveApi:{submissionStatus:vi.fn(),options:vi.fn(),sessions:vi.fn(),session:vi.fn(),manualReport:vi.fn(),candidates:vi.fn()}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({can:()=>false})}));
const api=vi.mocked(liveApi);
const channel={accountId:10,accountName:'原直播号',platform:'douyin',storeIds:[20],stores:[{id:20,name:'原店铺',jstShopId:'S'}]};
const options={rooms:[{id:1,name:'原房间'}],anchors:[{id:2,name:'原主播'}],controls:[{id:3,name:'原中控'}],operators:[{id:4,name:'原运营'}],douyinAccounts:[{id:10,name:'原直播号',platform:'douyin',storeIds:[20]}],stores:[{id:20,name:'原店铺',platform:'douyin',hasJstShop:true}]};
const original={id:42,scheduleId:6,roomId:1,roomName:'原房间',anchor:{id:2,name:'原主播'},control:{id:3,name:'原中控'},operator:{id:4,name:'原运营'},douyinAccount:{id:10,name:'原直播号'},store:{id:20,name:'原店铺'},channels:[channel],startAt:'2026-11-02 10:02:37',endAt:'2026-11-02 12:08:49',status:'pending_report',statusLabel:'待报下播',manualReason:'原特殊核定原因',products:[{id:null,code:'',name:'原手填产品',spec:''}],reports:[{role:'anchor',salesCents:12345,adSpendCents:null,note:'原主播备注',endAt:'2026-11-02 12:08:49',orders:[{orderId:'O1'}],storeLines:[{storeId:20,platform:'douyin',salesCents:12345,adSpendCents:0,orderIds:['O1'],reason:'原逐店核定原因'}]},{role:'control',salesCents:12345,adSpendCents:678,note:'原中控备注',endAt:'2026-11-02 12:08:49',orders:[{orderId:'O1'}],storeLines:[{storeId:20,platform:'douyin',salesCents:12345,adSpendCents:678,orderIds:['O1'],reason:'原中控核定'}]}]} as unknown as SessionDetail;
beforeEach(()=>{api.sessions.mockResolvedValue({rows:[original,{...original,id:43}],page:1,pageSize:8,total:2});api.submissionStatus.mockResolvedValue({ready:true,message:'审核流程已就绪'});api.options.mockResolvedValue(options as never);api.session.mockResolvedValue(original);api.manualReport.mockResolvedValue({id:42});});
afterEach(()=>{cleanup();vi.resetAllMocks();});
async function load(index=0){fireEvent.click((await screen.findAllByRole('button',{name:'选择并载入'}))[index]);}
describe('载入原场次填报',()=>{
  it('关联不一致先确认，取消不提交且保留填写内容，确认按同一份补报数据保存',async()=>{
    api.manualReport.mockRejectedValueOnce(new ApiError(409,'直播账号「原直播号」当前未关联店铺「原店铺」','LIVE_MANUAL_CHANNEL_CONFIRM_REQUIRED'));
    render(<ManualReportsTab onOpen={vi.fn()}/>);await load();await screen.findByText(/已载入原场次 #42/);
    fireEvent.change(await screen.findByLabelText('原店铺营业额'),{target:{value:'123.45'}});
    fireEvent.change(screen.getByLabelText('补报原因'),{target:{value:'实际业绩补录'}});
    fireEvent.click(screen.getByRole('button',{name:'保存并核对'}));
    expect(await screen.findByRole('dialog',{name:'确认补报账号与店铺'})).toBeTruthy();expect(api.manualReport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button',{name:'返回核对'}));expect(screen.queryByRole('dialog')).toBeNull();expect((screen.getByLabelText('原店铺营业额') as HTMLInputElement).value).toBe('123.45');
    api.manualReport.mockRejectedValueOnce(new ApiError(409,'账号与店铺关联不一致','LIVE_MANUAL_CHANNEL_CONFIRM_REQUIRED'));
    fireEvent.click(screen.getByRole('button',{name:'保存并核对'}));await screen.findByRole('dialog',{name:'确认补报账号与店铺'});
    const reported=api.manualReport.mock.calls[1][0];
    fireEvent.click(screen.getByRole('button',{name:'按本次补报数据保存并核对'}));
    await waitFor(()=>expect(api.manualReport).toHaveBeenLastCalledWith({...reported,confirmUnlinkedStores:true}));
    expect(await screen.findByText(/已保存场次 #42/)).toBeTruthy();expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('普通校验错误保持阻止保存，不提供关联差异确认',async()=>{
    api.manualReport.mockRejectedValueOnce(new ApiError(400,'店铺必须属于当前公司'));
    render(<ManualReportsTab onOpen={vi.fn()}/>);await load();await screen.findByText(/已载入原场次 #42/);
    fireEvent.click(screen.getByRole('button',{name:'保存并核对'}));
    expect((await screen.findByRole('alert')).textContent).toContain('店铺必须属于当前公司');expect(screen.queryByRole('dialog')).toBeNull();expect(api.manualReport).toHaveBeenCalledTimes(1);
  });
  it('列表失败可重试，筛选后只允许选择可补报场次',async()=>{
    api.sessions.mockRejectedValueOnce(new Error('暂时无法查询'));
    render(<ManualReportsTab onOpen={vi.fn()}/>);
    expect((await screen.findByRole('alert')).textContent).toContain('暂时无法查询');
    fireEvent.click(screen.getByRole('button',{name:'重试'}));
    await screen.findAllByRole('button',{name:'选择并载入'});
    api.sessions.mockResolvedValue({rows:[{...original,status:'approved',statusLabel:'已审核'}],page:1,pageSize:8,total:1});
    fireEvent.change(screen.getByLabelText('直播日期'),{target:{value:'2026-11-02'}});
    expect(await screen.findByText('已进入审核，无法补报')).toBeTruthy();
    expect(api.sessions).toHaveBeenLastCalledWith(expect.objectContaining({from:'2026-11-02',to:'2026-11-02',page:1}));
    expect(screen.queryByRole('button',{name:'选择并载入'})).toBeNull();
  });
  it('完整载入原值，修改后仍提交同一场次且不丢秒数和订单',async()=>{
    render(<ManualReportsTab onOpen={vi.fn()}/>);await load();
    await screen.findByText(/已载入原场次 #42/);
    expect((screen.getByLabelText('主播') as HTMLSelectElement).value).toBe('2');
    expect((screen.getByLabelText('主播') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('补报上播时间') as HTMLInputElement).value.startsWith('2026-11-02T10:02:37')).toBe(true);
    expect((screen.getByLabelText('补报下播时间') as HTMLInputElement).value.startsWith('2026-11-02T12:08:49')).toBe(true);
    expect((screen.getByLabelText('原店铺营业额') as HTMLInputElement).value).toBe('123.45');
    expect((screen.getByLabelText('原店铺投流费用') as HTMLInputElement).value).toBe('6.78');
    expect((screen.getByLabelText('补报原因') as HTMLTextAreaElement).value).toBe('原特殊核定原因');
    expect(screen.getByText(/原场次产品：原手填产品/)).toBeTruthy();
    expect(screen.getByText('已载入 1 个原订单')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('原店铺营业额'),{target:{value:'321.09'}});
    fireEvent.change(screen.getByLabelText('原店铺投流费用'),{target:{value:'12.34'}});
    fireEvent.click(screen.getByRole('button',{name:'保存并核对'}));
    await waitFor(()=>expect(api.manualReport).toHaveBeenCalledWith(expect.objectContaining({sessionId:42,startAt:'2026-11-02 10:02:37',endAt:'2026-11-02 12:08:49',salesCents:32109,adSpendCents:1234,reason:'原特殊核定原因',storeLines:[expect.objectContaining({storeId:20,salesCents:32109,adSpendCents:1234,orderIds:['O1'],reason:'原逐店核定原因'})]})));
  });
  it('更换编号时清除旧场次状态；载入失败不能带着旧数据保存',async()=>{
    render(<ManualReportsTab onOpen={vi.fn()}/>);await load();await screen.findByText(/已载入原场次 #42/);
    api.session.mockRejectedValueOnce(new Error('场次不存在'));fireEvent.click(screen.getByRole('button',{name:'重新选择场次'}));await load(1);await screen.findByRole('alert');
    expect(screen.queryByText(/已载入原场次 #42/)).toBeNull();
    expect(screen.queryByRole('button',{name:'保存并核对'})).toBeNull();
    expect(api.manualReport).not.toHaveBeenCalled();
  });
  it('慢请求返回时不能覆盖新编号载入的场次',async()=>{
    let resolve!:(value:SessionDetail)=>void;api.session.mockReturnValueOnce(new Promise(r=>{resolve=r;}));
    render(<ManualReportsTab onOpen={vi.fn()}/>);await load();
    api.session.mockResolvedValueOnce({...original,id:43,manualReason:'第二场原因'});await load(1);
    await screen.findByText(/已载入原场次 #43/);resolve(original);
    await waitFor(()=>expect((screen.getByLabelText('补报原因') as HTMLTextAreaElement).value).toBe('第二场原因'));
    expect(api.session).toHaveBeenLastCalledWith(43);
  });
  it('没有填过业绩时保持金额为空；旧记录没有分店行时从原报告还原订单和投流',()=>{
    expect(manualSessionDraft({...original,reports:[]},'now').rows[0].sales).toBe('');
    const legacy={...original,channels:undefined,manualReason:null,reports:original.reports.map(r=>({...r,storeLines:undefined}))};
    const draft=manualSessionDraft(legacy,'now');
    expect(draft.rows[0]).toMatchObject({sales:'123.45',ad:'6.78',orders:['O1'],reason:'原主播备注'});
    expect(draft.fields.reason).toBe('原主播备注');
  });
  it('已审核场次可载入核对，禁止补报保存',async()=>{
    api.session.mockResolvedValue({...original,status:'approved',statusLabel:'已审核'});
    render(<ManualReportsTab onOpen={vi.fn()}/>);await load();await screen.findByText(/已载入原场次 #42/);
    expect((screen.getByRole('button',{name:'保存并核对'}) as HTMLButtonElement).disabled).toBe(true);
  });
});
