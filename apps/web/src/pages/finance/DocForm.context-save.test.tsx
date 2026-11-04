import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DocForm} from './DocForm';
import {VoucherPage} from './VoucherPage';
import {financeApi} from './financeApi';
import {resourceApi} from '../../resources/api';
import {StrictMode} from 'react';
const auth=vi.hoisted(()=>({id:1,companyId:1,name:'合成管理员',companyName:'合成当前公司',permissions:{isCompanyAdmin:true,allow:[] as string[],deny:[] as string[]}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:auth,can:()=>true})}));
vi.mock('./financeApi',async original=>({...await original<typeof import('./financeApi')>(),financeApi:{banks:vi.fn(),openItems:vi.fn(),docs:vi.fn(),doc:vi.fn(),partyBalance:vi.fn(),lineHints:vi.fn(),create:vi.fn(),update:vi.fn(),issue:vi.fn(),post:vi.fn()}}));
vi.mock('../../resources/api',async original=>({...await original<typeof import('../../resources/api')>(),resourceApi:{list:vi.fn(),users:vi.fn()}}));
const fa=vi.mocked(financeApi),draft={id:51,docNo:'SYNTHETIC-51',status:'draft'};
const deferred=()=>{let resolve!:(value:never)=>void;const promise=new Promise<never>(done=>{resolve=done;});return{promise,resolve};};
beforeEach(()=>{
  vi.resetAllMocks();auth.id=1;auth.companyId=1;auth.permissions={isCompanyAdmin:true,allow:[],deny:[]};
  fa.banks.mockResolvedValue([]);fa.openItems.mockResolvedValue([]);fa.docs.mockResolvedValue({rows:[],total:0} as never);fa.partyBalance.mockResolvedValue(null as never);fa.lineHints.mockResolvedValue([]);fa.create.mockResolvedValue(draft as never);fa.update.mockResolvedValue(draft as never);fa.issue.mockResolvedValue({...draft,status:'issued'} as never);
  vi.mocked(resourceApi.users).mockResolvedValue([]);vi.mocked(resourceApi.list).mockResolvedValue({items:[{id:7,title:'合成费用',status:'active',data:{name:'合成费用'},refLabels:{}}],total:1,page:1,pageSize:200} as never);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const fillExpense=async()=>{
  fireEvent.click(screen.getByLabelText('第1行费用项目'));fireEvent.click(await screen.findByRole('option',{name:'合成费用'}));fireEvent.change(screen.getByLabelText('第1行金额'),{target:{value:'10'}});fireEvent.click(screen.getByRole('button',{name:'欠款'}));
};
it('原新开单收付款仅展示原模式、账户和金额，不读取额外余额或原单；备注使用单行输入',async()=>{
  render(<DocForm type="receipt" inline onSaved={vi.fn()}/>);
  expect((screen.getByLabelText('到账金额') as HTMLInputElement).value).toBe('');
  expect(screen.getByLabelText('备注').tagName).toBe('INPUT');
  for(const label of ['冲抵金额','银行流水号','优惠金额','结算依据'])expect(screen.queryByLabelText(label)).toBeNull();
  expect(screen.queryByRole('button',{name:'分多个账户收款'})).toBeNull();
  fireEvent.click(screen.getByLabelText('客户'));fireEvent.click(await screen.findByRole('option',{name:'合成费用'}));
  expect(fa.banks).not.toHaveBeenCalled();expect(fa.partyBalance).not.toHaveBeenCalled();expect(fa.lineHints).not.toHaveBeenCalled();expect(fa.openItems).not.toHaveBeenCalled();expect(fa.docs).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('第1行收款来源'),{target:{value:'合成回款'}});fireEvent.change(screen.getByLabelText('第1行金额'),{target:{value:'10'}});
  await waitFor(()=>expect((screen.getByLabelText('到账金额') as HTMLInputElement).value).toBe('10'));
  fireEvent.click(screen.getByLabelText('收款账户'));fireEvent.click(await screen.findByRole('option',{name:'合成费用'}));
  fireEvent.change(screen.getByLabelText('备注'),{target:{value:'合成回款备注'}});fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
  await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({partyId:7,bankAccountId:7,paidCents:1000,settlementMode:'full',memo:'合成回款备注',offsetCents:0,accounts:null})));
});
it('原费用预付款模式保留实付输入，改明细不擅自改掉预付额，保存分清冲抵与现金',async()=>{
  render(<DocForm type="expense" inline onSaved={vi.fn()}/>);
  expect(screen.getByLabelText('备注').tagName).toBe('TEXTAREA');expect(screen.queryByLabelText('冲抵金额')).toBeNull();expect(screen.queryByLabelText('挂账往来档案')).toBeNull();
  await fillExpense();fireEvent.click(screen.getByRole('button',{name:'已付全款'}));fireEvent.click(screen.getByRole('button',{name:'用预付款结算'}));
  expect((screen.getByLabelText('实付金额') as HTMLInputElement).value).toBe('10');fireEvent.change(screen.getByLabelText('第1行金额'),{target:{value:'20'}});expect((screen.getByLabelText('实付金额') as HTMLInputElement).value).toBe('10');
  fireEvent.change(screen.getByLabelText('实付金额'),{target:{value:'3'}});expect(screen.getByRole('button',{name:'用预付款结算'}).getAttribute('aria-pressed')).toBe('true');fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));
  await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({paidCents:0,offsetCents:300,settlementMode:'offset',bankAccountId:null})));
});
it('连续submit只能发起一个草稿保存请求，成功只回调一次',async()=>{
  const pending=deferred(),saved=vi.fn();fa.create.mockReturnValue(pending.promise);render(<DocForm type="expense" onSaved={saved}/>);
  const form=screen.getByRole('dialog',{name:'新建费用单'});fireEvent.submit(form);fireEvent.submit(form);expect(fa.create).toHaveBeenCalledTimes(1);
  await act(async()=>{pending.resolve(draft as never);});expect(saved).toHaveBeenCalledTimes(1);expect(saved).toHaveBeenCalledWith(draft,'draft');
});
it.each(['company','user','permission'])('%s切换重置整个制单表单，旧保存结果不清空新表单或回调',async kind=>{
  const pending=deferred(),saved=vi.fn();fa.create.mockReturnValue(pending.promise);const view=render(<DocForm type="sale" inline onSaved={saved}/>);
  fireEvent.change(screen.getByLabelText('第1行单位'),{target:{value:'旧上下文单位'}});fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
  if(kind==='company')auth.companyId=2;else if(kind==='user')auth.id=2;else auth.permissions={...auth.permissions,allow:['synthetic-new-permission']};
  view.rerender(<DocForm type="sale" inline onSaved={saved}/>);expect((screen.getByLabelText('第1行单位') as HTMLInputElement).value).toBe('件');
  fireEvent.change(screen.getByLabelText('第1行单位'),{target:{value:'新上下文单位'}});await act(async()=>{pending.resolve(draft as never);});
  expect(saved).not.toHaveBeenCalled();expect((screen.getByLabelText('第1行单位') as HTMLInputElement).value).toBe('新上下文单位');expect(screen.queryByText(/已保存：SYNTHETIC/)).toBeNull();
});
it('关闭发生在创建等待中时，不再继续开立或执行父页面回调',async()=>{
  vi.spyOn(window,'confirm').mockReturnValue(true);const pending=deferred(),saved=vi.fn();fa.create.mockReturnValue(pending.promise);const view=render(<DocForm type="expense" inline onSaved={saved}/>);await fillExpense();
  fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));expect(fa.create).toHaveBeenCalledTimes(1);view.unmount();await act(async()=>{pending.resolve(draft as never);});expect(fa.issue).not.toHaveBeenCalled();expect(fa.post).not.toHaveBeenCalled();expect(saved).not.toHaveBeenCalled();
});
it('创建成功但开立失败后，重试更新同一草稿，不重复创建，成功才清空本单',async()=>{
  vi.spyOn(window,'confirm').mockReturnValue(true);fa.issue.mockRejectedValueOnce(new Error('合成开立失败')).mockResolvedValueOnce({...draft,status:'issued'} as never);const saved=vi.fn();render(<DocForm type="expense" inline onSaved={saved}/>);await fillExpense();
  fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));expect((await screen.findByRole('alert')).textContent).toContain('合成开立失败');expect((screen.getByLabelText('第1行金额') as HTMLInputElement).value).toBe('10');expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));await waitFor(()=>expect(saved).toHaveBeenCalledTimes(1));expect(fa.create).toHaveBeenCalledTimes(1);expect(fa.update).toHaveBeenCalledWith(51,expect.objectContaining({lines:[expect.objectContaining({feeItemId:7,unitPriceCents:1000})]}));expect(fa.issue).toHaveBeenNthCalledWith(2,51);expect((screen.getByLabelText('第1行金额') as HTMLInputElement).value).toBe('');
});
it('创建失败解除保存互斥，保留输入供重试；明确清空时同时清除旧成功提示',async()=>{
  fa.create.mockRejectedValueOnce(new Error('合成保存失败')).mockResolvedValueOnce(draft as never);render(<DocForm type="sale" inline onSaved={vi.fn()}/>);fireEvent.change(screen.getByLabelText('第1行单位'),{target:{value:'合成箱'}});
  fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await screen.findByRole('alert');expect((screen.getByLabelText('第1行单位') as HTMLInputElement).value).toBe('合成箱');fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await screen.findByText(/已保存：SYNTHETIC-51/);expect(fa.create).toHaveBeenCalledTimes(2);fireEvent.click(screen.getByRole('button',{name:'清空单据'}));expect(screen.queryByText(/已保存：SYNTHETIC-51/)).toBeNull();
});
it('制单宿主页切换公司重建表单，原版开单页不再自动读取最近单据或提供额外草稿工具栏',()=>{
  const view=render(<VoucherPage type="sale"/>);fireEvent.change(screen.getByLabelText('第1行单位'),{target:{value:'旧公司合成单位'}});
  expect(screen.queryByRole('button',{name:'调入草稿'})).toBeNull();expect(fa.docs).not.toHaveBeenCalled();auth.companyId=2;view.rerender(<VoucherPage type="sale"/>);
  expect((screen.getByLabelText('第1行单位') as HTMLInputElement).value).toBe('件');expect(screen.queryByText(/最近的普通销售单/)).toBeNull();
});

