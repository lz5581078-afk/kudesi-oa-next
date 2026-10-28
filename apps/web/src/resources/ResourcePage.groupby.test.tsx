import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./RecordForm', () => ({ RecordForm: ({ initial }: { initial?: Record<string, unknown> }) => <div>表单 {JSON.stringify(initial ?? {})}</div>, loadRefOptions: async () => [] }));
vi.mock('./RecordDetail', () => ({ RecordDetail: ({ id }: { id: number }) => <div>详情{id}</div>, useResourceCan: () => () => true }));
vi.mock('./CategoryTree', () => ({ CategoryTree: () => null }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), users: vi.fn().mockResolvedValue([]), departments: vi.fn(), export: vi.fn() } };
});
import { ResourcePage } from './ResourcePage';

const mk = (id: number, code: string, dept?: number, label?: string) => ({ id, type: 'duty-groups', title: code, status: 'normal', statusReason: null, data: { code, name: `${code}组`, scope: 'department', ...(dept ? { departmentId: dept } : {}) }, secretConfigured: {}, refLabels: label ? { departmentId: label } : {}, createdAt: '', updatedAt: '', createdByName: null, updatedByName: null }) as never;
const rows = [mk(1, 'a', 2, '总部 / 运营部'), mk(2, 'b', 3, '总部 / 财务部'), mk(3, 'c', 2, '总部 / 运营部'), mk(4, 'd')];
const list = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 200, tabCounts: { all: 4, 'q:uncat': 1 } }) as never;
const page = () => render(<MemoryRouter><ResourcePage type="duty-groups" /></MemoryRouter>);

beforeEach(() => {
  localStorage.clear();
  vi.mocked(resourceApi.list).mockResolvedValue(list(rows));
  vi.mocked(resourceApi.departments).mockResolvedValue([{ id: 1, name: '总部', parentId: null }, { id: 2, name: '运营部', parentId: 1 }, { id: 3, name: '财务部', parentId: 1 }] as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('职责组按部门分组', () => {
  it('默认按部门分组：每个部门一个分组头（带条数），没填部门的在“未分类”；有“未分类”页签', async () => {
    page();
    await screen.findByText('总部 / 运营部');
    const heads = Array.from(document.querySelectorAll('.res-group-row')).map((r) => r.textContent ?? '');
    expect(heads).toHaveLength(3);
    expect(heads[0]).toContain('总部 / 运营部');
    expect(heads[0]).toContain('2 条');
    expect(heads[2]).toContain('未分类');
    expect(screen.getByRole('tab', { name: /未分类/ })).toBeTruthy();
  });
  it('分组可折叠，折叠状态被记住；关闭“按部门分组”回到平铺', async () => {
    const first = page();
    await screen.findByText('总部 / 运营部');
    fireEvent.click(screen.getByRole('button', { name: '总部 / 运营部分组' }));
    await waitFor(() => expect(document.querySelectorAll('tbody tr:not(.res-group-row)').length).toBe(2));
    expect(localStorage.getItem('kudesi.folded.duty-groups')).toBeTruthy();
    first.unmount();
    page();
    await screen.findByText('总部 / 运营部');
    expect(document.querySelectorAll('tbody tr:not(.res-group-row)').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: '按部门分组' }));
    await waitFor(() => expect(document.querySelectorAll('.res-group-row').length).toBe(0));
  });
  it('在某个分组里点“＋ 新增”，新增表单预填该部门', async () => {
    page();
    await screen.findByText('总部 / 财务部');
    const head = Array.from(document.querySelectorAll('.res-group-row')).find((r) => r.textContent?.includes('财务部')) as HTMLElement;
    fireEvent.click(Array.from(head.querySelectorAll('button')).find((b) => b.textContent?.includes('新增')) as HTMLElement);
    expect(await screen.findByText(/"departmentId":3/)).toBeTruthy();
  });
});
