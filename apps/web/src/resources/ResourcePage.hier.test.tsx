import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const formProps = vi.fn();
vi.mock('./RecordForm', async (orig) => {
  const mod = await orig<typeof import('./RecordForm')>();
  return { ...mod, RecordForm: (p: { initial?: Record<string, unknown>; record?: { title: string } | null }) => { formProps(p); return <div>{p.record ? `编辑表单:${p.record.title}` : '新增表单'}</div>; }, loadRefOptions: async () => [] };
});
const treeProps = vi.fn();
let leafValue = false;
vi.mock('./CategoryTree', async () => {
  const React = await import('react');
  return { CategoryTree: (p: { rootId?: number; hint?: string; onLeaf?: (v: boolean) => void; onSelect: (k: string, id: string) => void; values: Record<string, string> }) => {
    treeProps(p);
    React.useEffect(() => { p.onLeaf?.(leafValue); }, [p.onLeaf]);
    return <div data-testid="tree">{p.hint}<button onClick={() => p.onSelect('categoryIds', '')}>全部</button><i data-testid="val">{p.values.categoryIds ?? ''}</i></div>;
  } };
});
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), users: vi.fn().mockResolvedValue([]), changeStatus: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({ ok: true }) } };
});
import { ResourcePage } from './ResourcePage';

const row = (id: number, name: string, status = 'active') => ({ id, type: 'finance-suppliers', title: name, status, statusReason: null, data: { name, code: `GYS-00${id}`, shortName: '简', categoryIds: [3] }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' });
const hier = { title: '种子供应商', subtitle: '种子相关', rootId: 1, onBack: vi.fn() };
const renderIt = () => render(<MemoryRouter><ResourcePage type="finance-suppliers" hier={hier} /></MemoryRouter>);

beforeEach(() => {
  leafValue = false;
  vi.mocked(resourceApi.list).mockResolvedValue({ items: [row(1, '润农'), row(2, '绿源', 'inactive')], total: 2, page: 1, pageSize: 20 } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('分级布局下的列表页', () => {
  it('页头有返回上一级和顶级分类名；目录收到顶级分类 id 和“最末级才能新增”的提示；列表按顶级分类筛', async () => {
    renderIt();
    await screen.findByText('润农');
    expect(screen.getByRole('heading', { name: '种子供应商' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回上一级' }));
    expect(hier.onBack).toHaveBeenCalled();
    expect(treeProps.mock.calls.at(-1)![0]).toMatchObject({ rootId: 1, hint: '请选择最末级分类后新增供应商' });
    await waitFor(() => expect(vi.mocked(resourceApi.list).mock.calls.some((c) => c[1]?.filters?.categoryIds === '1')).toBe(true));
    // 顶级分类本身不算“筛选条件”，不出现“清除全部条件”
    expect(screen.queryByText(/找到 \d+ 条符合条件/)).toBeNull();
  });

  it('没选到最末级分类时点新增只给提示；选到最末级才打开表单', async () => {
    renderIt();
    await screen.findByText('润农');
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增' }));
    expect(screen.queryByText('新增表单')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('请选择最末级分类后新增供应商');
    cleanup(); leafValue = true;
    renderIt();
    await screen.findByText('润农');
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增' }));
    await screen.findByText('新增表单');
  });

  it('每行有 查看/编辑/复制新增/停用或启用/删除；复制新增不带编号；编辑打开该行的表单', async () => {
    renderIt();
    await screen.findByText('润农');
    expect(screen.getByRole('button', { name: '停用：润农' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '启用：绿源' })).toBeTruthy(); // 停用的是“启用”
    fireEvent.click(screen.getByRole('button', { name: '编辑：润农' }));
    await screen.findByText('编辑表单:润农');
    cleanup(); formProps.mockClear();
    renderIt();
    await screen.findByText('润农');
    fireEvent.click(screen.getByRole('button', { name: '复制新增：润农' }));
    await screen.findByText('新增表单');
    const init = formProps.mock.calls.at(-1)![0].initial as Record<string, unknown>;
    expect(init.name).toBe('润农');
    expect(init.code).toBeUndefined();
  });

  it('行内停用要写原因，写完调用状态接口；删除要写原因', async () => {
    renderIt();
    await screen.findByText('润农');
    fireEvent.click(screen.getByRole('button', { name: '停用：润农' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '不再合作' } });
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await waitFor(() => expect(resourceApi.changeStatus).toHaveBeenCalledWith('finance-suppliers', 1, 'inactive', '不再合作'));
    fireEvent.click(screen.getByRole('button', { name: '删除：绿源' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '重复录入' } });
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(resourceApi.remove).toHaveBeenCalledWith('finance-suppliers', 2, '重复录入'));
  });

  it('勾选后有批量删除，逐条写同一个原因', async () => {
    renderIt();
    await screen.findByText('润农');
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[1]); fireEvent.click(boxes[2]);
    fireEvent.click(await screen.findByRole('button', { name: /批量删除（2）/ }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '录入错误' } });
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(resourceApi.remove).toHaveBeenCalledTimes(2));
    expect(resourceApi.remove).toHaveBeenCalledWith('finance-suppliers', 1, '录入错误');
  });

  it('不是分级布局时（如在别处嵌入）没有这些行内操作', async () => {
    render(<MemoryRouter><ResourcePage type="finance-suppliers" /></MemoryRouter>);
    await screen.findByText('润农');
    expect(screen.queryByRole('button', { name: '复制新增：润农' })).toBeNull();
    expect(screen.queryByRole('button', { name: '返回上一级' })).toBeNull();
  });
});