it('费用公司对象从当前公司选择，保存真实ID而不提交可伪造名称，员工目录只读取一次',async()=>{
  render(<DocForm type="expense" inline onSaved={vi.fn()}/>);await fillExpense();fireEvent.change(screen.getByLabelText('第1行挂账节点'),{target:{value:'公司'}});
  fireEvent.click(screen.getByLabelText('第1行挂账对象'));fireEvent.click(await screen.findByRole('option',{name:'合成当前公司'}));
  expect(screen.getByLabelText('第1行挂账对象').textContent).toContain('合成当前公司');fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));
  await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({lines:[expect.objectContaining({feeItemId:7,relatedNode:'公司',relatedId:1,relatedName:null})]})));
  expect(resourceApi.users).toHaveBeenCalledTimes(1);expect(vi.mocked(resourceApi.list).mock.calls.some(([type])=>type==='company')).toBe(false);
});
it('人员对象与经办人共用本公司目录，切换节点清空旧对象且新选择不提供停用人员',async()=>{
  vi.mocked(resourceApi.users).mockResolvedValue([{id:11,name:'合成人员甲',active:true},{id:22,name:'合成人员乙',active:true},{id:33,name:'合成停用人员',active:false}]);
  render(<DocForm type="expense" inline onSaved={vi.fn()}/>);await fillExpense();fireEvent.change(screen.getByLabelText('第1行挂账节点'),{target:{value:'公司'}});fireEvent.click(screen.getByLabelText('第1行挂账对象'));fireEvent.click(await screen.findByRole('option',{name:'合成当前公司'}));
  fireEvent.change(screen.getByLabelText('第1行挂账节点'),{target:{value:'人员'}});expect(screen.getByLabelText('第1行挂账对象').textContent).not.toContain('合成当前公司');
  fireEvent.click(screen.getByLabelText('第1行挂账对象'));expect(screen.queryByRole('option',{name:/合成停用人员/})).toBeNull();fireEvent.click(await screen.findByRole('option',{name:'合成人员乙'}));fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));
  await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({lines:[expect.objectContaining({relatedNode:'人员',relatedId:22,relatedName:null})]})));expect(resourceApi.users).toHaveBeenCalledTimes(1);
});
it('人员目录确认为空时沿原版保留自由文字输入，不虚构人员ID',async()=>{
  render(<DocForm type="expense" inline onSaved={vi.fn()}/>);await fillExpense();fireEvent.change(screen.getByLabelText('第1行挂账节点'),{target:{value:'人员'}});
  expect(screen.getByLabelText('第1行挂账对象').tagName).toBe('INPUT');fireEvent.change(screen.getByLabelText('第1行挂账对象'),{target:{value:'合成原文字人员'}});fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));
  await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({lines:[expect.objectContaining({relatedNode:'人员',relatedId:null,relatedName:'合成原文字人员'})]})));
});
it('费用单沿原版只有侧栏保存费用单和顶部清空，主保存只开立，不绑定额外过账快捷键',async()=>{
  const confirm=vi.spyOn(window,'confirm').mockReturnValue(true),saved=vi.fn();render(<DocForm type="expense" inline onSaved={saved}/>);
  expect(screen.getByRole('button',{name:'清空'}).closest('.slip-title')).toBeTruthy();expect(screen.queryByRole('button',{name:'保存草稿'})).toBeNull();expect(screen.queryByRole('button',{name:'保存并开立'})).toBeNull();expect(screen.queryByRole('toolbar')).toBeNull();expect(screen.queryByText('过账说明')).toBeNull();
  const primary=screen.getByRole('button',{name:'保存费用单'});expect(primary.closest('.slip-side')).toBeTruthy();expect(primary.closest('.reference-document-actions')).toBeNull();
  fireEvent.keyDown(window,{key:'F8'});expect(fa.post).not.toHaveBeenCalled();await fillExpense();fireEvent.click(primary);await waitFor(()=>expect(saved).toHaveBeenCalledWith(expect.objectContaining({status:'issued'}),'issued'));expect(fa.issue).toHaveBeenCalledWith(51);expect(fa.post).not.toHaveBeenCalled();expect(confirm).not.toHaveBeenCalled();
});
it('新费用行只提供原20个挂账节点，历史或配置已带出的特殊节点仍保留并保存',async()=>{
  vi.mocked(resourceApi.list).mockResolvedValue({items:[{id:7,title:'合成费用',status:'active',data:{name:'合成费用',defaultObject:'仓库'},refLabels:{}}],total:1,page:1,pageSize:200} as never);
  const view=render(<DocForm type="expense" inline onSaved={vi.fn()}/>);
  const labels=Array.from((screen.getByLabelText('第1行挂账节点') as HTMLSelectElement).options).map(option=>option.textContent);
  expect(labels).toEqual(['不选择','公司','部门','人员','营业执照','店铺','手机号','宽带账号','自媒体账号','账号与服务备忘','公司公户','公司银行卡','公司出纳账户','店铺公户','店铺个人银行卡','固定资产','商品','供应商','客户','项目','不固定']);
  fireEvent.click(screen.getByLabelText('第1行费用项目'));fireEvent.click(await screen.findByRole('option',{name:'合成费用'}));expect((screen.getByLabelText('第1行挂账节点') as HTMLSelectElement).value).toBe('仓库');view.unmount();
  const doc={...draft,id:71,docType:'expense',docDate:'2026-11-03',amountCents:1000,paidCents:0,settlementMode:'credit',accounts:[],events:[],entries:[],lines:[{id:1,feeItemId:7,feeItemName:'合成费用',qty:1,unitPriceCents:1000,relatedNode:'仓库',relatedId:9,relatedName:'合成历史仓库'}]};fa.update.mockResolvedValue(doc as never);fa.issue.mockResolvedValue({...doc,status:'issued'} as never);
  render(<DocForm type="expense" doc={doc as never} inline onSaved={vi.fn()}/>);expect((screen.getByLabelText('第1行挂账节点') as HTMLSelectElement).value).toBe('仓库');expect(screen.getByRole('option',{name:'仓库'})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));await waitFor(()=>expect(fa.update).toHaveBeenCalledWith(71,expect.objectContaining({lines:[expect.objectContaining({relatedNode:'仓库',relatedId:9})]})));
});
it('经办人沿原版按姓名和部门展示并可搜索部门，选择保存员工ID，不把部门串入姓名',async()=>{
  vi.mocked(resourceApi.users).mockResolvedValue([{id:22,name:'合成经办乙',active:true,departmentName:'合成财务部'},{id:11,name:'合成经办甲',active:true,departmentName:null}]);
  render(<DocForm type="sale" inline onSaved={vi.fn()}/>);await waitFor(()=>expect(resourceApi.users).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByLabelText('经办人'));expect(screen.getAllByRole('option').map(option=>option.textContent)).toEqual(['合成经办甲 · 未分部门','合成经办乙 · 合成财务部']);
  fireEvent.change(screen.getByRole('textbox',{name:'搜索经办人'}),{target:{value:'合成财务部'}});fireEvent.click(screen.getByRole('option',{name:'合成经办乙 · 合成财务部'}));expect(screen.getByLabelText('经办人').textContent).toContain('合成经办乙 · 合成财务部');
  fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({handlerId:22,handler:null})));
});
it('原开单表头保留各单据的占位与来源选项，切换来源清空旧ID并读取对应档案',async()=>{
  const view=render(<DocForm type="sale" inline onSaved={vi.fn()}/>);
  expect(screen.getByRole('heading',{level:2,name:'客户和出货'})).toBeTruthy();expect(screen.getByLabelText('单据编号').getAttribute('placeholder')).toBe('留空由系统自动生成');expect(screen.getByLabelText('客户').textContent).toContain('客户名称');expect(screen.getByLabelText('仓库').parentElement?.textContent).toBe('仓库');
  view.unmount();render(<DocForm type="receipt" inline onSaved={vi.fn()}/>);
  const source=screen.getByLabelText('往来对象来源') as HTMLSelectElement;expect(Array.from(source.options).map(option=>option.textContent)).toEqual(['客户档案','店铺档案']);
  fireEvent.click(screen.getByLabelText('客户'));fireEvent.click(await screen.findByRole('option',{name:'合成费用'}));fireEvent.change(source,{target:{value:'store'}});expect(screen.getByLabelText('客户').textContent).toContain('客户名称');
  fireEvent.click(screen.getByLabelText('客户'));await screen.findByRole('option',{name:'其他 · 合成费用'});expect(resourceApi.list).toHaveBeenLastCalledWith('stores',expect.anything());fireEvent.click(screen.getByRole('option',{name:'其他 · 合成费用'}));expect(screen.getByLabelText('客户').textContent).toContain('其他 · 合成费用');
  fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({partyKind:'store',partyId:7})));
});
it('原独立费用表头没有部门时只显示经办姓名，不沿用常规单据的未分部门后缀',async()=>{
  vi.mocked(resourceApi.users).mockResolvedValue([{id:11,name:'合成无部门人员',active:true,departmentName:null},{id:22,name:'合成财务人员',active:true,departmentName:'合成财务部'}]);
  render(<DocForm type="expense" inline onSaved={vi.fn()}/>);await waitFor(()=>expect(resourceApi.users).toHaveBeenCalledTimes(1));fireEvent.click(screen.getByLabelText('经办人'));
  expect(screen.getByRole('listbox').textContent).not.toContain('未分部门');expect(Array.from(screen.getByRole('listbox').querySelectorAll('[role=option]')).map(option=>option.textContent)).toEqual(['合成无部门人员','合成财务人员 · 合成财务部']);fireEvent.click(screen.getByRole('option',{name:'合成无部门人员'}));expect(screen.getByLabelText('经办人').textContent).toContain('合成无部门人员');expect(screen.queryByText(/未分部门/)).toBeNull();
});
it('原商品七列去掉额外赠品和优惠控件，六位报价仍按整数分结算，删最后一行恢复原空行',async()=>{
  render(<DocForm type="sale" inline onSaved={vi.fn()}/>);
  expect(screen.getAllByRole('columnheader').map(cell=>cell.textContent)).toEqual(['商品','单位','数量','单价','小计','备注','操作']);expect(screen.queryByLabelText('第1行赠品')).toBeNull();expect(screen.queryByLabelText('优惠金额')).toBeNull();
  fireEvent.click(screen.getByLabelText('第1行商品'));fireEvent.click(await screen.findByRole('option',{name:'合成费用'}));
  fireEvent.change(screen.getByLabelText('第1行数量'),{target:{value:'2.5'}});fireEvent.change(screen.getByLabelText('第1行单价'),{target:{value:'0.123456'}});expect(screen.getByRole('status').textContent).toBe('¥0.31');expect(screen.getByLabelText('第1行单价').getAttribute('step')).toBe('0.000001');
  fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({discountCents:0,lines:[expect.objectContaining({productId:7,unit:'件',qty:2.5,unitPriceCents:12.3456})]})));
  fireEvent.click(screen.getByRole('button',{name:'删除第1行'}));expect((screen.getByLabelText('第1行单位') as HTMLInputElement).value).toBe('件');expect((screen.getByLabelText('第1行数量') as HTMLInputElement).value).toBe('');expect((screen.getByLabelText('第1行单价') as HTMLInputElement).value).toBe('');expect(screen.getByLabelText('第1行商品').textContent).toContain('选择商品');
});
it('原金额四列没有常用词建议，增删行只保存保留的项目和金额',async()=>{
  const view=render(<DocForm type="receipt" inline onSaved={vi.fn()}/>);expect(screen.getAllByRole('columnheader').map(cell=>cell.textContent)).toEqual(['收款来源','金额','备注','操作']);expect(view.container.querySelector('datalist')).toBeNull();expect(screen.getByLabelText('第1行收款来源').getAttribute('list')).toBeNull();
  fireEvent.change(screen.getByLabelText('第1行收款来源'),{target:{value:'合成删除项'}});fireEvent.change(screen.getByLabelText('第1行金额'),{target:{value:'12.34'}});fireEvent.click(screen.getByRole('button',{name:'添加一行明细'}));
  fireEvent.change(screen.getByLabelText('第2行收款来源'),{target:{value:'合成保留项'}});fireEvent.change(screen.getByLabelText('第2行金额'),{target:{value:'0.01'}});expect(view.container.querySelector('tfoot')?.textContent).toContain('¥12.35');fireEvent.click(screen.getByRole('button',{name:'删除第1行'}));
  fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({lines:[expect.objectContaining({itemName:'合成保留项',qty:1,unitPriceCents:1})]})));
});
it('原其他收入仅两种收款方式，来源没有选填标记；有效金额仍需选择来源再开立',async()=>{
  render(<DocForm type="other-income" inline onSaved={vi.fn()}/>);expect(screen.getByRole('group',{name:'结算方式'}).textContent).toBe('已收全款收了部分');expect(screen.queryByRole('button',{name:'暂未收款'})).toBeNull();expect(screen.queryByLabelText('来源对象（选填）')).toBeNull();expect(screen.getByLabelText('来源对象')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'保存其他收入单'}));expect((await screen.findByRole('alert')).textContent).toBe('请至少填写一条金额明细');fireEvent.change(screen.getByLabelText('第1行收入项目'),{target:{value:'合成回收收入'}});fireEvent.change(screen.getByLabelText('第1行金额'),{target:{value:'10'}});fireEvent.click(screen.getByRole('button',{name:'保存其他收入单'}));expect((await screen.findByRole('alert')).textContent).toBe('请选择来源对象');expect(fa.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('来源对象'));fireEvent.click(await screen.findByRole('option',{name:'合成费用'}));fireEvent.click(screen.getByLabelText('收款账户'));fireEvent.click(await screen.findByRole('option',{name:'合成费用'}));fireEvent.click(screen.getByRole('button',{name:'保存其他收入单'}));await waitFor(()=>expect(fa.issue).toHaveBeenCalledWith(51));expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({partyId:7,bankAccountId:7,paidCents:1000,settlementMode:'full',lines:[expect.objectContaining({itemName:'合成回收收入',unitPriceCents:1000})]}));const notice=await screen.findByRole('status');expect(notice.textContent).toBe('其他收入单已保存：SYNTHETIC-51，当前为未过账状态');expect(notice.closest('.slip-side')).toBeNull();expect(notice.compareDocumentPosition(screen.getByRole('heading',{name:'其他收入单 / 手工开单'}))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it('历史其他收入的暂未收款方式仍能查看和重存，不能因新入口复原而丢掉已存数据',async()=>{
  const doc={...draft,docType:'other-income',docDate:'2026-10-24',amountCents:1000,paidCents:0,settlementMode:'credit',partyId:7,partyKind:'customer',partyName:'合成往来',accounts:[],events:[],entries:[],lines:[{itemName:'合成旧收入',qty:1,unitPriceCents:1000}]};fa.update.mockResolvedValue(doc as never);
  render(<DocForm type="other-income" doc={doc as never} inline onSaved={vi.fn()}/>);expect(screen.getByRole('button',{name:'暂未收款'}).getAttribute('aria-pressed')).toBe('true');expect((screen.getByLabelText('收到金额') as HTMLInputElement).value).toBe('0.00');fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await waitFor(()=>expect(fa.update).toHaveBeenCalledWith(51,expect.objectContaining({paidCents:0,settlementMode:'credit',lines:[expect.objectContaining({itemName:'合成旧收入',unitPriceCents:1000})]})));expect(fa.create).not.toHaveBeenCalled();
});
it('已有挂账快照原样显示和重存，明确重选同一个ID才请求服务端冻结当前名称',async()=>{
  vi.mocked(resourceApi.list).mockResolvedValue({items:[{id:7,title:'改名客户',status:'active',data:{name:'改名客户',code:'NEW'}}],total:1,page:1,pageSize:200} as never);
  const doc={...draft,docType:'expense',docDate:'2026-11-03',amountCents:1000,paidCents:0,settlementMode:'credit',accounts:[],events:[],entries:[],lines:[{id:71,feeItemId:9,feeItemName:'合成费用',qty:1,unitPriceCents:1000,relatedNode:'客户',relatedId:7,relatedName:'原客户 · OLD'}]};fa.update.mockResolvedValue(doc as never);const saved=vi.fn();render(<DocForm type="expense" doc={doc as never} inline onSaved={saved}/>);
  expect(screen.getByLabelText('第1行挂账对象').textContent).toContain('原客户 · OLD');fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));await waitFor(()=>expect(saved).toHaveBeenCalledTimes(1));expect(fa.update).toHaveBeenLastCalledWith(51,expect.objectContaining({lines:[expect.objectContaining({id:71,relatedId:7,relatedName:null,refreshRelatedName:undefined})]}));
  fireEvent.click(screen.getByLabelText('第1行挂账对象'));fireEvent.click(await screen.findByRole('option',{name:'改名客户 · NEW'}));expect(screen.getByLabelText('第1行挂账对象').textContent).toContain('改名客户 · NEW');fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));await waitFor(()=>expect(saved).toHaveBeenCalledTimes(2));expect(fa.update).toHaveBeenLastCalledWith(51,expect.objectContaining({lines:[expect.objectContaining({id:71,relatedId:7,relatedName:null,refreshRelatedName:true})]}));
});
it('已有金额行删除前一行后保留后一行ID、项目和历史挂账关联',async()=>{
  const doc={...draft,docType:'other-income',docDate:'2026-11-03',amountCents:300,paidCents:0,settlementMode:'credit',partyId:7,partyKind:'customer',partyName:'合成往来',accounts:[],events:[],entries:[],lines:[{id:81,itemName:'合成删除项',qty:1,unitPriceCents:100},{id:82,itemName:'合成保留项',qty:1,unitPriceCents:200,relatedNode:'客户',relatedId:7,relatedName:'合成历史客户 · OLD'}]};fa.update.mockResolvedValue(doc as never);render(<DocForm type="other-income" doc={doc as never} inline onSaved={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:'删除第1行'}));fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await waitFor(()=>expect(fa.update).toHaveBeenCalledWith(51,expect.objectContaining({lines:[expect.objectContaining({id:82,itemName:'合成保留项',unitPriceCents:200,relatedNode:'客户',relatedId:7,relatedName:'合成历史客户 · OLD'})]})));
});
it('原挂账档案为空时允许手填对象并保存原文字，不虚构档案ID',async()=>{
  vi.mocked(resourceApi.list).mockImplementation((async(type:string)=>type==='finance-fee-items'?{items:[{id:7,title:'合成费用',status:'active',data:{name:'合成费用'}}],total:1,page:1,pageSize:200}:{items:[],total:0,page:1,pageSize:200}) as never);
  render(<DocForm type="expense" inline onSaved={vi.fn()}/>);await fillExpense();fireEvent.change(screen.getByLabelText('第1行挂账节点'),{target:{value:'店铺'}});const object=await screen.findByRole('textbox',{name:'第1行挂账对象'});expect(object.getAttribute('placeholder')).toBe('名称/编号（可手工填写）');fireEvent.change(object,{target:{value:'合成原手填店铺'}});fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({lines:[expect.objectContaining({relatedNode:'店铺',relatedId:null,relatedName:'合成原手填店铺'})]})));
});
const transferBanks=()=>vi.mocked(resourceApi.list).mockResolvedValue({items:[{id:71,title:'合成甲户',status:'active',data:{}},{id:72,title:'合成乙户',status:'active',data:{}},{id:73,title:'合成丙户',status:'active',data:{}}],total:3,page:1,pageSize:200} as never);
const addTransfer=async(role:'转出'|'转入',name:string)=>{fireEvent.click(screen.getByLabelText(`选择${role}账户`));fireEvent.click(await screen.findByRole('option',{name}));fireEvent.click(screen.getByRole('button',{name:`添加${role}账户`}));};
it('原收款手填金额保留已到账选择，清空提交显式0，部分到账仍按原明细变动带出合计',async()=>{
  render(<DocForm type="receipt" inline onSaved={vi.fn()}/>);fireEvent.change(screen.getByLabelText('第1行收款来源'),{target:{value:'合成回款'}});fireEvent.change(screen.getByLabelText('第1行金额'),{target:{value:'10'}});
  fireEvent.change(screen.getByLabelText('到账金额'),{target:{value:'3'}});expect(screen.getByRole('button',{name:'已到账'}).getAttribute('aria-pressed')).toBe('true');fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({paidCents:300,settlementMode:'full'})));
  await waitFor(()=>expect((screen.getByLabelText('第1行金额') as HTMLInputElement).value).toBe(''));fireEvent.change(screen.getByLabelText('第1行金额'),{target:{value:'10'}});fireEvent.change(screen.getByLabelText('到账金额'),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await waitFor(()=>expect(fa.create).toHaveBeenCalledTimes(2));expect(fa.create).toHaveBeenLastCalledWith(expect.objectContaining({paidCents:0,settlementMode:'full'}));
  await waitFor(()=>expect((screen.getByLabelText('第1行金额') as HTMLInputElement).value).toBe(''));fireEvent.change(screen.getByLabelText('第1行金额'),{target:{value:'10'}});fireEvent.click(screen.getByRole('button',{name:'部分到账'}));expect((screen.getByLabelText('到账金额') as HTMLInputElement).value).toBe('10');fireEvent.change(screen.getByLabelText('到账金额'),{target:{value:'3'}});fireEvent.change(screen.getByLabelText('第1行金额'),{target:{value:'12'}});expect((screen.getByLabelText('到账金额') as HTMLInputElement).value).toBe('12');expect(screen.getByRole('button',{name:'部分到账'}).getAttribute('aria-pressed')).toBe('true');
});
it('原预付模式切换到部分付款时保留本次输入，实际付款不叠加旧冲抵',async()=>{
  render(<DocForm type="expense" inline onSaved={vi.fn()}/>);await fillExpense();fireEvent.click(screen.getByRole('button',{name:'已付全款'}));fireEvent.click(screen.getByRole('button',{name:'用预付款结算'}));fireEvent.change(screen.getByLabelText('实付金额'),{target:{value:'3'}});fireEvent.click(screen.getByRole('button',{name:'付了部分'}));expect((screen.getByLabelText('实付金额') as HTMLInputElement).value).toBe('3');fireEvent.click(screen.getByLabelText('付款账户'));fireEvent.click(await screen.findByRole('option',{name:'合成费用'}));fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({paidCents:300,offsetCents:0,settlementMode:'part'})));
});
it.each([{mode:'full',cents:300},{mode:'full',cents:0},{mode:'offset',cents:300}] as const)('已有$mode草稿$cents分在严格模式加载和重存保留实际金额，不被初始化联动覆盖',async({mode,cents})=>{
  const type=mode==='full'?'receipt':'expense',doc={...draft,docType:type,docDate:'2026-10-24',amountCents:1000,paidCents:mode==='full'?cents:0,offsetCents:mode==='offset'?cents:0,settlementMode:mode,partyId:7,partyKind:mode==='full'?'customer':'supplier',partyName:'合成往来',bankAccountId:7,bankName:'合成账户',accounts:[],events:[],entries:[],lines:mode==='full'?[{itemName:'合成用途',qty:1,unitPriceCents:1000}]:[{feeItemId:7,feeItemName:'合成费用',qty:1,unitPriceCents:1000}]};fa.update.mockResolvedValue(doc as never);
  render(<StrictMode><DocForm type={type} doc={doc as never} inline onSaved={vi.fn()}/></StrictMode>);expect((screen.getByLabelText(mode==='full'?'到账金额':'冲抵金额') as HTMLInputElement).value).toBe((cents/100).toFixed(2));fireEvent.click(screen.getByRole('button',{name:mode==='full'?'保存草稿':'保存费用单'}));await waitFor(()=>expect(fa.update).toHaveBeenCalledWith(51,expect.objectContaining({paidCents:mode==='full'?cents:0,offsetCents:mode==='offset'?cents:0,settlementMode:mode})));
});
it('原转款先选择再添加，已添加账户在本侧候选中排除，移除和清空释放账户及待添加选择',async()=>{
  transferBanks();render(<DocForm type="transfer" inline onSaved={vi.fn()}/>);
  expect(screen.queryByLabelText('归属部门')).toBeNull();expect(screen.queryByLabelText('转款手续费')).toBeNull();expect(screen.queryByRole('button',{name:/互换转出/})).toBeNull();expect(fa.banks).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('选择转出账户'));fireEvent.click(await screen.findByRole('option',{name:'合成甲户'}));expect(screen.queryByLabelText('转出账户合成甲户金额')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'添加转出账户'}));expect(screen.getByLabelText('转出账户合成甲户金额')).toBeTruthy();fireEvent.click(screen.getByLabelText('选择转出账户'));expect(screen.queryByRole('option',{name:'合成甲户'})).toBeNull();fireEvent.click(await screen.findByRole('option',{name:'合成乙户'}));
  fireEvent.click(screen.getByRole('button',{name:'清空单据'}));expect(screen.queryByLabelText('转出账户合成甲户金额')).toBeNull();expect(screen.getByLabelText('选择转出账户').textContent).toContain('搜索转出账户');fireEvent.click(screen.getByRole('button',{name:'添加转出账户'}));expect(screen.queryByLabelText('转出账户合成乙户金额')).toBeNull();
  await addTransfer('转出','合成甲户');fireEvent.click(screen.getByRole('button',{name:'移除转出账户合成甲户'}));fireEvent.click(screen.getByLabelText('选择转出账户'));expect(await screen.findByRole('option',{name:'合成甲户'})).toBeTruthy();
});
it('原转款要求金额明细及两侧分配等于明细，纠正后保存真实多账户和用途，只开立且清空表单',async()=>{
  transferBanks();render(<DocForm type="transfer" inline onSaved={vi.fn()}/>);await addTransfer('转出','合成甲户');await addTransfer('转出','合成乙户');await addTransfer('转入','合成丙户');
  fireEvent.change(screen.getByLabelText('转出账户合成甲户金额'),{target:{value:'6'}});fireEvent.change(screen.getByLabelText('转出账户合成乙户金额'),{target:{value:'5'}});fireEvent.change(screen.getByLabelText('转入账户合成丙户金额'),{target:{value:'11'}});
  fireEvent.click(screen.getByRole('button',{name:'保存转款单'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent','请至少填写一条金额明细');expect(fa.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('第1行转款用途'),{target:{value:'合成划转'}});fireEvent.change(screen.getByLabelText('第1行金额'),{target:{value:'10'}});expect(document.querySelector('.reference-transfer-summary')?.textContent).toContain('本次计划转款 ¥10.00');fireEvent.click(screen.getByRole('button',{name:'保存转款单'}));expect((await screen.findByRole('alert')).textContent).toContain('要等于明细合计');expect(fa.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('转出账户合成甲户金额'),{target:{value:'5'}});fireEvent.change(screen.getByLabelText('转入账户合成丙户金额'),{target:{value:'10'}});fireEvent.click(screen.getByRole('button',{name:'保存转款单'}));
  await waitFor(()=>expect(fa.issue).toHaveBeenCalledWith(51));expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({department:null,feeCents:0,inTransit:false,accounts:[{role:'out',bankAccountId:71,amountCents:500},{role:'out',bankAccountId:72,amountCents:500},{role:'in',bankAccountId:73,amountCents:1000}],lines:[expect.objectContaining({itemName:'合成划转',unitPriceCents:1000,qty:1})]}));expect(fa.post).not.toHaveBeenCalled();await waitFor(()=>expect(screen.queryByLabelText('转出账户合成甲户金额')).toBeNull());
});

it('费用目录确认为空才恢复原手工费用类型，文字按项目保存且不伪造档案ID',async()=>{
  vi.mocked(resourceApi.list).mockResolvedValue({items:[],total:0,page:1,pageSize:200} as never);
  render(<DocForm type="expense" inline onSaved={vi.fn()}/>);
  const item=await screen.findByPlaceholderText('费用类型');fireEvent.change(item,{target:{value:'合成手工费用'}});
  fireEvent.change(screen.getByLabelText('第1行金额'),{target:{value:'12.34'}});fireEvent.click(screen.getByRole('button',{name:'欠款'}));fireEvent.click(screen.getByRole('button',{name:'保存费用单'}));
  await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({lines:[expect.objectContaining({feeItemId:null,itemName:'合成手工费用',qty:1,unitPriceCents:1234})]})));
});

