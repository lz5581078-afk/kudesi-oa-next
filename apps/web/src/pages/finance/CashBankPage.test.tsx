import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CashBankPage} from './CashBankPage';
import {financeApi,type BankBalance,type StoreFund} from './financeApi';
import {resourceApi} from '../../resources/api';
const auth=vi.hoisted(()=>({id:1,companyId:1,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:auth,can:()=>true})}));
vi.mock('./financeApi',()=>({financeApi:{banks:vi.fn(),storeFunds:vi.fn(),keyAccounts:vi.fn(),setKeyAccount:vi.fn()}}));
vi.mock('../../resources/api',()=>({resourceApi:{list:vi.fn()}}));
const bank=(id:number,title:string,kind='company_public',patch:Partial<BankBalance>={}):BankBalance=>({id,title,kind,status:'normal',openingCents:0,movementCents:0,balanceCents:10000,entries:0,bank:'合成银行',ownerName:'合成户主',keeperName:'合成保管人',licenseName:'合成主体',storeIds:[],storeNames:[],updatedAt:null,...patch});
const store=(id:number,name:string):StoreFund=>({storeId:id,name,platform:'pdd',platformLabel:'拼多多',storeNo:'SYNTHETIC-'+id,platformStoreId:'PLATFORM-'+id,snapshotDate:'',updatedAt:null,withdrawableCents:5000,depositCents:0,frozenCents:0,promotionCents:0});
const numbers=(ids:number[],total=ids.length)=>({items:ids.map(id=>({id,title:'合成账户',data:{accountNo:'6222000000000'+id}})),total,page:1,pageSize:200}) as never;
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();auth.id=1;auth.companyId=1;vi.mocked(financeApi.banks).mockResolvedValue([bank(11,'合成公司主户'),bank(12,'合成店铺收款户','store_public',{storeIds:[31],storeNames:['合成店铺']})]);vi.mocked(financeApi.storeFunds).mockResolvedValue([store(31,'合成店铺')]);vi.mocked(financeApi.keyAccounts).mockResolvedValue([11]);vi.mocked(resourceApi.list).mockResolvedValue(numbers([11,12]));});
afterEach(cleanup);
it('公司账户严格只列原三类，不把其他卡计入；账户名称只读且无附加筛选/导出/账本',async()=>{
  vi.mocked(financeApi.banks).mockResolvedValue([bank(11,'公司公户','company_public',{balanceCents:10000}),bank(12,'公司银行卡','company_card',{balanceCents:20000}),bank(13,'出纳账户','cashier_account',{balanceCents:30000}),bank(14,'法人卡','legal_person_card',{balanceCents:40000}),bank(15,'其他卡','other',{balanceCents:50000}),bank(16,'店铺卡','store_personal_card',{balanceCents:60000})]);
  render(<CashBankPage/>);await screen.findByText('公司公户',{selector:'strong'});expect(screen.getByText('公司账户余额').parentElement?.textContent).toContain('¥600.00');
  const company=screen.getByRole('region',{name:'公司账户'});fireEvent.click(within(company).getByRole('button',{name:'展开 3 个账户'}));expect(within(company).getByText('公司银行卡',{selector:'strong'})).toBeTruthy();expect(within(company).queryByText('法人卡')).toBeNull();expect(within(company).queryByText('其他卡')).toBeNull();
  expect(screen.queryByLabelText('账户类型')).toBeNull();expect(screen.queryByRole('button',{name:'导出账户余额'})).toBeNull();expect(screen.queryByRole('button',{name:'公司公户'})).toBeNull();
});
it('关联收款账户恢复六列且只含店铺账户；关联店铺恢复平台/编号/可提现余额四列',async()=>{
  vi.mocked(financeApi.banks).mockResolvedValue([bank(11,'合成公司主户','company_public',{storeIds:[31]}),bank(12,'合成店铺收款户','store_public',{storeIds:[31]}),bank(13,'合成其他卡','other',{storeIds:[31]})]);
  render(<CashBankPage/>);fireEvent.click(await screen.findByRole('button',{name:'展开 1 家店铺'}));fireEvent.click(screen.getByRole('button',{name:'查看账户'}));
  const dialog=await screen.findByRole('dialog',{name:'合成店铺 / 关联收款账户'});expect(within(dialog).getAllByRole('columnheader')).toHaveLength(6);expect(within(dialog).queryByRole('button',{name:'显示字段'})).toBeNull();expect(within(dialog).getByText('622200000000012')).toBeTruthy();expect(within(dialog).queryByText('合成公司主户')).toBeNull();expect(within(dialog).queryByText('合成其他卡')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button',{name:'关闭'}));fireEvent.click(within(screen.getByRole('region',{name:'店铺公户与店铺个人银行卡'})).getByRole('button',{name:'展开 1 个账户'}));fireEvent.click(screen.getByRole('button',{name:'查看店铺'}));
  const stores=await screen.findByRole('dialog',{name:'合成店铺收款户 / 关联店铺'});expect(within(stores).getAllByRole('columnheader')).toHaveLength(4);expect(within(stores).getByText('SYNTHETIC-31')).toBeTruthy();expect(within(stores).getByText('拼多多')).toBeTruthy();
});
it('重点保存互斥，失败回读原标记且保留实际余额，之后可重试',async()=>{
  let fail!:(error:unknown)=>void;vi.mocked(financeApi.setKeyAccount).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject;}));render(<CashBankPage/>);fireEvent.click(within(await screen.findByRole('region',{name:'店铺公户与店铺个人银行卡'})).getByRole('button',{name:'展开 1 个账户'}));
  const panel=screen.getByRole('region',{name:'店铺公户与店铺个人银行卡'}),button=within(panel).getByRole('button',{name:'设为重点'});fireEvent.click(button);fireEvent.click(button);expect(financeApi.setKeyAccount).toHaveBeenCalledTimes(1);expect(button).toHaveProperty('disabled',true);
  await act(async()=>fail(new Error('合成标记保存失败')));await screen.findByText('合成标记保存失败');await waitFor(()=>expect(within(panel).getByRole('button',{name:'设为重点'})).toHaveProperty('disabled',false));expect(screen.getByText('公司账户余额').parentElement?.textContent).toContain('¥100.00');
  vi.mocked(financeApi.setKeyAccount).mockResolvedValueOnce([11,12]);fireEvent.click(within(panel).getByRole('button',{name:'设为重点'}));await waitFor(()=>expect(within(screen.getByRole('region',{name:'重点账户'})).getByText('合成店铺收款户')).toBeTruthy());
});
it('账号完整读取201项，跨页后才能提交完整账户视图',async()=>{
  vi.mocked(financeApi.banks).mockResolvedValue([bank(201,'合成第二页账户')]);vi.mocked(financeApi.keyAccounts).mockResolvedValue([201]);vi.mocked(resourceApi.list).mockImplementation(async(_type,query)=>query?.page===2?numbers([201],201):numbers(Array.from({length:200},(_,index)=>index+1),201));
  render(<CashBankPage/>);await screen.findByText('6222000000000201');expect(resourceApi.list).toHaveBeenCalledWith('bank-accounts',{page:2,pageSize:200,showHidden:true});expect(resourceApi.list).toHaveBeenCalledTimes(2);
});
it('切公司清空筛选和旧响应，旧首屏不再继续分页',async()=>{
  let finish!:(value:never)=>void;vi.mocked(resourceApi.list).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce(numbers([21]));
  vi.mocked(financeApi.banks).mockImplementation(async()=>auth.companyId===1?[bank(11,'甲公司账户')]:[bank(21,'乙公司账户')]);vi.mocked(financeApi.keyAccounts).mockImplementation(async()=>auth.companyId===1?[11]:[21]);vi.mocked(financeApi.storeFunds).mockResolvedValue([]);
  const view=render(<CashBankPage/>);await waitFor(()=>expect(finish).toBeTruthy());fireEvent.change(screen.getByLabelText('搜索账户'),{target:{value:'甲条件'}});auth.companyId=2;view.rerender(<CashBankPage/>);await screen.findByText('乙公司账户');
  await act(async()=>finish(numbers(Array.from({length:200},(_,index)=>index+1),201)));expect(resourceApi.list).toHaveBeenCalledTimes(2);expect(screen.queryByText('甲公司账户')).toBeNull();expect(screen.getByLabelText('搜索账户')).toHaveProperty('value','');
});
it('同公司换用户后读取自己的重点标记，旧用户迟到保存不覆盖',async()=>{
  let finish!:(ids:number[])=>void;vi.mocked(financeApi.keyAccounts).mockImplementation(async()=>auth.id===1?[11]:[12]);vi.mocked(financeApi.setKeyAccount).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<CashBankPage/>);fireEvent.click(await screen.findByRole('button',{name:'取消重点'}));auth.id=2;view.rerender(<CashBankPage/>);await within(screen.getByRole('region',{name:'重点账户'})).findByText('合成店铺收款户');
  await act(async()=>finish([]));expect(within(screen.getByRole('region',{name:'重点账户'})).getByText('合成店铺收款户')).toBeTruthy();expect(within(screen.getByRole('region',{name:'重点账户'})).queryByText('合成公司主户')).toBeNull();
});
it('账号缺页或重复时显示读取失败，不把部分数据当作完整结果',async()=>{
  vi.mocked(resourceApi.list).mockResolvedValueOnce(numbers([11],2)).mockResolvedValueOnce(numbers([11],2));render(<CashBankPage/>);await screen.findByText('账户资料未能完整读取，请重新打开页面。');expect(screen.queryByRole('table')).toBeNull();expect(resourceApi.list).toHaveBeenCalledTimes(2);
});
