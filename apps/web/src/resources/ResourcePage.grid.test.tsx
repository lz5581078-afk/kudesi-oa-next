import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { resourceApi } from './api';

let perms: { isCompanyAdmin: boolean; allow: string[]; deny: string[] } = { isCompanyAdmin: true, allow: [], deny: [] };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: perms } }) }));
vi.mock('./RecordForm', () => ({ RecordForm: () => <div>表单</div>, loadRefOptions: async () => [] }));
vi.mock('./RecordDetail', () => ({
  RecordDetail: ({ id }: { id: number }) => <div>详情{id}</div>,
  useResourceCan: () => (a: string) => (perms.isCompanyAdmin ? true : perms.allow.includes(`resource.phones.${a}`)),
}));
vi.mock('./CategoryTree', () => ({ CategoryTree: () => null }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), gridSave: vi.fn(), users: vi.fn().mockResolvedValue([]) } };
});
import { ResourcePage } from './ResourcePage';

const row = (id: number, carrier: string) => ({ id, type: 'phones', title: `1380013800${id}`, status: 'normal', statusReason: null, data: { number: `1380013800${id}`, carrier, usageType: 'company_kept' }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '', version: `v${id}` });
const list = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20, tabCounts: {} }) as never;
const page = (type = 'phones') => render(<MemoryRouter><ResourcePage type={type} /></MemoryRouter>);
const realMatchMedia = window.matchMedia;
const media = (wide: boolean) => { window.matchMedia = ((q: string) => ({ matches: wide, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as never; };

beforeEach(() => {
  localStorage.clear();
  perms = { isCompanyAdmin: true, allow: [], deny: [] };
  vi.mocked(resourceApi.list).mockResolvedValue(list([row(1, '移动'), row(2, '联通')]));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); window.matchMedia = realMatchMedia; });

describe('资料页：表格编辑入口', () => {
  it('有编辑权限显示“表格编辑”按钮；没有编辑权限不显示', async () => {
    const first = page();
    expect(await screen.findByRole('button', { name: '表格编辑' })).toBeTruthy();
    first.unmount();
    perms = { isCompanyAdmin: false, allow: ['resource.phones.view'], deny: [] };
    page();
    await screen.findByText('1380013800' + '1');
    expect(screen.queryByRole('button', { name: '表格编辑' })).toBeNull();
  });

  it('窄屏（手机）不提供表格编辑', async () => {
    media(false);
    page();
    await screen.findAllByText('移动');
    expect(screen.queryByRole('button', { name: '表格编辑' })).toBeNull();
  });

  it('不适合网格的资料（如组合）不显示按钮', async () => {
    vi.mocked(resourceApi.list).mockResolvedValue(list([]));
    page('finance-bundles');
    await screen.findByText(/还没有/);
    expect(screen.queryByRole('button', { name: '表格编辑' })).toBeNull();
  });

  it('进入后整页变成可编辑网格（沿用现有筛选），有未保存修改时锁住筛选和翻页；保存成功后刷新并可退出', async () => {
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'update', id: 1, ok: true, row: { ...row(1, '电信') } as never }] });
    page();
    fireEvent.click(await screen.findByRole('button', { name: '表格编辑' }));
    expect(await screen.findByRole('application')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /勾选/ })).toBeNull();
    // 每页条数切到 200，请求带着
    await waitFor(() => expect(vi.mocked(resourceApi.list).mock.calls.some((c) => c[1]?.pageSize === 200)).toBe(true));
    const label = getResourceDef('phones')!.fields.find((f) => f.key === 'carrier')!.label;
    const idx = Array.from(document.querySelectorAll('thead th')).findIndex((th) => th.querySelector('button,span')?.textContent === label) - 1;
    expect(idx).toBeGreaterThanOrEqual(0);
    fireEvent.mouseDown(document.querySelector(`td[data-r="0"][data-c="${idx}"]`)!);
    fireEvent.keyDown(screen.getByRole('application'), { key: 'Enter' });
    const input = screen.getByLabelText(/^编辑/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '电信' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('1 处修改')).toBeTruthy();
    expect((screen.getByRole('button', { name: /^筛选/ }).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true);
    const before = vi.mocked(resourceApi.list).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(vi.mocked(resourceApi.list).mock.calls.length).toBeGreaterThan(before));
    fireEvent.click(screen.getByRole('button', { name: '退出表格编辑' }));
    await waitFor(() => expect(screen.queryByRole('application')).toBeNull());
    expect(screen.getByRole('button', { name: '表格编辑' })).toBeTruthy();
  });
});
