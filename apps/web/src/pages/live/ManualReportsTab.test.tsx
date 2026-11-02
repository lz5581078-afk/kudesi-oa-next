import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ManualReportsTab} from './ManualReportsTab';
import {liveApi,type SessionDetail} from './liveApi';
import {manualSessionDraft} from './manualSessionDraft';
vi.mock('./liveApi',()=>({liveApi:{submissionStatus:vi.fn(),options:vi.fn(),session:vi.fn(),manualReport:vi.fn(),candidates:vi.fn()}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({can:()=>false})}));
const api=vi.mocked(liveApi);
const channel={accountId:10,accountName:'原直播号',platform:'douyin',storeIds:[20],stores:[{id:20,name:'原店铺',jstShopId:'S'}]};
const options={rooms:[{id:1,name:'原房间'}],anchors:[{id:2,name:'原主播'}],controls:[{id:3,name:'原中控'}],operators:[{id:4,name:'原运营'}],douyinAccounts:[{id:10,name:'原直播号',platform:'douyin',storeIds:[20]}],stores:[{id:20,name:'原店铺',platform:'douyin',hasJstShop:true}]};
const original={id:42,scheduleId:6,roomId:1,roomName:'原房间',anchor:{id:2,name:'原主播'},control:{id:3,name:'原中控'},operator:{id:4,name:'原运营'},douyinAccount:{id:10,name:'原直播号'},store:{id:20,name:'原店铺'},channels:[channel],startAt:'2026-11-02 10:02:37',endAt:'2026-11-02 12:08:49',status:'pending_report',statusLabel:'待报下播',manualReason:'原特殊核定原因',products:[{id:null,code:'',name:'原手填产品',spec:''}],reports:[{role:'anchor',salesCents:12345,adSpendCents:null,note:'原主播备注',endAt:'2026-11-02 12:08:49',orders:[{orderId:'O1'}],storeLines:[{storeId:20,platform:'douyin',salesCents:12345,adSpendCents:0,orderIds:['O1'],reason:'原逐店核定原因'}]},{role:'control',salesCents:12345,adSpendCents:678,note:'原中控备注',endAt:'2026-11-02 12:08:49',orders:[{orderId:'O1'}],storeLines:[{storeId:20,platform:'douyin',salesCents:12345,adSpendCents:678,orderIds:['O1'],reason:'原中控核定'}]}]} as unknown as SessionDetail;
beforeEach(()=>{api.submissionStatus.mockResolvedValue({ready:true,message:'审核流程已就绪'});api.options.mockResolvedValue(options as never);api.session.mockResolvedValue(original);api.manualReport.mockResolvedValue({id:42});});
afterEach(()=>{cleanup();vi.resetAllMocks();});
function load(id='42'){fireEvent.change(screen.getByLabelText('补报场次编号'),{target:{value:id}});fireEvent.click(screen.getByRole('button',{name:'载入原场次'}));}
describe('载入原场次填报',()=>{
  it('完整载入原值，修改后仍提交同一场次且不丢秒数和订单',async()=>{
    render(<ManualReportsTab onOpen={vi.fn()}/>);await screen.findByRole('option',{name:'原主播'});load();
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
    render(<ManualReportsTab onOpen={vi.fn()}/>);await screen.findByRole('option',{name:'原主播'});load();await screen.findByText(/已载入原场次 #42/);
    api.session.mockRejectedValueOnce(new Error('场次不存在'));load('99');await screen.findByRole('alert');
    expect(screen.queryByText(/已载入原场次 #42/)).toBeNull();
    expect((screen.getByRole('button',{name:'保存并核对'}) as HTMLButtonElement).disabled).toBe(true);
    expect(api.manualReport).not.toHaveBeenCalled();
  });
  it('慢请求返回时不能覆盖新编号载入的场次',async()=>{
    let resolve!:(value:SessionDetail)=>void;api.session.mockReturnValueOnce(new Promise(r=>{resolve=r;}));
    render(<ManualReportsTab onOpen={vi.fn()}/>);await screen.findByRole('option',{name:'原主播'});load();
    fireEvent.change(screen.getByLabelText('补报场次编号'),{target:{value:'43'}});
    api.session.mockResolvedValueOnce({...original,id:43,manualReason:'第二场原因'});fireEvent.click(screen.getByRole('button',{name:'载入原场次'}));
    await screen.findByText(/已载入原场次 #43/);resolve(original);
    await waitFor(()=>expect((screen.getByLabelText('补报原因') as HTMLTextAreaElement).value).toBe('第二场原因'));
    expect((screen.getByLabelText('补报场次编号') as HTMLInputElement).value).toBe('43');
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
    render(<ManualReportsTab onOpen={vi.fn()}/>);await screen.findByRole('option',{name:'原主播'});load();await screen.findByText(/已载入原场次 #42/);
    expect((screen.getByRole('button',{name:'保存并核对'}) as HTMLButtonElement).disabled).toBe(true);
  });
});
