import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';

const api = vi.hoisted(() => ({
  categoryTree: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), resourceApi: { ...(await orig<typeof import('./api')>()).resourceApi, ...api } }));
import { CategoryTree } from './CategoryTree';

const def = getResourceDef('fixed-assets')!;
const fields = ['categoryId', 'locationId', 'userId'].map((k) => def.fields.find((f) => f.key === k)!);

const treeOf = (field: string) => ({
  field, total: 5, uncategorized: 1,
  nodes: field === 'userId'
    ? [{ id: 7, title: '王芳', status: 'normal', parentId: 0, sort: 0, count: 2 }]
    : [{ id: 1, title: field === 'locationId' ? '三楼' : '电脑', status: 'normal', parentId: 0, sort: 1, count: 3 }, { id: 2, title: '笔记本', status: 'normal', parentId: 1, sort: 1, count: 2 }],
});

function mount(over: Partial<React.ComponentProps<typeof CategoryTree>> = {}, onSelect = vi.fn()) {
  const props = { type: 'fixed-assets', fields, tab: '', status: '', showHidden: false, values: {}, reloadKey: 0, onSelect, canManage: () => false, ...over } as React.ComponentProps<typeof CategoryTree>;
  render(<CategoryTree {...props} />);
  return onSelect;
}

describe('列表左侧多维度浏览', () => {
  beforeEach(() => { api.categoryTree.mockImplementation(async (_t: string, p: { field: string }) => treeOf(p.field)); });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('顶部切换维度：分类/位置/使用人，各维度各取各的目录', async () => {
    mount();
    await screen.findByText('电脑');
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['分类', '位置', '使用人']);
    fireEvent.click(screen.getByRole('tab', { name: /位置/ }));
    await screen.findByText('三楼');
    fireEvent.click(screen.getByRole('tab', { name: /使用人/ }));
    await screen.findByText('王芳');
    expect(api.categoryTree.mock.calls.map((c) => c[1].field)).toEqual(expect.arrayContaining(['categoryId', 'locationId', 'userId']));
  });

  it('点目录里的项，把维度和编号一起交给列表', async () => {
    const onSelect = mount();
    fireEvent.click(await screen.findByText('电脑'));
    expect(onSelect).toHaveBeenCalledWith('categoryId', '1');
  });

  it('没有编辑权限时看不到“管理”；有权限时进入管理能改名', async () => {
    mount();
    await screen.findByText('电脑');
    expect(screen.queryByRole('button', { name: '管理' })).toBeNull();
    cleanup();
    api.update.mockResolvedValue({});
    const onChanged = vi.fn();
    mount({ canManage: (f) => f.key === 'categoryId', onChanged });
    await screen.findByText('电脑');
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    fireEvent.click(screen.getByText('电脑'));
    fireEvent.click(await screen.findByRole('button', { name: '改名「电脑」' }));
    const input = screen.getByLabelText('分类名称');
    fireEvent.change(input, { target: { value: '电脑设备' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.update).toHaveBeenCalled());
    expect(api.update.mock.calls[0][0]).toBe('asset-categories');
  });

  it('使用人这类平铺维度不提供管理', async () => {
    mount({ canManage: () => true, values: { userId: '7' } });
    await screen.findByText('王芳');
    expect(screen.queryByRole('button', { name: '管理' })).toBeNull();
  });

  it('未选择、不存在、父分类和停用分类都不允许新增', async () => {
    for (const value of ['', '99', '1', '3']) {
      const onLeaf = vi.fn();
      api.categoryTree.mockResolvedValue({ ...treeOf('categoryId'), nodes: [...treeOf('categoryId').nodes, { id: 3, title: '旧分类', status: 'inactive', parentId: 0, sort: 3, count: 0 }] });
      mount({ values: { categoryId: value }, onLeaf });
      await screen.findByText('电脑');
      expect(onLeaf).toHaveBeenLastCalledWith(false);
      cleanup();
    }
  });

  it('已加载的末级切换档案类型后立即收回新增资格，失败时也不沿用旧目录', async () => {
    const onLeaf = vi.fn();
    const props = { type: 'fixed-assets', fields, tab: 'raw', status: '', showHidden: false, values: { categoryId: '2' }, reloadKey: 0, onSelect: vi.fn(), onLeaf };
    const view = render(<CategoryTree {...props} />);
    await waitFor(() => expect(onLeaf).toHaveBeenLastCalledWith(true));
    let reject!: (error: Error) => void;
    api.categoryTree.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    view.rerender(<CategoryTree {...props} tab="package" />);
    expect(onLeaf).toHaveBeenLastCalledWith(false);
    reject(new Error('offline'));
    await screen.findByText('分类目录加载失败');
    expect(onLeaf).toHaveBeenLastCalledWith(false);
  });

  it('往来单位顶级目录即使没有下级也不能新增，不能沿用其他顶级目录的末级', async () => {
    const onLeaf = vi.fn();
    mount({ type: 'finance-suppliers', rootId: 2, values: { categoryId: '2' }, onLeaf });
    await screen.findByText('请选择最末级分类后新增档案');
    expect(onLeaf).toHaveBeenLastCalledWith(false);
    cleanup();
    mount({ rootId: 3, values: { categoryId: '2' }, onLeaf });
    await screen.findByText('还没有分类，先到“资料维护”里建分类');
    expect(onLeaf).toHaveBeenLastCalledWith(false);
  });
});


