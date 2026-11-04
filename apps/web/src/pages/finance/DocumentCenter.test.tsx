import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { documentDisplayState, documentSummary } from './DocumentCenter';
import { DocumentsPage } from './DocumentsPage';
import { financeApi, type DocDetailDto, type DocList, type DocRow } from './financeApi';
const auth=vi.hoisted(()=>({companyId:1,id:1,pending:true,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:auth,can:(key:string)=>key==='finance.drafts.view'?auth.pending:true})}));
vi.mock('./financeApi',()=>({financeApi:{docs:vi.fn(),doc:vi.fn(),registerOpeningPrepayment:vi.fn(),uploadOpeningVoucher:vi.fn(),openingVoucherUrl:vi.fn()}}));
const day='2026-11-03';
const row=(id:number,patch:Partial<DocRow>={}):DocRow=>({id,docNo:`SYNTHETIC-${id}`,docType:'sale',typeLabel:'普通销售单',status:'draft',docDate:day,amountCents:100,paidCents:0,bankName:null,handler:`合成 经办${id}`,auditedAt:null,createdBy:1,memo:null,reversesId:null,partyName:`合成对象${id}`,createdByName:'合成管理员',direction:'in',source:'手工制单',...patch});
const result=(rows:DocRow[],total=rows.length):DocList=>({rows,total,page:1,pageSize:200,amountCents:rows.reduce((sum,row)=>sum+row.amountCents,0),paidCents:0,todayCount:rows.length});
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();auth.companyId=1;auth.pending=true;vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));});
afterEach(()=>{cleanup();vi.useRealTimers();});
it('默认当天；全部201条完整读取，再使用原20条本地分页，没有新版附加工具',async()=>{
  const records=Array.from({length:201},(_,index)=>row(index+1));
  vi.mocked(financeApi.docs).mockImplementation(async query=>result(records.slice(((query.page??1)-1)*200,(query.page??1)*200),201));
  render(<DocumentsPage scope="history"/>);
  await screen.findByText('SYNTHETIC-99');
  expect(financeApi.docs).toHaveBeenCalledWith({scope:'history',includeDrafts:'yes',page:2,pageSize:200});
  expect(screen.getByLabelText('开始日期')).toHaveProperty('value',day);expect(screen.getByLabelText('结束日期')).toHaveProperty('value',day);
  expect(screen.queryByText('SYNTHETIC-1',{exact:true})).toBeNull();
  expect(screen.queryByRole('toolbar',{name:'批量操作'})).toBeNull();
  expect(screen.queryByRole('button',{name:'批量过账'})).toBeNull();expect(screen.queryByRole('button',{name:'导出本页'})).toBeNull();
  expect(screen.queryByRole('button',{name:'本月'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'下一页'}));
  expect(await screen.findByText('SYNTHETIC-80')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox',{name:'经营历程搜索'}),{target:{value:'SYNTHETIC-201'}});
  expect(screen.getByText('SYNTHETIC-201')).toBeTruthy();
});
it('原筛选在完整记录上即时生效，重置清空日期；查询才重新读取，费用摘要用原费用类型回退',async()=>{
  const records=[row(1,{amountCents:10000,status:'posted'}),row(2,{docType:'expense',typeLabel:'费用单',amountCents:5000,direction:'out',status:'posted',summary:null,firstItemName:'合成费用类别',memo:'合成费用备注'}),row(3,{docType:'transfer',typeLabel:'转款单',direction:'internal',amountCents:2000,status:'issued'}),row(4,{docDate:'2026-11-02',amountCents:3000})];
  vi.mocked(financeApi.docs).mockResolvedValue(result(records));render(<DocumentsPage scope="history"/>);
  await screen.findByText('SYNTHETIC-1');const stats=screen.getByLabelText('汇总');
  expect(within(stats).getByText('3 条')).toBeTruthy();expect(screen.getByText('合成费用类别')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('收支方向'),{target:{value:'out'}});
  expect(within(stats).getByText('1 条')).toBeTruthy();expect(screen.queryByText('SYNTHETIC-1')).toBeNull();
  expect(financeApi.docs).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'重置'}));
  expect(screen.getByLabelText('开始日期')).toHaveProperty('value','');expect(within(stats).getByText('4 条')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'查询'}));await waitFor(()=>expect(financeApi.docs).toHaveBeenCalledTimes(2));
});
it('草稿中心原八列含来源；只请求草稿，原查看窗口保留精确单价/金额/备注和资金事实',async()=>{
  const record=row(1,{amountCents:275,paidCents:275});
  const detail={...record,partyId:1,partyKind:'customer',storeId:null,refNo:null,bankAccountId:9,bankName:'合成收款户',toBankAccountId:null,toBankName:'',warehouseId:null,warehouseName:'',paidCents:275,offsetCents:0,department:null,reversedById:null,entries:[],events:[],accounts:[],lines:[{id:1,lineNo:1,productId:1,productName:'合成商品',feeItemName:'',itemName:null,qty:2.5,unit:'包',unitPriceCents:110.0099,unitCostCents:null,memo:'合成行备注',relatedNode:null,relatedId:null,relatedName:null}]} as unknown as DocDetailDto;
  vi.mocked(financeApi.docs).mockResolvedValue(result([record]));vi.mocked(financeApi.doc).mockResolvedValue(detail);
  render(<DocumentsPage scope="drafts"/>);fireEvent.click(await screen.findByRole('button',{name:'查看草稿'}));
  const modal=await screen.findByRole('dialog',{name:'普通销售单'});await within(modal).findByText('合成商品');
  expect(financeApi.docs).toHaveBeenCalledWith({scope:'drafts',status:'draft',page:1,pageSize:200});
  expect(within(modal).getByText('¥1.100099')).toBeTruthy();expect(within(modal).getAllByText('¥2.75')).toHaveLength(4);
  expect(within(modal).getByText('合成行备注')).toBeTruthy();expect(within(modal).getByText('合成收款户')).toBeTruthy();
  expect(screen.queryByLabelText('收支方向')).toBeNull();expect(screen.queryByRole('button',{name:'过账'})).toBeNull();
  fireEvent.click(within(modal).getByRole('button',{name:'关闭'}));expect(screen.queryByRole('dialog')).toBeNull();
});
it('草稿表搜索仍包含原经办人等未显示字段，多条搜索不把内部空格拆散',async()=>{
  vi.mocked(financeApi.docs).mockResolvedValue(result([row(1),row(2)]));render(<DocumentsPage scope="drafts"/>);await screen.findByText('SYNTHETIC-1');
  fireEvent.change(screen.getByRole('textbox',{name:'草稿中心搜索'}),{target:{value:'合成 经办1'}});
  expect(screen.queryByText('SYNTHETIC-2')).toBeNull();expect(screen.getByText('SYNTHETIC-1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'清空'}));
  expect(screen.getByText('SYNTHETIC-2')).toBeTruthy();
});
it('没有草稿权限不请求扩大范围；切公司后旧首屏不继续分页或覆盖新公司',async()=>{
  auth.pending=false;vi.mocked(financeApi.docs).mockResolvedValueOnce(result([]));
  const restricted=render(<DocumentsPage scope="history"/>);await waitFor(()=>expect(financeApi.docs).toHaveBeenCalledWith({scope:'history',page:1,pageSize:200}));
  expect(within(screen.getByLabelText('单据状态')).queryByRole('option',{name:'草稿'})).toBeNull();restricted.unmount();
  auth.pending=true;vi.mocked(financeApi.docs).mockClear();let finish!:(value:DocList)=>void;
  vi.mocked(financeApi.docs).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce(result([row(900,{docNo:'乙公司资料'})]));
  const view=render(<DocumentsPage scope="history"/>);await waitFor(()=>expect(finish).toBeTruthy());
  fireEvent.change(screen.getByLabelText('关键词'),{target:{value:'甲公司旧条件'}});auth.companyId=2;view.rerender(<DocumentsPage scope="history"/>);
  await screen.findByText('乙公司资料');await act(async()=>finish(result(Array.from({length:200},(_,index)=>row(index+1)),201)));
  expect(screen.queryByText('SYNTHETIC-1')).toBeNull();expect(financeApi.docs).toHaveBeenCalledTimes(2);expect(screen.getByLabelText('关键词')).toHaveProperty('value','');
});
it('分页数据变动或缺页时保留已确认列表，不把部分结果当成全量',async()=>{
  vi.mocked(financeApi.docs).mockResolvedValueOnce(result([row(1)]));render(<DocumentsPage scope="history"/>);await screen.findByText('SYNTHETIC-1');
  const first=Array.from({length:200},(_,index)=>row(index+2));
  vi.mocked(financeApi.docs).mockResolvedValueOnce(result(first,201)).mockResolvedValueOnce(result([first[199]],201));
  fireEvent.click(screen.getByRole('button',{name:'查询'}));expect((await screen.findByRole('alert')).textContent).toContain('顺序发生变动');
  expect(screen.getByText('SYNTHETIC-1')).toBeTruthy();expect(screen.queryByText('SYNTHETIC-201')).toBeNull();
  vi.mocked(financeApi.docs).mockResolvedValueOnce(result([],1));fireEvent.click(screen.getByRole('button',{name:'重试'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('未能完整读取'));
  expect(screen.getByText('SYNTHETIC-1')).toBeTruthy();
});
it('默认日期沿用原UTC日，不随新版月份记忆或其他时区切日',async()=>{
  vi.setSystemTime(new Date('2026-11-03T21:00:00Z'));vi.mocked(financeApi.docs).mockResolvedValue(result([]));
  render(<DocumentsPage scope="history"/>);await waitFor(()=>expect(financeApi.docs).toHaveBeenCalled());
  expect(screen.getByLabelText('开始日期')).toHaveProperty('value','2026-11-03');expect(screen.getByLabelText('结束日期')).toHaveProperty('value','2026-11-03');
});

it('手工与流程费用依结构化来源区分摘要及状态，不依赖显示名称',()=>{
 const manual=row(1,{docType:'expense',status:'posted',sourceKind:'manual',source:'流程自动记账',firstItemName:'手工费用类别',memo:'保留备注'});
 const workflow=row(2,{docType:'expense',status:'posted',sourceKind:'workflow',source:'其他显示名称',firstItemName:'不得替代摘要的费用类别',memo:'流程原摘要'});
 expect(documentSummary(manual)).toBe('手工费用类别');expect(documentDisplayState(manual)).toBe('completed');
 expect(documentSummary(workflow)).toBe('流程原摘要');expect(documentDisplayState(workflow)).toBe('issued');
});

it('手工费用查看保持原摘要式内窗，不增加普通单据明细和资金区块',async()=>{
 const record=row(1,{docType:'expense',typeLabel:'费用单',sourceKind:'manual',firstItemName:'合成办公费',memo:'费用原备注'});
 vi.mocked(financeApi.docs).mockResolvedValue(result([record]));vi.mocked(financeApi.doc).mockResolvedValue({...record,lines:[],accounts:[],entries:[],events:[]} as unknown as DocDetailDto);
 render(<DocumentsPage scope="history"/>);fireEvent.click(await screen.findByRole('button',{name:'查看'}));
 const dialog=await screen.findByRole('dialog',{name:'费用单'});await within(dialog).findByRole('heading',{name:'单据摘要'});
 expect(within(dialog).getByText('合成办公费')).toBeTruthy();expect(within(dialog).getByText('费用原备注')).toBeTruthy();
 expect(within(dialog).queryByRole('heading',{name:'单据明细'})).toBeNull();expect(within(dialog).queryByRole('heading',{name:'资金账户'})).toBeNull();
 expect(documentSummary({...record,firstItemName:null})).toBe('-');
});
