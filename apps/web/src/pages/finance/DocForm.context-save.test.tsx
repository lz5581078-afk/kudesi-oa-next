import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DocForm} from './DocForm';
import {VoucherPage} from './VoucherPage';
import {financeApi} from './financeApi';
import {resourceApi} from '../../resources/api';
const auth=vi.hoisted(()=>({id:1,companyId:1,name:'合成管理员',companyName:'合成当前公司',permissions:{isCompanyAdmin:true,allow:[] as string[],deny:[] as string[]}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:auth,can:()=>true})}));
vi.mock('./financeApi',async original=>({...await original<typeof import('./financeApi')>(),financeApi:{banks:vi.fn(),docs:vi.fn(),doc:vi.fn(),partyBalance:vi.fn(),lineHints:vi.fn(),create:vi.fn(),update:vi.fn(),issue:vi.fn(),post:vi.fn()}}));
vi.mock('../../resources/api',async original=>({...await original<typeof import('../../resources/api')>(),resourceApi:{list:vi.fn(),users:vi.fn()}}));
const fa=vi.mocked(financeApi),draft={id:51,docNo:'SYNTHETIC-51',status:'draft'};
const deferred=()=>{let resolve!:(value:never)=>void;const promise=new Promise<never>(done=>{resolve=done;});return{promise,resolve};};
beforeEach(()=>{
  vi.resetAllMocks();auth.id=1;auth.companyId=1;auth.permissions={isCompanyAdmin:true,allow:[],deny:[]};
  fa.banks.mockResolvedValue([]);fa.docs.mockResolvedValue({rows:[],total:0} as never);fa.partyBalance.mockResolvedValue(null as never);fa.lineHints.mockResolvedValue([]);fa.create.mockResolvedValue(draft as never);fa.update.mockResolvedValue(draft as never);fa.issue.mockResolvedValue({...draft,status:'issued'} as never);
  vi.mocked(resourceApi.users).mockResolvedValue([]);vi.mocked(resourceApi.list).mockResolvedValue({items:[{id:7,title:'合成费用',status:'active',data:{name:'合成费用'},refLabels:{}}],total:1,page:1,pageSize:200} as never);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const fillExpense=async()=>{
  fireEvent.click(screen.getByLabelText('第1行费用项目'));fireEvent.click(await screen.findByRole('option',{name:'合成费用'}));fireEvent.change(screen.getByLabelText('第1行金额'),{target:{value:'10'}});fireEvent.click(screen.getByRole('button',{name:'欠款'}));
};
it('连续提交和快捷键只能发起一个保存请求，成功只回调一次',async()=>{
  const pending=deferred(),saved=vi.fn();fa.create.mockReturnValue(pending.promise);render(<DocForm type="expense" inline onSaved={saved}/>);
  fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));fireEvent.keyDown(window,{key:'g',ctrlKey:true});expect(fa.create).toHaveBeenCalledTimes(1);
  await act(async()=>{pending.resolve(draft as never);});expect(saved).toHaveBeenCalledTimes(1);expect(saved).toHaveBeenCalledWith(draft,'draft');
});
it.each(['company','user','permission'])('%s切换重置整个制单表单，旧保存结果不清空新表单或回调',async kind=>{
  const pending=deferred(),saved=vi.fn();fa.create.mockReturnValue(pending.promise);const view=render(<DocForm type="sale" inline onSaved={saved}/>);
  fireEvent.change(screen.getByLabelText('第1行单位'),{target:{value:'旧上下文单位'}});fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
  if(kind==='company')auth.companyId=2;else if(kind==='user')auth.id=2;else auth.permissions={...auth.permissions,allow:['synthetic-new-permission']};
  view.rerender(<DocForm type="sale" inline onSaved={saved}/>);expect((screen.getByLabelText('第1行单位') as HTMLInputElement).value).toBe('件');
  fireEvent.change(screen.getByLabelText('第1行单位'),{target:{value:'新上下文单位'}});await act(async()=>{pending.resolve(draft as never);});
  expect(saved).not.toHaveBeenCalled();expect((screen.getByLabelText('第1行单位') as HTMLInputElement).value).toBe('新上下文单位');expect(screen.queryByText(/已保存 SYNTHETIC/)).toBeNull();
});
it('关闭发生在创建等待中时，不再继续开立或执行父页面回调',async()=>{
  vi.spyOn(window,'confirm').mockReturnValue(true);const pending=deferred(),saved=vi.fn();fa.create.mockReturnValue(pending.promise);const view=render(<DocForm type="expense" inline onSaved={saved}/>);await fillExpense();
  fireEvent.click(screen.getByRole('button',{name:'保存并开立'}));expect(fa.create).toHaveBeenCalledTimes(1);view.unmount();await act(async()=>{pending.resolve(draft as never);});expect(fa.issue).not.toHaveBeenCalled();expect(fa.post).not.toHaveBeenCalled();expect(saved).not.toHaveBeenCalled();
});
it('创建成功但开立失败后，重试更新同一草稿，不重复创建，成功才清空本单',async()=>{
  vi.spyOn(window,'confirm').mockReturnValue(true);fa.issue.mockRejectedValueOnce(new Error('合成开立失败')).mockResolvedValueOnce({...draft,status:'issued'} as never);const saved=vi.fn();render(<DocForm type="expense" inline onSaved={saved}/>);await fillExpense();
  fireEvent.click(screen.getByRole('button',{name:'保存并开立'}));expect((await screen.findByRole('alert')).textContent).toContain('合成开立失败');expect((screen.getByLabelText('第1行金额') as HTMLInputElement).value).toBe('10');expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'保存并开立'}));await waitFor(()=>expect(saved).toHaveBeenCalledTimes(1));expect(fa.create).toHaveBeenCalledTimes(1);expect(fa.update).toHaveBeenCalledWith(51,expect.objectContaining({lines:[expect.objectContaining({feeItemId:7,unitPriceCents:1000})]}));expect(fa.issue).toHaveBeenNthCalledWith(2,51);expect((screen.getByLabelText('第1行金额') as HTMLInputElement).value).toBe('');
});
it('创建失败解除保存互斥，保留输入供重试；明确清空时同时清除旧成功提示',async()=>{
  fa.create.mockRejectedValueOnce(new Error('合成保存失败')).mockResolvedValueOnce(draft as never);render(<DocForm type="sale" inline onSaved={vi.fn()}/>);fireEvent.change(screen.getByLabelText('第1行单位'),{target:{value:'合成箱'}});
  fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await screen.findByRole('alert');expect((screen.getByLabelText('第1行单位') as HTMLInputElement).value).toBe('合成箱');fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));await screen.findByText(/已保存 SYNTHETIC-51/);expect(fa.create).toHaveBeenCalledTimes(2);fireEvent.click(screen.getByRole('button',{name:'清空单据'}));expect(screen.queryByText(/已保存 SYNTHETIC-51/)).toBeNull();
});
it('制单宿主页切换公司重建表单，原版开单页不再自动读取最近单据或提供额外草稿工具栏',()=>{
  const view=render(<VoucherPage type="sale"/>);fireEvent.change(screen.getByLabelText('第1行单位'),{target:{value:'旧公司合成单位'}});
  expect(screen.queryByRole('button',{name:'调入草稿'})).toBeNull();expect(fa.docs).not.toHaveBeenCalled();auth.companyId=2;view.rerender(<VoucherPage type="sale"/>);
  expect((screen.getByLabelText('第1行单位') as HTMLInputElement).value).toBe('件');expect(screen.queryByText(/最近的普通销售单/)).toBeNull();
});

