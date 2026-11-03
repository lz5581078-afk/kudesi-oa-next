import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceDictionaryManager } from './ResourceDictionaryManager';
import { resourceApi, type ResourceDto } from './api';

const auth = vi.hoisted(() => ({ companyId: 1, id: 1, permissions: { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] } }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: auth }) }));
vi.mock('./api', () => ({ resourceApi: { list: vi.fn(), create: vi.fn(), remove: vi.fn(), reorderCategories: vi.fn() } }));
const row = (id: number, title: string, data: Record<string, unknown> = {}): ResourceDto => ({ id, title, type: '', data, status: 'active', statusReason: null, refLabels: {}, files: {}, secretConfigured: {}, createdAt: '', updatedAt: '' });
const list = (items: ResourceDto[], total = items.length) => ({ items, total, page: 1, pageSize: 200 });
const target = 'finance-labor-work-types';
beforeEach(() => { vi.resetAllMocks(); auth.companyId = 1; auth.permissions = { isCompanyAdmin: true, allow: [], deny: [] }; vi.mocked(resourceApi.list).mockResolvedValue(list([])); });
afterEach(cleanup);

describe('原位字典维护', () => {
  it('读取全部201项、引用数来自返回事实，已用/未知引用项不可删除', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => row(index + 1, `合成字典${index}`, { code: `C${index}`, referenceCount: index === 0 ? 2 : 0, sortOrder: index }));
    rows[1].data.referenceCount = undefined;
    vi.mocked(resourceApi.list).mockImplementation(async (_type, query) => list(rows.slice(((query.page ?? 1) - 1) * 200, (query.page ?? 1) * 200), 201));
    render(<ResourceDictionaryManager target={target} onClose={vi.fn()}/>);
    await screen.findByText('合成字典200');
    expect(screen.getByRole('button', { name: '删除合成字典0' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '删除合成字典1' })).toHaveProperty('disabled', true);
    expect(screen.getByText('编码 C0 · 2 个项目引用')).toBeTruthy();
    expect(resourceApi.list).toHaveBeenCalledWith(target, expect.objectContaining({ page: 2 }));
  });

  it('新增只提交名称，失败保留草稿，重试成功后把实际新记录选回父表单', async () => {
    const created = row(7, '合成包装', { code: 'HCBZ', referenceCount: 0 });
    vi.mocked(resourceApi.create).mockRejectedValueOnce(new Error('合成失败')).mockResolvedValueOnce(created);
    const pick = vi.fn(); render(<ResourceDictionaryManager target={target} onClose={vi.fn()} onPick={pick}/>);
    fireEvent.change(screen.getByRole('textbox', { name: '分类名称' }), { target: { value: ' 合成包装 ' } });
    fireEvent.click(screen.getByRole('button', { name: '新增并选中' }));
    await screen.findByText('合成失败'); expect(pick).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: '分类名称' })).toHaveProperty('value', ' 合成包装 ');
    fireEvent.click(screen.getByRole('button', { name: '新增并选中' }));
    await waitFor(() => expect(pick).toHaveBeenCalledWith(created));
    expect(resourceApi.create).toHaveBeenLastCalledWith(target, { name: '合成包装' });
  });

  it('拖动提交完整次序，失败保留旧实际顺序；无编辑/删除权限无对应操作', async () => {
    vi.mocked(resourceApi.list).mockResolvedValue(list([row(1, '甲', { referenceCount: 0, sortOrder: 10 }), row(2, '乙', { referenceCount: 0, sortOrder: 20 }), row(3, '丙', { referenceCount: 0, sortOrder: 30 })]));
    vi.mocked(resourceApi.reorderCategories).mockRejectedValueOnce(new Error('排序失败'));
    const view = render(<ResourceDictionaryManager target={target} onClose={vi.fn()}/>);
    const first = (await screen.findByText('甲')).closest('[draggable]')!;
    const third = screen.getByText('丙').closest('[draggable]')!;
    fireEvent.dragStart(first, { dataTransfer: { effectAllowed: '', setData: vi.fn() } });
    fireEvent.drop(third);
    await screen.findByText('排序失败');
    expect(resourceApi.reorderCategories).toHaveBeenCalledWith(target, [2, 1, 3]);
    expect([...view.container.querySelectorAll('.resource-dictionary-list strong')].map(el => el.textContent)).toEqual(['甲', '乙', '丙']);
    auth.permissions = { isCompanyAdmin: false, allow: ['resource.finance-labor-costs.create'], deny: [] };
    view.rerender(<ResourceDictionaryManager target={target} onClose={vi.fn()}/>);
    await screen.findByText('甲');
    expect(screen.queryByRole('button', { name: '删除甲' })).toBeNull();
    expect(view.container.querySelector('[draggable=true]')).toBeNull();
  });

  it('未引用项仍需明确确认；服务端发现新引用时保留资料并显示原因', async () => {
    vi.mocked(resourceApi.list).mockResolvedValue(list([row(1, '合成计价单位', { code: 'UNIT', referenceCount: 0 })]));
    vi.mocked(resourceApi.remove).mockRejectedValueOnce(new Error('该单位刚被项目引用，不能删除'));
    render(<ResourceDictionaryManager target="finance-labor-units" onClose={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button', { name: '删除合成计价单位' }));
    expect(resourceApi.remove).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog', { name: '删除合成计价单位' });
    fireEvent.click(within(confirm).getByRole('button', { name: '确认删除' }));
    await screen.findByText('该单位刚被项目引用，不能删除');
    expect(resourceApi.remove).toHaveBeenCalledWith('finance-labor-units', 1, '删除未引用字典项');
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }));
    expect(screen.getByText('合成计价单位')).toBeTruthy();
  });

  it('切公司后旧创建响应不选入新表单；新公司草稿和目录独立', async () => {
    let finish!: (row: ResourceDto) => void;
    vi.mocked(resourceApi.create).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pick = vi.fn();
    const view = render(<ResourceDictionaryManager target={target} onClose={vi.fn()} onPick={pick}/>);
    fireEvent.change(screen.getByRole('textbox', { name: '分类名称' }), { target: { value: '旧公司分类' } });
    fireEvent.click(screen.getByRole('button', { name: '新增并选中' }));
    await waitFor(() => expect(resourceApi.create).toHaveBeenCalledTimes(1));
    auth.companyId = 2; view.rerender(<ResourceDictionaryManager target={target} onClose={vi.fn()} onPick={pick}/>);
    expect(screen.getByRole('textbox', { name: '分类名称' })).toHaveProperty('value', '');
    await act(async () => { finish(row(9, '旧公司分类')); });
    expect(pick).not.toHaveBeenCalled(); expect(screen.queryByText('旧公司分类')).toBeNull();
  });
});
