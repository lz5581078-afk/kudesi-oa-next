import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {PayrollTab} from './PayrollTab';
import {liveApi} from './liveApi';
import {downloadText} from '../../resources/csv';
vi.mock('./liveApi',()=>({liveApi:{commissions:vi.fn(),wages:vi.fn()}}));
vi.mock('../../resources/csv',async orig=>({...await orig<typeof import('../../resources/csv')>(),downloadText:vi.fn()}));
const base={platform:'douyin',userId:5,userName:'演示运营',role:'control',roleLabel:'中控',date:'2026-11-01',roomName:'直播间-南7',douyinName:'演示号',adSpendCents:0,roiScaled:null,belowRoi:false,rateUnits:200,ruleVersionId:1};
const rows=[{...base,id:1,sessionId:10,startAt:'2026-11-01 11:00',endAt:'2026-11-01 13:00',products:[{id:null,name:'玉米种子',code:'',spec:''}],finalSalesCents:83900,amountCents:1678},{...base,id:2,sessionId:11,startAt:'2026-11-01 18:00',endAt:'2026-11-01 21:00',products:[{id:8,name:'花生种子',code:'P1',spec:'大包'}],finalSalesCents:42300,amountCents:846}];
beforeEach(()=>{vi.mocked(liveApi.commissions).mockResolvedValue({month:'2026-11',scope:'all',rows,summary:[],totalCents:2524} as never);vi.mocked(liveApi.wages).mockResolvedValue({month:'2026-11',scope:'all',rows:[],summary:[],totalCents:0});});
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe('工资提成明细的场次信息',()=>{
 it('同一天同房间的两场显示不同起止和产品，零计时工资不影响实际时间',async()=>{
  render(<PayrollTab role="operator" onOpen={vi.fn()}/>);
  const table=await screen.findByRole('table',{name:'工资提成明细'});
  await within(table).findByText('11:00–13:00');
  expect(within(table).getByText('18:00–21:00')).toBeTruthy();
  expect(within(table).getByText('产品：玉米种子')).toBeTruthy();expect(within(table).getByText('产品：花生种子（大包）')).toBeTruthy();
  expect(within(table).getAllByText((_,el)=>el?.tagName==='TD'&&el.textContent==='0 小时 0 分¥0.00/时')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:'导出明细'}));
  expect(downloadText).toHaveBeenCalledWith('直播工资明细.csv',expect.stringContaining('2026-11-01 18:00'));
  expect(vi.mocked(downloadText).mock.calls[0][1]).toContain('直播开始时间');expect(vi.mocked(downloadText).mock.calls[0][1]).toContain('花生种子（大包）');
 });
 it('跨日下播显示日期，历史未填写数据明确提示',async()=>{
  vi.mocked(liveApi.commissions).mockResolvedValue({month:'2026-11',scope:'mine',summary:[],totalCents:2524,rows:[{...rows[0],startAt:'2026-11-01 23:00',endAt:'2026-11-02 01:00'}, {...rows[1],endAt:null,products:[]}]} as never);
  render(<PayrollTab role="operator" onOpen={vi.fn()}/>);
  await screen.findByText('23:00–11-02 01:00');
  expect(screen.getByText('18:00–下播时间未记录')).toBeTruthy();expect(screen.getByText('产品：未填写')).toBeTruthy();
 });
});