it('费用公司对象从当前公司选择，保存真实ID而不提交可伪造名称，员工目录只读取一次',async()=>{
  render(<DocForm type="expense" inline onSaved={vi.fn()}/>);await fillExpense();fireEvent.change(screen.getByLabelText('第1行挂账节点'),{target:{value:'公司'}});
  fireEvent.click(screen.getByLabelText('第1行挂账对象'));fireEvent.click(await screen.findByRole('option',{name:'合成当前公司'}));
  expect(screen.getByLabelText('第1行挂账对象').textContent).toContain('合成当前公司');fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
  await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({lines:[expect.objectContaining({feeItemId:7,relatedNode:'公司',relatedId:1,relatedName:null})]})));
  expect(resourceApi.users).toHaveBeenCalledTimes(1);expect(vi.mocked(resourceApi.list).mock.calls.some(([type])=>type==='company')).toBe(false);
});
it('人员对象与经办人共用本公司目录，切换节点清空旧对象且新选择不提供停用人员',async()=>{
  vi.mocked(resourceApi.users).mockResolvedValue([{id:11,name:'合成人员甲',active:true},{id:22,name:'合成人员乙',active:true},{id:33,name:'合成停用人员',active:false}]);
  render(<DocForm type="expense" inline onSaved={vi.fn()}/>);await fillExpense();fireEvent.change(screen.getByLabelText('第1行挂账节点'),{target:{value:'公司'}});fireEvent.click(screen.getByLabelText('第1行挂账对象'));fireEvent.click(await screen.findByRole('option',{name:'合成当前公司'}));
  fireEvent.change(screen.getByLabelText('第1行挂账节点'),{target:{value:'人员'}});expect(screen.getByLabelText('第1行挂账对象').textContent).not.toContain('合成当前公司');
  fireEvent.click(screen.getByLabelText('第1行挂账对象'));expect(screen.queryByRole('option',{name:/合成停用人员/})).toBeNull();fireEvent.click(await screen.findByRole('option',{name:'合成人员乙'}));fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
  await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({lines:[expect.objectContaining({relatedNode:'人员',relatedId:22,relatedName:null})]})));expect(resourceApi.users).toHaveBeenCalledTimes(1);
});
it('人员目录确认为空时沿原版保留自由文字输入，不虚构人员ID',async()=>{
  render(<DocForm type="expense" inline onSaved={vi.fn()}/>);await fillExpense();fireEvent.change(screen.getByLabelText('第1行挂账节点'),{target:{value:'人员'}});
  expect(screen.getByLabelText('第1行挂账对象').tagName).toBe('INPUT');fireEvent.change(screen.getByLabelText('第1行挂账对象'),{target:{value:'合成原文字人员'}});fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
  await waitFor(()=>expect(fa.create).toHaveBeenCalledWith(expect.objectContaining({lines:[expect.objectContaining({relatedNode:'人员',relatedId:null,relatedName:'合成原文字人员'})]})));
});
