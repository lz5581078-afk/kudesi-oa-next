import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {resourceApi} from '../../resources/api';
import {ReferencePickContext,SearchPick,referenceProductLabel} from './common';
import {referencePickOption} from './referencePickOptions';
const auth=vi.hoisted(()=>({companyId:1,id:1,permissions:{isCompanyAdmin:true,allow:[],deny:[]}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:auth})}));
vi.mock('../../resources/api',()=>({resourceApi:{list:vi.fn()}}));
const item=(id:number,title=`合成商品${id}`)=>({id,title,status:'active',data:{name:title},refLabels:{}});
const response=(items:unknown[],total=items.length)=>({items,total,page:1,pageSize:200}) as never;
const picker=(change=vi.fn(),type='finance-products',value:number|null=null)=><ReferencePickContext.Provider value><SearchPick type={type} ariaLabel="选择资料" value={value} label={value?'原账户':''} onChange={change}/></ReferencePickContext.Provider>;
beforeEach(()=>{vi.resetAllMocks();auth.companyId=1;auth.id=1;});
afterEach(()=>{cleanup();});
it('商品选择器显示原名称、品牌与名称规格，保留文字规格和公司单位名，不使用基础信息全称',()=>{
  expect(referenceProductLabel({title:'合成商品',data:{name:'合成名称',basicInfoFullName:'另一种基础全称',specQty:'00500',specUnit:'SYNTHUNIT',purchaseSpec:'千克'},refLabels:{brandId:'合成品牌'},optionLabels:{specUnit:'合成托盘'}})).toBe('合成名称 · 合成品牌 · 00500合成托盘');
  expect(referenceProductLabel({title:'合成商品',data:{specQty:0,specUnit:'B'},refLabels:{}})).toBe('合成商品 · 0包');
  expect(referencePickOption('finance-fee-items',{...item(7,'合成费用'),data:{name:'合成费用',code:'FEE'}} as never)).toMatchObject({title:'合成费用',detail:'FEE'});
  expect(referencePickOption('finance-customers',{...item(8,'合成客户'),data:{name:'合成客户',code:'CLIENT'}} as never)).toMatchObject({title:'合成客户',detail:'CLIENT'});
});
it('完整读取201条再按实际展示的品牌/规格/编码做完整短语搜索，最多展示80项而不漏后页',async()=>{
  const target={...item(201,'目标 商品'),data:{name:'目标 商品',specQty:'00500',specUnit:'SYNTHUNIT',code:'TARGET'},refLabels:{brandId:'合成品牌'},optionLabels:{specUnit:'合成托盘'}};
  vi.mocked(resourceApi.list).mockResolvedValueOnce(response(Array.from({length:200},(_,i)=>item(i+1)),201)).mockResolvedValueOnce(response([target],201));
  const change=vi.fn();render(picker(change));
  fireEvent.click(screen.getByRole('button',{name:'选择资料'}));
  await waitFor(()=>expect(screen.getAllByRole('option')).toHaveLength(80));
  expect(resourceApi.list).toHaveBeenNthCalledWith(2,'finance-products',{page:2,pageSize:200,fieldKey:undefined,fieldValue:undefined});
  fireEvent.change(screen.getByRole('textbox',{name:'搜索选择资料'}),{target:{value:'目标 商品 · 合成品牌 · 00500合成托盘 · target'}});
  fireEvent.click(screen.getByRole('option',{name:'目标 商品 · 合成品牌 · 00500合成托盘 · TARGET'}));
  expect(change).toHaveBeenCalledWith(201,'目标 商品 · 合成品牌 · 00500合成托盘',target.data,target.optionLabels);
  expect(resourceApi.list).toHaveBeenCalledTimes(2);expect(screen.queryByRole('listbox')).toBeNull();
});
it('公司切换立即关闭旧选项，旧第一页迟到不继续分页或覆盖新公司结果',async()=>{
  let oldResolve!:(value:unknown)=>void;
  vi.mocked(resourceApi.list).mockImplementationOnce(()=>new Promise(resolve=>{oldResolve=resolve as typeof oldResolve;})).mockResolvedValueOnce(response([item(2,'新公司商品')]));
  const view=render(picker());fireEvent.click(screen.getByRole('button',{name:'选择资料'}));
  await screen.findByRole('status');auth.companyId=2;view.rerender(picker());expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'选择资料'}));await screen.findByRole('option',{name:'新公司商品'});
  await act(async()=>{oldResolve(response([item(1,'旧公司商品')],201));});
  expect(screen.queryByRole('option',{name:'旧公司商品'})).toBeNull();expect(resourceApi.list).toHaveBeenCalledTimes(2);
});
it('读取失败保留选中的账户，重试与关闭不会清空账户',async()=>{
  vi.mocked(resourceApi.list).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response([]));
  const change=vi.fn();render(picker(change,'bank-accounts',5));fireEvent.click(screen.getByRole('button',{name:'选择资料'}));
  expect((await screen.findByRole('alert')).textContent).toContain('读取失败');expect(screen.getByRole('button',{name:'选择资料'}).textContent).toContain('原账户');
  fireEvent.click(screen.getByRole('button',{name:'重试'}));await screen.findByText('没有匹配资料');fireEvent.keyDown(screen.getByRole('textbox'),{key:'Escape'});
  expect(screen.queryByRole('listbox')).toBeNull();expect(change).not.toHaveBeenCalled();
});
it.each(['duplicate','missing','changed'])('拒绝%s的部分资料，不把前页当作完整选择目录',async kind=>{
  vi.mocked(resourceApi.list).mockResolvedValueOnce(response([item(1)],2)).mockResolvedValueOnce(response(kind==='missing'?[]:[item(kind==='duplicate'?1:2)],kind==='changed'?3:2));
  render(picker());fireEvent.click(screen.getByRole('button',{name:'选择资料'}));await screen.findByRole('alert');expect(screen.queryByRole('option')).toBeNull();
});
it('账户按原类型/主体店铺/尾号显示并可搜类型，缺少账号不捏造尾号',async()=>{
  const account={...item(5,'合成户名'),data:{kind:'cashier_account',accountName:'合成户名',ownerName:'合成所属人',accountNo:'00001234'}};
  expect(referencePickOption('bank-accounts',{...account,refLabels:{storeId:'合成店铺'}} as never).title).toBe('公司出纳账户 · 合成店铺 · 尾号1234');
  expect(referencePickOption('bank-accounts',{...account,data:{...account.data,accountNo:''}} as never).title).toBe('公司出纳账户 · 合成所属人');
  vi.mocked(resourceApi.list).mockResolvedValue(response([account]));const change=vi.fn();render(picker(change,'bank-accounts'));
  fireEvent.click(screen.getByRole('button',{name:'选择资料'}));await screen.findByRole('option',{name:'公司出纳账户 · 合成所属人 · 尾号1234'});
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'公司出纳账户'}});fireEvent.click(screen.getByRole('option',{name:'公司出纳账户 · 合成所属人 · 尾号1234'}));expect(change).toHaveBeenCalledWith(5,'公司出纳账户 · 合成所属人 · 尾号1234',account.data,undefined);
});
