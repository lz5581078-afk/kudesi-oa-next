import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef, type CategoryManageItem } from '@kudesi/shared';

const auth: { user: { permissions: { isCompanyAdmin: boolean; allow: string[]; deny: string[] } } } = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./RecordDetail', () => ({ RecordDetail: () => <div>详情</div>, useResourceCan: () => () => true }));
vi.mock('./CategoryTree', () => ({ CategoryTree: () => null }));
const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: apiMock }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), users: vi.fn().mockResolvedValue([]), export: vi.fn() } };
});
import { resourceApi } from './api';
import { CategoryManageDialog } from './CategoryManageDialog';
import { FieldInput } from './RecordForm';
import { ResourcePage } from './ResourcePage';
import { displayValue } from './format';
import { resetCategoryOptions } from './categoryOptions';

const def = getResourceDef('qualifications')!;
const sys = (value: string, label: string, sortOrder: number, count = 0): CategoryManageItem => ({ value, label, system: true, hidden: false, sortOrder, defaultLabel: label, count });
let items: CategoryManageItem[];
const base = () => [sys('seed_business_filing', '种子生产经营备案', 10), sys('brand_authorization', '品牌授权', 20, 3), sys('platform_operation', '平台经营资质', 30), sys('general', '其他资质', 40)];
const own = (over: Partial<CategoryManageItem> = {}): CategoryManageItem => ({ value: 'c_abcd1234', label: '协会证书', system: false, hidden: false, sortOrder: 50, count: 0, ...over });
const calls = () => apiMock.mock.calls.map((c) => [c[1]?.method ?? 'GET', c[0], c[1]?.body]);

beforeEach(() => {
  localStorage.clear();
  items = [...base(), own()];
  resetCategoryOptions({}, true);
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path === '/resources/category-options') return {};
    if (path.endsWith('/categories') && !init?.method) return { field: 'type', items };
    return { ok: true };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); auth.user.permissions = { isCompanyAdmin: true, allow: [], deny: [] }; });

const open = async (onChanged = vi.fn()) => {
  render(<CategoryManageDialog type="qualifications" def={def} onClose={vi.fn()} onChanged={onChanged} />);
  await screen.findByText('协会证书');
  return onChanged;
};
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

