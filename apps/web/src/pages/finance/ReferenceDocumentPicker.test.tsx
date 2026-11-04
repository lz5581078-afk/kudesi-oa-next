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
const emptyPicker=(change=vi.fn(),value:number|null=null)=><ReferencePickContext.Provider value><SearchPick type="stores" referenceLabel="booking" emptyTextPlaceholder="名称/编号（可手工填写）" ariaLabel="挂账对象" value={value} label={value?'合成历史店铺':''} onChange={change}/></ReferencePickContext.Provider>;
it('完整目录确认为空后恢复原手填，文字只回传空ID；已有历史ID不会因候选为空自行丢掉',async()=>{
  vi.mocked(resourceApi.list).mockResolvedValue(response([]));const change=vi.fn(),view=render(emptyPicker(change));const field=await screen.findByRole('textbox',{name:'挂账对象'});expect(field.getAttribute('placeholder')).toBe('名称/编号（可手工填写）');fireEvent.change(field,{target:{value:'合成手填店铺'}});expect(change).toHaveBeenCalledWith(null,'合成手填店铺');expect(resourceApi.list).toHaveBeenCalledTimes(1);
  view.unmount();change.mockClear();const selected=render(emptyPicker(change,7));await waitFor(()=>expect(resourceApi.list).toHaveBeenCalledTimes(2));expect(screen.getByRole('button',{name:'挂账对象'}).textContent).toContain('合成历史店铺');expect(screen.queryByRole('textbox',{name:'挂账对象'})).toBeNull();expect(change).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'挂账对象'}));fireEvent.click(await screen.findByRole('option',{name:'清空当前选择'}));selected.rerender(emptyPicker(change));expect(await screen.findByRole('textbox',{name:'挂账对象'})).toBeTruthy();
});
it('目录读取失败保留重试，不作为真实空目录手填；重试成功为空才切换原手填',async()=>{
  vi.mocked(resourceApi.list).mockRejectedValueOnce(new Error('合成失败')).mockResolvedValue(response([]));render(emptyPicker());fireEvent.click(screen.getByRole('button',{name:'挂账对象'}));await screen.findByRole('alert');expect(screen.queryByRole('textbox',{name:'挂账对象'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'重试'}));expect(await screen.findByRole('textbox',{name:'挂账对象'})).toBeTruthy();
});
it('跨公司迟到的空目录不能把新公司已有资料选择器换成自由文字',async()=>{
  let resolve!:(value:never)=>void;vi.mocked(resourceApi.list).mockReturnValueOnce(new Promise(done=>{resolve=done;})).mockResolvedValue(response([item(8,'合成新公司店铺')]));const view=render(emptyPicker());await waitFor(()=>expect(resourceApi.list).toHaveBeenCalledTimes(1));auth.companyId=2;view.rerender(emptyPicker());await waitFor(()=>expect(resourceApi.list).toHaveBeenCalledTimes(2));await act(async()=>{resolve(response([]));});expect(screen.queryByRole('textbox',{name:'挂账对象'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'挂账对象'}));expect(await screen.findByRole('option',{name:'合成新公司店铺'})).toBeTruthy();
});
it('排除已添加账户发生在80项展示限制之前，动态取消排除不重读或遗漏后面的账户',async()=>{
  vi.mocked(resourceApi.list).mockResolvedValue(response(Array.from({length:82},(_,index)=>item(index+1,`合成账户${index+1}`))));
  const show=(excludeIds:number[])=><ReferencePickContext.Provider value><SearchPick type="bank-accounts" ariaLabel="选择账户" value={null} onChange={vi.fn()} excludeIds={excludeIds}/></ReferencePickContext.Provider>;
  const view=render(show([1,2]));fireEvent.click(screen.getByRole('button',{name:'选择账户'}));await waitFor(()=>expect(screen.getAllByRole('option')).toHaveLength(80));expect(screen.queryByRole('option',{name:'合成账户1'})).toBeNull();expect(screen.getByRole('option',{name:'合成账户82'})).toBeTruthy();
  view.rerender(show([]));expect(screen.getAllByRole('option')).toHaveLength(80);expect(screen.getByRole('option',{name:'合成账户1'})).toBeTruthy();expect(resourceApi.list).toHaveBeenCalledTimes(1);
});
beforeEach(()=>{vi.resetAllMocks();auth.companyId=1;auth.id=1;});
afterEach(()=>{cleanup();});
it('商品选择器显示原名称、品牌与名称规格，保留文字规格和公司单位名，不使用基础信息全称',()=>{
  expect(referenceProductLabel({title:'合成商品',data:{name:'合成名称',basicInfoFullName:'另一种基础全称',specQty:'00500',specUnit:'SYNTHUNIT',purchaseSpec:'千克'},refLabels:{brandId:'合成品牌'},optionLabels:{specUnit:'合成托盘'}})).toBe('合成名称 · 合成品牌 · 00500合成托盘');
  expect(referenceProductLabel({title:'合成商品',data:{specQty:0,specUnit:'B'},refLabels:{}})).toBe('合成商品 · 0包');
  expect(referencePickOption('finance-fee-items',{...item(7,'合成费用'),data:{name:'合成费用',code:'FEE'}} as never)).toMatchObject({title:'合成费用',detail:'FEE'});
  expect(referencePickOption('finance-customers',{...item(8,'合成客户'),data:{name:'合成客户',code:'CLIENT'}} as never)).toMatchObject({title:'合成客户',detail:'CLIENT'});
});
it('挂账对象按各资料的原名称编号展示并可搜索，商品对象不套商品行规格格式',async()=>{
  const row={...item(7,'合成商品'),data:{name:'合成商品',code:'P001',specQty:500,specUnit:'包'},refLabels:{brandId:'合成品牌'}};vi.mocked(resourceApi.list).mockResolvedValue(response([row]));const change=vi.fn();render(<ReferencePickContext.Provider value><SearchPick type="finance-products" referenceLabel="booking" ariaLabel="挂账对象" value={null} onChange={change}/></ReferencePickContext.Provider>);
  fireEvent.click(screen.getByRole('button',{name:'挂账对象'}));fireEvent.change(await screen.findByRole('textbox',{name:'搜索挂账对象'}),{target:{value:'合成商品 · P001'}});fireEvent.click(await screen.findByRole('option',{name:'合成商品 · P001'}));expect(change).toHaveBeenCalledWith(7,'合成商品 · P001',row.data,undefined);
  expect(referencePickOption('stores',{...item(8),data:{name:'合成店',storeNo:'S001'}} as never,'booking').title).toBe('合成店 · S001');
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

it('原单据表头对象显示客户名称编码与店铺平台名称编号，完整文字保留在选中态',async()=>{
  const customer={...item(7,'合成客户标题'),data:{name:'合成客户',code:'CLIENT'}};
  expect(referencePickOption('finance-customers',customer as never,'party')).toMatchObject({title:'合成客户 · CLIENT'});
  expect(referencePickOption('stores',{...item(8),data:{name:'合成店',storeNo:'STORE8',platform:'pdd'}} as never,'party').title).toBe('拼多多 · 合成店 · STORE8');
  expect(referencePickOption('stores',{...item(8),data:{name:'合成店',storeNo:'STORE8',platform:'SYNTH'},optionLabels:{platform:'合成平台'}} as never,'party').title).toBe('合成平台 · 合成店 · STORE8');
  vi.mocked(resourceApi.list).mockResolvedValue(response([customer]));const change=vi.fn();render(<ReferencePickContext.Provider value><SearchPick type="finance-customers" referenceLabel="party" ariaLabel="客户" value={null} onChange={change}/></ReferencePickContext.Provider>);
  fireEvent.click(screen.getByRole('button',{name:'客户'}));fireEvent.click(await screen.findByRole('option',{name:'合成客户 · CLIENT'}));expect(change).toHaveBeenCalledWith(7,'合成客户 · CLIENT',customer.data,undefined);
});
