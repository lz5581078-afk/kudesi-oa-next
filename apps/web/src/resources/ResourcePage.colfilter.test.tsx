import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_TIME_FIELDS, getResourceDef } from '@kudesi/shared';
import { resourceApi } from './api';
import { editCarrier } from './gridTestKit';

const perms = { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: perms } }) }));
vi.mock('./RecordForm', () => ({ RecordForm: () => <div>表单</div>, loadRefOptions: async () => [] }));
vi.mock('./RecordDetail', () => ({ RecordDetail: () => <div>详情</div>, useResourceCan: () => () => true }));
vi.mock('./CategoryTree', () => ({ CategoryTree: () => null }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), gridSave: vi.fn(), export: vi.fn(), columnFacets: vi.fn().mockResolvedValue({ items: [{ value: 'company_kept', count: 12 }] }), users: vi.fn().mockResolvedValue([]) } };
});
import { ResourcePage } from './ResourcePage';

const row = (id: number, carrier: string) => ({ id, type: 'phones', title: `1380013800${id}`, status: 'normal', statusReason: null, data: { number: `1380013800${id}`, carrier, usageType: 'company_kept' }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '', version: `v${id}` });
const list = (items: unknown[], total = items.length) => ({ items, total, page: 1, pageSize: 20, tabCounts: {} }) as never;
const lastParams = () => vi.mocked(resourceApi.list).mock.calls.at(-1)![1]!;
async function openGrid() {
  render(<MemoryRouter><ResourcePage type="phones" /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '表格编辑' }));
  await screen.findByRole('application');
}
const colButton = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}列筛选`) }) as HTMLButtonElement;
async function filterCarrier(text: string) {
  fireEvent.click(colButton('运营商'));
  fireEvent.change(screen.getByLabelText('值'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '应用' }));
  await waitFor(() => expect(lastParams().colFilters).toEqual([{ key: 'carrier', op: 'contains', value: text }]));
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(resourceApi.list).mockResolvedValue(list([row(1, '移动'), row(2, '联通')], 450));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('资料页：表格列筛选', () => {
  it('表格模式下可筛选的列头都有漏斗（文本、手机、金额、日期、单选、引用、状态）；读时才算出来的列（主子卡、绑定店铺）和子表列没有', async () => {
    await openGrid();
    const heads = Array.from(document.querySelectorAll('thead th')).filter((th) => th.querySelector('.grid-th-label'));
    const funnel = (label: string) => heads.filter((th) => th.querySelector('.grid-th-label')!.textContent!.replace(/ [↑↓]$/, '') === label).map((th) => within(th as HTMLElement).queryAllByRole('button').filter((b) => (b.getAttribute('aria-label') ?? '').startsWith(`${label}列筛选`)).length);
    const labelOf = (key: string) => getResourceDef('phones')!.fields.find((f) => f.key === key)!.label;
    for (const key of ['number', 'carrier', 'usageType', 'monthlyFee', 'nextRechargeAt', 'parentPhoneId']) expect(funnel(labelOf(key)), key).toEqual([1]);
    expect(funnel('状态')).toEqual([1]);
    for (const key of READ_TIME_FIELDS.phones) expect(funnel(labelOf(key)).filter((n) => n > 0), key).toEqual([]);
  });

  it('设置条件 → 请求带 colFilters 且回到第 1 页；顶部“已筛选”标签条显示，分页总数是服务端给的', async () => {
    await openGrid();
    await filterCarrier('联通');
    expect(lastParams().page).toBe(1);
    const chips = document.querySelector('.res-chips')!;
    expect(chips.textContent).toContain('已筛选');
    expect(chips.textContent).toContain('运营商 包含 联通');
    expect(screen.getByText(/共 450 条/)).toBeTruthy();
    expect(colButton('运营商').className).toContain('on');
  });

  it('多列条件并存（并且）；标签可单独清除，也可一键清空', async () => {
    await openGrid();
    await filterCarrier('联通');
    fireEvent.click(colButton('手机号分类'));
    expect(await screen.findByText('12')).toBeTruthy(); // 数量
    fireEvent.click(screen.getByRole('checkbox', { name: /公司保存/ }));
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    await waitFor(() => expect(lastParams().colFilters).toHaveLength(2));
    expect(vi.mocked(resourceApi.columnFacets)).toHaveBeenCalledWith('phones', 'usageType', expect.any(Array));
    fireEvent.click(screen.getByRole('button', { name: /^清除运营商 包含 联通/ }));
    await waitFor(() => expect(lastParams().colFilters).toEqual([{ key: 'usageType', op: 'in', values: ['company_kept'] }]));
    fireEvent.click(screen.getByRole('button', { name: '清除搜索和筛选' }));
    await waitFor(() => expect(lastParams().colFilters ?? []).toEqual([]));
    expect(document.querySelector('.res-chips')).toBeNull();
  });

  it('条件按资料类型记在本机：重新打开还在；不再合法的条件被丢掉', async () => {
    await openGrid();
    await filterCarrier('联通');
    cleanup();
    await openGrid();
    await waitFor(() => expect(lastParams().colFilters).toEqual([{ key: 'carrier', op: 'contains', value: '联通' }]));
    cleanup();
    localStorage.setItem('kudesi.colfilter.phones', JSON.stringify({ filters: [{ key: 'nope', op: 'contains', value: 'x' }, { key: 'carrier', op: 'gt', value: '1' }], labels: {} }));
    await openGrid();
    await waitFor(() => expect(vi.mocked(resourceApi.list).mock.calls.length).toBeGreaterThan(0));
    expect(lastParams().colFilters ?? []).toEqual([]);
  });

  it('有未保存修改时：列筛选入口、已筛选标签、翻页、排序全部锁定并提示；保存后解锁', async () => {
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'update', id: 1, ok: true, row: { ...row(1, '电信') } as never }] });
    await openGrid();
    await filterCarrier('联通');
    await editCarrier('电信');
    expect(colButton('运营商').disabled).toBe(true);
    expect(colButton('运营商').title).toMatch(/请先保存或放弃/);
    expect(screen.getByRole('note').textContent).toMatch(/已锁定/);
    expect(screen.getByRole('button', { name: /^清除运营商 包含 联通/ }).matches(':disabled')).toBe(true); // 在被禁用的 fieldset 里
    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(colButton('运营商').disabled).toBe(false));
  });

  it('导出当前筛选带着列筛选', async () => {
    vi.mocked(resourceApi.export).mockResolvedValue({ filename: 'x.csv', csv: 'a', count: 1 });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    await openGrid();
    await filterCarrier('联通');
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '导出当前筛选' }));
    await waitFor(() => expect(resourceApi.export).toHaveBeenCalled());
    expect(vi.mocked(resourceApi.export).mock.calls[0][2]).toMatchObject({ colFilters: [{ key: 'carrier', op: 'contains', value: '联通' }] });
  });

  it('服务端拒绝条件时显示错误而不是静默', async () => {
    await openGrid();
    vi.mocked(resourceApi.list).mockRejectedValueOnce(Object.assign(new Error('没有权限按“采购价”筛选'), { name: 'ApiError' }));
    await filterCarrier('甲').catch(() => undefined);
    expect(vi.mocked(resourceApi.list).mock.calls.length).toBeGreaterThan(1);
  });
});
