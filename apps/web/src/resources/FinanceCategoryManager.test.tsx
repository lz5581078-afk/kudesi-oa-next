import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { ApiError } from '../api/client';
import { FinanceCategoryManager } from './FinanceCategoryManager';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./api', () => ({ resourceApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), saveArchivePrefix:vi.fn(), reorderCategories:vi.fn() } }));
const node = (id: number, name: string, parentId = 0) => ({ id, title: name, data: { name, code: `C${id}`, parentId, archiveType: 'raw', sort: id * 10 }, status: 'active' });
const nodes = [node(1, '种子'), node(2, '稻种', 1), node(3, '籼稻', 2)];
beforeEach(() => { auth.user.permissions.isCompanyAdmin = true; auth.user.permissions.allow = []; vi.mocked(resourceApi.list).mockResolvedValue({ items: nodes, total: 3, page: 1, pageSize: 200 } as never); vi.mocked(resourceApi.create).mockResolvedValue(node(4, '新分类', 2) as never); vi.mocked(resourceApi.update).mockResolvedValue(nodes[0] as never); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const show = () => render(<FinanceCategoryManager target="finance-categories" archiveType="raw" selectedId={3} onChanged={vi.fn()} onClose={vi.fn()} />);

describe('24号分类管理：逐级维护与保存失败保护', () => {
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

});