it('空目录手填费用或挂账文字未输金额也属于未保存修改，清空后解除提醒',async()=>{
  vi.mocked(resourceApi.list).mockResolvedValue({items:[],total:0,page:1,pageSize:200} as never);render(<DocForm type="expense" inline onSaved={vi.fn()}/>);
  const field=await screen.findByPlaceholderText('费用类型');fireEvent.change(field,{target:{value:'合成未保存费用'}});
  const first=new Event('beforeunload',{cancelable:true});window.dispatchEvent(first);expect(first.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'清空'}));const clear=new Event('beforeunload',{cancelable:true});window.dispatchEvent(clear);expect(clear.defaultPrevented).toBe(false);
  fireEvent.change(screen.getByLabelText('第1行挂账节点'),{target:{value:'手机号'}});const object=await screen.findByRole('textbox',{name:'第1行挂账对象'});fireEvent.change(object,{target:{value:'合成未保存对象'}});
  const second=new Event('beforeunload',{cancelable:true});window.dispatchEvent(second);expect(second.defaultPrevented).toBe(true);
});

it('费用资料的首选挂账节点保持原选择顺序，不因同时勾选公司而抢占店铺默认',async()=>{
  vi.mocked(resourceApi.list).mockResolvedValue({items:[{id:7,title:'合成首选店铺费用',status:'active',data:{name:'合成首选店铺费用',defaultObject:'店铺、公司',requiredObject:'yes'},refLabels:{}}],total:1,page:1,pageSize:200} as never);
  render(<DocForm type="expense" inline onSaved={vi.fn()}/>);fireEvent.click(screen.getByLabelText('第1行费用项目'));fireEvent.click(await screen.findByRole('option',{name:'合成首选店铺费用'}));
  expect((screen.getByLabelText('第1行挂账节点')as HTMLSelectElement).value).toBe('店铺');expect(fa.create).not.toHaveBeenCalled();
});
