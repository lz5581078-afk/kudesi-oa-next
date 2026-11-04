import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi, type CategoryTreeResult } from './api';
import { ProductArchiveMoveDialog } from './ProductArchiveMoveDialog';
const auth = vi.hoisted(() => ({ user: { id:1, companyId:1, permissions:{isCompanyAdmin:true,allow:[] as string[],deny:[] as string[]} } }));
vi.mock('../auth/AuthContext', () => ({useAuth:()=>auth}));
vi.mock('./api', () => ({resourceApi:{categoryTree:vi.fn()}}));
const node = (id:number,title:string,parentId=0,status='active'):CategoryTreeResult['nodes'][number] => ({id,title,parentId,status,sort:id,count:0});
const tree = (nodes:CategoryTreeResult['nodes']):CategoryTreeResult => ({field:'categoryId',total:0,uncategorized:0,nodes});
const rows = [node(1,'甲'),node(2,'同名',1),node(3,'乙'),node(4,'同名',3,'inactive'),node(5,'已删除',1,'deleted')];
beforeEach(()=>{auth.user={id:1,companyId:1,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};vi.mocked(resourceApi.categoryTree).mockResolvedValue(tree(rows));});
afterEach(()=>{cleanup();vi.resetAllMocks();});
const open = async () => {const select=screen.getByRole('combobox',{name:'目标分类'});await screen.findByRole('option',{name:'甲 / 同名'});return select;};
describe('原商品移动分类收集窗口',()=>{
  it('使用同族真实完整目录、原生select与完整路径；父级可选但不能确认，同名叶靠ID区分',async()=>{
    const confirm=vi.fn().mockResolvedValue(undefined),close=vi.fn();render(<ProductArchiveMoveDialog family="raw" count={3} onConfirm={confirm} onClose={close}/>);
    expect(screen.getByRole('dialog',{name:'移动原料分类'})).toBeTruthy();expect(screen.getByText('已选择 3 个原料，只能移动到最下一级分类。')).toBeTruthy();
    const select=await open();expect(select.tagName).toBe('SELECT');expect(resourceApi.categoryTree).toHaveBeenCalledWith('finance-products',{field:'categoryId',tab:'raw',showHidden:true});
    expect(screen.queryByRole('option',{name:'甲 / 已删除'})).toBeNull();expect(screen.getByRole('option',{name:'乙 / 同名'})).toBeTruthy();
    const button=screen.getByRole('button',{name:'确认移动'});expect(button.hasAttribute('disabled')).toBe(true);
    expect((screen.getByRole('option',{name:'甲'}) as HTMLOptionElement).disabled).toBe(false);fireEvent.change(select,{target:{value:'1'}});expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(select,{target:{value:'4'}});expect(button.hasAttribute('disabled')).toBe(false);fireEvent.click(button);
    await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));expect(confirm).toHaveBeenCalledWith(4);
  });
  it.each([[2,false],[1,true],[99,true]] as const)('初始真实分类%s在目录核对后确认禁用=%s，不擅自改选同名叶',async(initialCategoryId,disabled)=>{
    render(<ProductArchiveMoveDialog family="raw" count={2} initialCategoryId={initialCategoryId} onConfirm={vi.fn()} onClose={vi.fn()}/>);await open();
    expect(screen.getByRole('button',{name:'确认移动'}).hasAttribute('disabled')).toBe(disabled);
    if(initialCategoryId===2)expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('2');
    if(initialCategoryId===99)expect((await screen.findByRole('alert')).textContent).toContain('已不存在或已删除');
  });
  it('完整201个分类不截断，坏父链不猜路径或作为末级；取消只关闭不调用确认',async()=>{
    const nodes=[node(1,'甲'),node(2,'同名',1),...Array.from({length:198},(_,i)=>node(10+i,`分类${i}`,1)),node(999,'父级缺失',777)];
    vi.mocked(resourceApi.categoryTree).mockResolvedValue(tree(nodes));const confirm=vi.fn(),close=vi.fn();render(<ProductArchiveMoveDialog family="raw" count={1} onConfirm={confirm} onClose={close}/>);await open();
    expect(screen.getAllByRole('option')).toHaveLength(202);expect(screen.getByRole('option',{name:'甲 / 分类197'})).toBeTruthy();
    expect((screen.getByRole('option',{name:'父级缺失（分类层级不完整）'}) as HTMLOptionElement).disabled).toBe(true);
    expect((await screen.findByRole('alert')).textContent).toContain('层级不完整');fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(close).toHaveBeenCalledTimes(1);expect(confirm).not.toHaveBeenCalled();
  });
  it('GET失败/空目录明确显示并允许重试；错误期间不可确认，重试不丢初始选择',async()=>{
    vi.mocked(resourceApi.categoryTree).mockRejectedValueOnce(new Error('分类读取失败')).mockResolvedValueOnce(tree([])).mockResolvedValueOnce(tree(rows));
    const confirm=vi.fn();render(<ProductArchiveMoveDialog family="raw" count={1} initialCategoryId={2} onConfirm={confirm} onClose={vi.fn()}/>);
    expect((await screen.findByRole('alert')).textContent).toContain('分类读取失败');expect(screen.getByRole('button',{name:'确认移动'}).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'重试'}));expect((await screen.findByRole('alert')).textContent).toContain('没有可移动的分类');
    fireEvent.click(screen.getByRole('button',{name:'重试'}));await open();expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('2');expect(screen.getByRole('button',{name:'确认移动'}).hasAttribute('disabled')).toBe(false);expect(confirm).not.toHaveBeenCalled();
  });
  it('确认失败保留目标和原错误，可用同ID重试；等待期间互斥且不关闭',async()=>{
    let finish!:(value?:unknown)=>void;const confirm=vi.fn().mockRejectedValueOnce(new Error('仍有引用，移动失败')).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})),close=vi.fn();
    render(<ProductArchiveMoveDialog family="raw" count={2} initialCategoryId={2} onConfirm={confirm} onClose={close}/>);await open();fireEvent.click(screen.getByRole('button',{name:'确认移动'}));
    expect((await screen.findByRole('alert')).textContent).toBe('仍有引用，移动失败');expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('2');expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'确认移动'}));fireEvent.submit(screen.getByRole('dialog'));expect(confirm.mock.calls).toEqual([[2],[2]]);
    for(const name of ['取消','关闭'])expect(screen.getByRole('button',{name}).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'关闭'}));expect(close).not.toHaveBeenCalled();await act(async()=>finish());await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));
  });
  it('身份变化立即取消窗口；旧分类请求迟到不能回填新范围',async()=>{
    let finish!:(value:CategoryTreeResult)=>void;vi.mocked(resourceApi.categoryTree).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const close=vi.fn();
    const props={family:'raw',count:1,onConfirm:vi.fn(),onClose:close};const view=render(<ProductArchiveMoveDialog {...props}/>);
    auth.user={...auth.user,companyId:2,id:2,permissions:{isCompanyAdmin:false,allow:['resource.finance-products.view'],deny:[]}};view.rerender(<ProductArchiveMoveDialog {...props}/>);
    expect(screen.queryByRole('dialog')).toBeNull();await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));await act(async()=>finish(tree(rows)));expect(screen.queryByRole('option')).toBeNull();expect(props.onConfirm).not.toHaveBeenCalled();
  });
  it('权限切换后旧确认成功不再回调新窗口，族切换同样取消',async()=>{
    let finish!:()=>void;const confirm=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})),close=vi.fn();const props={family:'raw',count:1,initialCategoryId:2,onConfirm:confirm,onClose:close};
    const view=render(<ProductArchiveMoveDialog {...props}/>);await open();fireEvent.click(screen.getByRole('button',{name:'确认移动'}));
    auth.user={...auth.user,permissions:{...auth.user.permissions,allow:['改变的权限']}};view.rerender(<ProductArchiveMoveDialog {...props}/>);await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));await act(async()=>finish());expect(close).toHaveBeenCalledTimes(1);view.unmount();
    const familyClose=vi.fn(),second=render(<ProductArchiveMoveDialog {...props} onClose={familyClose}/>);await open();second.rerender(<ProductArchiveMoveDialog {...props} family="shipping_material" onClose={familyClose}/>);await waitFor(()=>expect(familyClose).toHaveBeenCalledTimes(1));expect(screen.queryByRole('dialog')).toBeNull();
  });
});
