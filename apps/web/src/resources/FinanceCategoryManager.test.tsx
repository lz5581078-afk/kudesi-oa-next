import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { ApiError } from '../api/client';
import {financeDictionaryApi} from './financeDictionaryApi';
vi.mock('./financeDictionaryApi',()=>({financeDictionaryApi:{context:vi.fn(),preview:vi.fn()}}));
import { FinanceCategoryManager } from './FinanceCategoryManager';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./CodeCategorySync',()=>({CodeCategorySync:()=> <div>聚水潭商品分类</div>}));
vi.mock('./api', () => ({ resourceApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), saveArchivePrefix:vi.fn(), reorderCategories:vi.fn() } }));
const node = (id: number, name: string, parentId = 0) => ({ id, title: name, data: { name, code: `C${id}`, parentId, archiveType: 'raw', sort: id * 10 }, status: 'active' });
const nodes = [node(1, '种子'), node(2, '稻种', 1), node(3, '籼稻', 2)];
beforeEach(() => { vi.mocked(financeDictionaryApi.context).mockResolvedValue({kind:'product_category',rows:[]});vi.mocked(financeDictionaryApi.preview).mockResolvedValue({code:'XFL',baseCode:'XFL',conflict:false,errors:[],nameConflict:null,nameMaxLength:160,codeMaxLength:48,usage:null}); auth.user.permissions.isCompanyAdmin = true; auth.user.permissions.allow = []; vi.mocked(resourceApi.list).mockResolvedValue({ items: nodes, total: 3, page: 1, pageSize: 200 } as never); vi.mocked(resourceApi.create).mockResolvedValue(node(4, '新分类', 2) as never); vi.mocked(resourceApi.update).mockResolvedValue(nodes[0] as never); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const show = () => render(<FinanceCategoryManager target="finance-categories" archiveType="raw" selectedId={3} onChanged={vi.fn()} onClose={vi.fn()} />);

describe('24号分类管理：逐级维护与保存失败保护', () => {
  it('编码分类按原四层维护，资料数包含后代且空列指明需选层级',async()=>{
    const codeNodes=nodes.map(row=>({...row,data:{...row.data,kind:'product_category'}}));
    vi.mocked(resourceApi.list).mockResolvedValue({items:codeNodes,total:3,page:1,pageSize:200} as never);
    render(<FinanceCategoryManager target="finance-code-dictionaries" maxDepth={4} counts={{3:3}} context={{field:'kind',value:'product_category',label:'商品编码分类',text:'商品编码分类'}} onChanged={vi.fn()} onClose={vi.fn()}/>);
    const dialog=await screen.findByRole('dialog',{name:'管理商品编码分类'});
    await within(dialog).findByRole('button',{name:/种子.*3 条资料/});
    expect(within(dialog).getByText('两套编码分类分别维护，同一公司内分类名称不能重复。')).toBeTruthy();
    expect(within(dialog).getByText('请先选择一级分类')).toBeTruthy();
    expect(within(dialog).getByText('请先选择二级分类')).toBeTruthy();
    expect(within(dialog).getByText('四级为最深层级；任意没有下级的分类都可归入商品编码。')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox',{name:'商品编码分类'})).toBeNull();
  });

  it('弹窗脱离吸顶目录，分类保存不触发外层档案表单', async () => {
    const outerSubmit = vi.fn(event => event.preventDefault());
    render(<form onSubmit={outerSubmit}><aside className="cat-tree">
      <FinanceCategoryManager target="finance-categories" archiveType="raw" selectedId={3} onChanged={vi.fn()} onClose={vi.fn()} />
    </aside></form>);
    await screen.findByRole('button', { name: '编辑籼稻' });
    const manager = screen.getByRole('dialog', { name: '管理原料分类' });
    expect(manager.closest('.cat-tree, form')).toBeNull();
    fireEvent.click(within(manager).getByRole('button', { name: '编辑籼稻' }));
    const editor = screen.getByRole('dialog', { name: '编辑分类' });
    expect(editor.parentElement?.closest('form, .cat-tree')).toBeNull();
    fireEvent.change(within(editor).getByRole('textbox', { name: /分类名称/ }), { target: { value: '已改名的籼稻' } });
    fireEvent.click(within(editor).getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(resourceApi.update).toHaveBeenCalledWith('finance-categories', 3, expect.objectContaining({ name: '已改名的籼稻' })));
    expect(outerSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑分类' })).toBeNull());
  });

  it('在选中父级下新增，带所属类型、父级和标识，不会建到一级目录', async () => {
    show();
    await screen.findByRole('button', { name: '编辑籼稻' });
    fireEvent.click(within(screen.getByRole('region', { name: '三级分类' })).getByRole('button', { name: '新增' }));
    fireEvent.change(screen.getByRole('textbox', { name: /分类名称/ }), { target: { value: '新分类' } });
    fireEvent.change(screen.getByRole('textbox', { name: '分类标识' }), { target: { value: 'NEW' } });
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    await waitFor(() => expect(resourceApi.create).toHaveBeenCalledWith('finance-categories', expect.objectContaining({ archiveType: 'raw', parentId: 2, name: '新分类', code: 'NEW' })));
  });
  it('改名失败保留用户输入及编辑窗口，可纠正后重试；含子类节点不能删除', async () => {
    vi.mocked(resourceApi.update).mockRejectedValueOnce(new ApiError(409, '分类标识已使用'));
    show(); await screen.findByRole('button', { name: '编辑稻种' });
    expect((screen.getByRole('button', { name: '删除种子' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '编辑稻种' }));
    fireEvent.change(screen.getByRole('textbox', { name: /分类名称/ }), { target: { value: '稻谷' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findAllByText('分类标识已使用');
    expect((screen.getByRole('textbox', { name: /分类名称/ }) as HTMLInputElement).value).toBe('稻谷');
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑分类' })).toBeNull());
  });
  it('只读用户可以浏览路径，没有新增、编辑或删除控件', async () => {
    auth.user.permissions.isCompanyAdmin = false;
    show(); await screen.findByText('籼稻');
    expect(screen.queryByRole('button', { name: '新增' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑籼稻' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除籼稻' })).toBeNull();
  });
  it('顶级编号保存失败保留草稿，重试只写类型编号，不重写分类或商品',async()=>{
    vi.mocked(resourceApi.saveArchivePrefix).mockRejectedValueOnce(new ApiError(409,'编号被占用')).mockResolvedValueOnce({data:{code:'ZYL'}} as never);
    show();await screen.findByRole('button',{name:'编辑籼稻'});
    fireEvent.click(screen.getByRole('button',{name:'修改顶级编号'}));
    fireEvent.change(screen.getByLabelText('顶级分类编号'),{target:{value:'ZYL'}});
    fireEvent.click(screen.getByRole('button',{name:'保存编号'}));
    await screen.findByText('编号被占用');expect((screen.getByLabelText('顶级分类编号') as HTMLInputElement).value).toBe('ZYL');
    fireEvent.click(screen.getByRole('button',{name:'保存编号'}));
    await waitFor(()=>expect(screen.queryByLabelText('顶级分类编号')).toBeNull());
    expect(resourceApi.saveArchivePrefix).toHaveBeenLastCalledWith('raw','ZYL');expect(resourceApi.update).not.toHaveBeenCalled();
  });
  it('进入一个顶级分类后只显示本目录及下级，其他顶级目录不会混入',async()=>{
    vi.mocked(resourceApi.list).mockResolvedValue({items:[...nodes,node(9,'其他顶级'),node(10,'其他目录',9)],total:5,page:1,pageSize:200} as never);
    render(<FinanceCategoryManager target="finance-supplier-categories" rootId={1} selectedId={3} onChanged={vi.fn()} onClose={vi.fn()}/>);
    await screen.findByText('籼稻');expect(screen.queryByText('其他目录')).toBeNull();expect(screen.queryByText('其他顶级')).toBeNull();
  });

  it('编码分类以字符串kind隔离，统一创建保留kind且不提交档案类型',async()=>{
    vi.mocked(resourceApi.list).mockResolvedValue({items:[],total:0,page:1,pageSize:200});
    const created={...node(4,'合成编码分类'),type:'finance-code-dictionaries',data:{kind:'product_category',name:'合成编码分类',code:'HC',sort:0}};
    vi.mocked(resourceApi.create).mockResolvedValue(created as never);
    render(<FinanceCategoryManager target="finance-code-dictionaries" maxDepth={2} context={{field:'kind',value:'product_category',label:'商品编码分类',text:'商品编码分类'}} onChanged={vi.fn()} onClose={vi.fn()}/>);
    await waitFor(()=>expect(resourceApi.list).toHaveBeenCalledWith('finance-code-dictionaries',expect.objectContaining({fieldKey:'kind',fieldValue:'product_category'})));
    fireEvent.click(within(screen.getByRole('region',{name:'一级分类'})).getByRole('button',{name:'新增'}));
    fireEvent.change(screen.getByRole('textbox',{name:/分类名称/}),{target:{value:'合成编码分类'}});
    await waitFor(()=>expect((screen.getByRole('textbox',{name:'分类标识'}) as HTMLInputElement).value).toBe('XFL'));
    await waitFor(()=>expect((screen.getByRole('button',{name:'确认创建'}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button',{name:'确认创建'}));
    await waitFor(()=>expect(resourceApi.create).toHaveBeenCalledWith('finance-code-dictionaries',{kind:'product_category',name:'合成编码分类',code:'XFL',sort:0}));
  });

});

it('费用行内新增只打开原单字段窗，失败保留名称，仍走同一个分类保存内核',async()=>{
 const changed=vi.fn(),closed=vi.fn();vi.mocked(resourceApi.create).mockRejectedValueOnce(new ApiError(409,'分类名称已存在'));
 render(<FinanceCategoryManager target="finance-fee-categories" rootId={1} editorOnlyParentId={2} onChanged={changed} onClose={closed}/>);
 await screen.findByRole('dialog',{name:'新增分类'});await waitFor(()=>expect((screen.getByRole('button',{name:'保存分类'}) as HTMLButtonElement).disabled).toBe(false));
 expect(screen.queryByRole('heading',{name:'管理费用类别'})).toBeNull();expect(screen.queryByRole('textbox',{name:'分类标识'})).toBeNull();expect(screen.queryByText('保存后的分类路径')).toBeNull();
 fireEvent.change(screen.getByRole('textbox',{name:'分类名称'}),{target:{value:'新费用分类'}});fireEvent.click(screen.getByRole('button',{name:'保存分类'}));await screen.findByText('分类名称已存在');expect((screen.getByRole('textbox',{name:'分类名称'}) as HTMLInputElement).value).toBe('新费用分类');expect(closed).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'保存分类'}));await waitFor(()=>expect(closed).toHaveBeenCalledOnce());expect(changed).toHaveBeenCalledOnce();expect(resourceApi.create).toHaveBeenLastCalledWith('finance-fee-categories',{name:'新费用分类',parentId:2,sort:40});
});
it('费用行内新增取消关闭整个专属窗，不写分类',async()=>{
 const closed=vi.fn();render(<FinanceCategoryManager target="finance-fee-categories" rootId={1} editorOnlyParentId={2} onChanged={vi.fn()} onClose={closed}/>);
 fireEvent.click(await screen.findByRole('button',{name:'取消'}));expect(closed).toHaveBeenCalledOnce();expect(resourceApi.create).not.toHaveBeenCalled();
});
it('费用管理按原两列与当前分类侧栏展示，顶级不能编辑，新增编辑只开名称窗',async()=>{
 const closed=vi.fn(),picked=vi.fn();render(<FinanceCategoryManager target="finance-fee-categories" rootId={1} selectedId={1} directCounts={{2:1}} onPick={picked} onChanged={vi.fn()} onClose={closed}/>);
 await screen.findByRole('button',{name:/稻种.*1 条/});expect(screen.queryByText(/个一级分类/)).toBeNull();expect(screen.queryByRole('button',{name:'编辑稻种'})).toBeNull();expect((screen.getByRole('button',{name:'编辑当前'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:/稻种.*1 条/}));expect(picked).toHaveBeenCalledWith(2);fireEvent.click(screen.getByRole('button',{name:'编辑当前'}));await screen.findByRole('dialog',{name:'编辑分类'});expect(screen.queryByRole('dialog',{name:'管理种子分类'})).toBeNull();expect((screen.getByRole('textbox',{name:'分类名称'}) as HTMLInputElement).value).toBe('稻种');fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(closed).toHaveBeenCalledOnce();expect(resourceApi.update).not.toHaveBeenCalled();
});
it('费用分类删除使用原确认窗，不额外要求原因，失败由原删除校验保留',async()=>{
 vi.mocked(resourceApi.remove).mockRejectedValue(new ApiError(409,'该分类仍有下级资料'));
 render(<FinanceCategoryManager target="finance-fee-categories" rootId={1} selectedId={3} onChanged={vi.fn()} onClose={vi.fn()}/>);await screen.findByRole('button',{name:'删除当前'});await waitFor(()=>expect((screen.getByRole('button',{name:'删除当前'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'删除当前'}));const confirm=screen.getByRole('dialog',{name:'确认删除'});expect(within(confirm).queryByRole('textbox')).toBeNull();fireEvent.click(within(confirm).getByRole('button',{name:'确认删除'}));await screen.findByText('该分类仍有下级资料');expect(resourceApi.remove).toHaveBeenCalledWith('finance-fee-categories',3,'分类管理确认删除分类');
});