describe('管理分类弹窗', () => {
  it('列出名称、值、在用数量、系统/自建、显示状态；系统分类的值只读，不能隐藏和删除', async () => {
    await open();
    const brand = rowOf('品牌授权');
    expect(within(brand).getByText('brand_authorization')).toBeTruthy();
    expect(within(brand).getByText('只读')).toBeTruthy();
    expect(within(brand).getByText('3')).toBeTruthy();
    expect(within(brand).getByText('系统自带')).toBeTruthy();
    expect(within(rowOf('协会证书')).getByText('自建')).toBeTruthy();
    expect((within(brand).getByRole('button', { name: '隐藏' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(brand).getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(true);
    const mine = rowOf('协会证书');
    expect((within(mine).getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('新增分类：只填名称，提交后刷新列表和全局缓存并通知页面', async () => {
    const changed = await open();
    fireEvent.change(screen.getByLabelText('新分类名称'), { target: { value: '行业认证' } });
    fireEvent.click(screen.getByRole('button', { name: '新增分类' }));
    await waitFor(() => expect(calls()).toContainEqual(['POST', '/resources/qualifications/categories', { name: '行业认证' }]));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(calls().filter((c) => c[1] === '/resources/category-options').length).toBeGreaterThan(0);
  });

  it('改名只发名称；上下移动发完整顺序；隐藏/显示发 hidden', async () => {
    await open();
    fireEvent.click(within(rowOf('协会证书')).getByRole('button', { name: '改名' }));
    fireEvent.change(screen.getByLabelText('「协会证书」的新名称'), { target: { value: '协会资质' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(calls()).toContainEqual(['PATCH', '/resources/qualifications/categories/c_abcd1234', { name: '协会资质' }]));
    fireEvent.click(await screen.findByRole('button', { name: '上移「协会证书」' }));
    await waitFor(() => expect(calls()).toContainEqual(['POST', '/resources/qualifications/categories/reorder', { values: ['seed_business_filing', 'brand_authorization', 'platform_operation', 'c_abcd1234', 'general'] }]));
    fireEvent.click(within(rowOf('协会证书')).getByRole('button', { name: '隐藏' }));
    await waitFor(() => expect(calls()).toContainEqual(['PATCH', '/resources/qualifications/categories/c_abcd1234', { hidden: true }]));
  });

  it('有记录在用的自建分类不能删，提示数量；零记录的确认后才删除', async () => {
    items = [...base(), own({ count: 5 }), own({ value: 'c_empty001', label: '空分类', sortOrder: 60 })];
    await open();
    const used = rowOf('协会证书');
    expect((within(used).getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(used).getByText('有 5 条记录在用，只能隐藏')).toBeTruthy();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const empty = rowOf('空分类');
    fireEvent.click(within(empty).getByRole('button', { name: '删除' }));
    expect(calls().some((c) => c[0] === 'DELETE')).toBe(false);
    fireEvent.click(within(empty).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(calls()).toContainEqual(['DELETE', '/resources/qualifications/categories/c_empty001', undefined]));
    confirm.mockRestore();
  });

  it('服务端拒绝时显示原因（如重名）', async () => {
    await open();
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') throw Object.assign(new Error('已经有同名的分类了'), {});
      return path.endsWith('/categories') ? { field: 'type', items } : {};
    });
    fireEvent.change(screen.getByLabelText('新分类名称'), { target: { value: '品牌授权' } });
    fireEvent.click(screen.getByRole('button', { name: '新增分类' }));
    expect((await screen.findByRole('alert')).textContent).toContain('同名');
  });
});

const rec = (data: Record<string, unknown>) => ({ id: 1, type: 'qualifications', title: 't', status: 'normal', statusReason: null, data, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' }) as never;
const payload = { qualifications: { field: 'type', rows: [
  { value: 'brand_authorization', label: '品牌授权书', sortOrder: 20, hidden: false, custom: false },
  { value: 'c_abcd1234', label: '协会证书', sortOrder: 50, hidden: false, custom: true },
  { value: 'c_old00001', label: '旧分类', sortOrder: 60, hidden: true, custom: true },
] } };

describe('分类在页面各处生效', () => {
  const typeField = def.fields.find((f) => f.key === 'type')!;

  it('列表/详情显示本公司名称：改名、自建；已隐藏的值仍显示并带提示', () => {
    resetCategoryOptions(payload, true);
    expect(displayValue(typeField, rec({ type: 'brand_authorization' }))).toBe('品牌授权书');
    expect(displayValue(typeField, rec({ type: 'c_abcd1234' }))).toBe('协会证书');
    expect(displayValue(typeField, rec({ type: 'c_old00001' }))).toBe('旧分类（已隐藏）');
    expect(displayValue(typeField, rec({ type: 'general' }))).toBe('其他资质');
  });

  it('新建/编辑下拉：含自建分类和新名称，不含已隐藏的；记录原值是已隐藏分类时保留并标注', () => {
    resetCategoryOptions(payload, true);
    const { container, rerender } = render(<FieldInput field={typeField} value="" onChange={() => undefined} type="qualifications" known={{}} onKnown={() => undefined} />);
    let labels = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toContain('品牌授权书');
    expect(labels).toContain('协会证书');
    expect(labels.some((l) => l?.includes('旧分类'))).toBe(false);
    rerender(<FieldInput field={typeField} value="c_old00001" onChange={() => undefined} type="qualifications" known={{}} onKnown={() => undefined} />);
    labels = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toContain('旧分类（已隐藏）');
  });
});

describe('列表页签与齿轮', () => {
  const mkRow = (id: number) => ({ id, type: 'qualifications', title: `证${id}`, status: 'normal', statusReason: null, data: { name: `证${id}`, type: 'c_abcd1234' }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' });
  const show = () => render(<MemoryRouter><ResourcePage type="qualifications" /></MemoryRouter>);
  beforeEach(() => {
    vi.mocked(resourceApi.list).mockResolvedValue({ items: [mkRow(1)], total: 1, page: 1, pageSize: 20, tabCounts: { c_abcd1234: 1 } } as never);
  });

  it('有“管理分类”权限的人在页签栏右侧看到齿轮；页签按本公司名称、顺序，含自建、不含已隐藏', async () => {
    resetCategoryOptions(payload, true);
    show();
    const tabs = await screen.findByRole('tablist', { name: '分类' });
    const names = within(tabs).getAllByRole('tab').map((t) => t.textContent);
    expect(names[0]).toBe('全部');
    expect(names.some((n) => n?.startsWith('品牌授权书'))).toBe(true);
    expect(names.some((n) => n?.startsWith('协会证书'))).toBe(true);
    expect(names.some((n) => n?.includes('旧分类'))).toBe(false);
    fireEvent.click(within(tabs).getByRole('button', { name: '管理分类' }));
    expect(await screen.findByRole('dialog', { name: '管理分类' })).toBeTruthy();
  });

  it('没有权限的人看不到齿轮，页签照常显示', async () => {
    auth.user.permissions = { isCompanyAdmin: false, allow: ['resource.qualifications.view'], deny: [] };
    resetCategoryOptions(payload, true);
    show();
    const tabs = await screen.findByRole('tablist', { name: '分类' });
    expect(within(tabs).queryByRole('button', { name: '管理分类' })).toBeNull();
    expect(within(tabs).getAllByRole('tab').length).toBeGreaterThan(3);
  });

  it('公司没有任何配置时页签就是代码里的选项', async () => {
    resetCategoryOptions({}, true);
    show();
    const tabs = await screen.findByRole('tablist', { name: '分类' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['全部', '种子生产经营备案', '品牌授权', '平台经营资质', '其他资质']);
  });
});