describe('费用分列目录', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });
  it('沿所选目录展开下一列，再点祖先返回上级；只提交所选层级编号', async () => {
    api.categoryTree.mockResolvedValue({ field: 'categoryId', total: 2, uncategorized: 0, nodes: [
      { id: 1, title: '运行费用', parentId: 0, sort: 0, count: 2, status: 'active' },
      { id: 2, title: '软件', parentId: 1, sort: 1, count: 2, status: 'active' },
      { id: 3, title: '软件订阅', parentId: 2, sort: 1, count: 2, status: 'active' },
    ] });
    const picked = vi.fn();
    function FeeDirectory() {
      const [value, setValue] = useState('1');
      return <CategoryTree type="finance-fee-items" fields={[getResourceDef('finance-fee-items')!.fields.find(f => f.key === 'categoryId')!]} tab="" status="" showHidden={false} values={{ categoryId: value }} reloadKey={0} rootId={1} onSelect={(key, id) => { picked(key, id); setValue(id); }} canManage={() => false} />;
    }
    render(<FeeDirectory />);
    fireEvent.click(await screen.findByRole('button', { name: '软件 ›' }));
    expect(picked).toHaveBeenLastCalledWith('categoryId', '2');
    fireEvent.click(await screen.findByRole('button', { name: '软件订阅 2 条' }));
    expect(picked).toHaveBeenLastCalledWith('categoryId', '3');
    fireEvent.click(screen.getByRole('button', { name: '软件 ›' }));
    expect(picked).toHaveBeenLastCalledWith('categoryId', '');
    expect(screen.queryByRole('button', { name: '软件订阅 2 条' })).toBeNull();
  });
});

 describe('24号往来目录直属数量',()=>{
 afterEach(()=>{cleanup();vi.clearAllMocks();});
 it('直属零显示下级数，父级汇总不能当直属；再次选择保留当前分类并展开',async()=>{
 api.categoryTree.mockResolvedValue({field:'categoryIds',total:1,uncategorized:0,nodes:[
 {id:1,title:'店铺客户',parentId:0,sort:0,status:'active',count:1,directCount:0},
 {id:2,title:'平台客户',parentId:1,sort:0,status:'active',count:1,directCount:0},
 {id:3,title:'合成末级',parentId:2,sort:0,status:'active',count:1,directCount:1}]});
 const picked=vi.fn(),onLeaf=vi.fn();
 mount({type:'finance-customers',fields:[getResourceDef('finance-customers')!.fields.find(f=>f.key==='categoryIds')!],rootId:1,values:{categoryIds:'2'},onLeaf},picked);
 const parent=await screen.findByRole('button',{name:'平台客户 1 个下级'});
 fireEvent.click(parent);expect(picked).toHaveBeenLastCalledWith('categoryIds','2');
 expect(await screen.findByRole('button',{name:'合成末级 1 条'})).toBeTruthy();
 expect(onLeaf).toHaveBeenLastCalledWith(false);
 fireEvent.click(screen.getByRole('button',{name:'合成末级 1 条'}));expect(picked).toHaveBeenLastCalledWith('categoryIds','3');
 });
 });

it('费用空根级仍可直接新增下级，只有占位列显示无下级说明',async()=>{
 api.categoryTree.mockResolvedValue({field:'categoryId',total:0,uncategorized:0,nodes:[{id:1,title:'空费用目录',parentId:0,sort:0,status:'active',count:0,directCount:0}]});
 render(<CategoryTree type="finance-fee-items" fields={[getResourceDef('finance-fee-items')!.fields.find(f=>f.key==='categoryId')!]} tab="" status="" showHidden={false} values={{categoryId:'1'}} reloadKey={0} rootId={1} onSelect={vi.fn()} canManage={()=>true} canCreate={()=>true}/>);
 await screen.findByText('空费用目录');expect(screen.getAllByRole('button',{name:'新增'})).toHaveLength(1);expect(screen.getAllByText('当前分类没有下级，右侧列表只显示本级费用档案。')).toHaveLength(1);
});
