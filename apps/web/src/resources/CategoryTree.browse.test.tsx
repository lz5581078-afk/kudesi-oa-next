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
});
