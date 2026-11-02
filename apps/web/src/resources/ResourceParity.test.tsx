import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESOURCE_DEFS, getResourceDef, type FieldDef, type ResourceDef } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from './api';
import { RecordDetail } from './RecordDetail';
import { RecordForm, clearRefCache } from './RecordForm';
import { FINANCE_DETAIL_TYPES } from './FinanceDetailFields';
import { displayValue } from './format';
import { FinanceReferenceLayout } from '../pages/finance/FinanceReferenceLayout';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./api', async orig => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, get: vi.fn(), list: vi.fn(), users: vi.fn(), departments: vi.fn(), update: vi.fn(), relations: vi.fn(), logs: vi.fn(), similarCheck: vi.fn() }, draftApi: { ...mod.draftApi, get: vi.fn().mockResolvedValue({ draft: null }) } };
});
const dto = (def: ResourceDef, data: Record<string, unknown> = {}): ResourceDto => ({ id: 1, type: def.key, title: '字段一致性验收', data, status: def.defaultStatus, statusReason: null, refLabels: {}, secretConfigured: {}, files: {}, createdAt: '', updatedAt: '' });
const show = (def: ResourceDef) => render(<MemoryRouter><RecordDetail def={def} id={1} onClose={vi.fn()} onChanged={vi.fn()} /></MemoryRouter>);
beforeEach(() => {
  localStorage.clear(); clearRefCache();
  auth.user.permissions = { isCompanyAdmin: true, allow: [], deny: [] };
  vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
  vi.mocked(resourceApi.users).mockResolvedValue([]);
  vi.mocked(resourceApi.departments).mockResolvedValue([]);
  vi.mocked(resourceApi.relations).mockResolvedValue([]);
  vi.mocked(resourceApi.logs).mockResolvedValue([]);
  vi.mocked(resourceApi.similarCheck).mockResolvedValue({ blocked: [], warnings: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('查看与原位编辑的字段一致性', () => {
  it.each(RESOURCE_DEFS.filter(def => !FINANCE_DETAIL_TYPES.has(def.key) && !def.readOnly && def.fields.some(f => !f.readonly)).map(def => [def.key, def] as const))('%s：字段顺序和整行位置一致，只读字段不导致后续字段换列', async (_key, def) => {
    const data = Object.fromEntries(def.fields.filter(f => f.type === 'select').map(f => [f.key, f.options?.[0]?.value ?? '']));
    vi.mocked(resourceApi.get).mockResolvedValue(dto(def, data));
    show(def);
    await screen.findByRole('button', { name: '编辑' });
    const fields = [...document.querySelectorAll<HTMLElement>('.rd-item[data-field]')].map(el => ({ key: el.dataset.field, wide: el.classList.contains('wide') }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const form = screen.getByRole('group', { name: `编辑${def.label}` });
    expect([...form.querySelectorAll<HTMLElement>('.rf-field[data-field]')].map(el => ({ key: el.dataset.field, wide: el.classList.contains('wide') }))).toEqual(fields);
    expect(screen.queryByRole('dialog', { name: `编辑${def.label}` })).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: '取消' }));
    expect(document.querySelector('.resource-detail-editor')).toBeNull();
    expect([...document.querySelectorAll<HTMLElement>('.rd-item[data-field]')].map(el => el.dataset.field)).toEqual(fields.map(f => f.key));
    expect(resourceApi.update).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])('历史账号直播权限=%s，查看明确显示是/否，隐藏空字段也不会消失', async value => {
    const def = getResourceDef('self-media')!;
    vi.mocked(resourceApi.get).mockResolvedValue(dto(def, { name: '旧账号', platform: 'douyin', ...(value === undefined ? {} : { livePermission: value }) }));
    show(def);
    await screen.findByRole('button', { name: '编辑' });
    const cell = document.querySelector('[data-field="livePermission"]')!;
    expect(cell.textContent).toBe(`直播权限${value === true ? '是' : '否'}`);
    fireEvent.click(screen.getByRole('checkbox', { name: '隐藏空字段' }));
    expect(document.querySelector('[data-field="livePermission"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect((screen.getByRole('checkbox', { name: /直播权限/ }) as HTMLInputElement).checked).toBe(value === true);
  });

  it('编辑自媒体保留运营部门的只读位置，保存不提交该字段且未设置的开关提交false', async () => {
    const def = getResourceDef('self-media')!;
    const record = { ...dto(def, { name: '旧账号', platform: 'douyin', operatorDeptId: 4 }), refLabels: { operatorDeptId: '演示部门' } };
    vi.mocked(resourceApi.update).mockResolvedValue(record);
    render(<RecordForm def={def} record={record} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(document.querySelector('[data-field="operatorDeptId"]')?.textContent).toContain('演示部门');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(resourceApi.update).toHaveBeenCalled());
    expect(vi.mocked(resourceApi.update).mock.calls[0][2]).toMatchObject({ livePermission: false });
    expect(vi.mocked(resourceApi.update).mock.calls[0][2]).not.toHaveProperty('operatorDeptId');
  });

  it('隐藏后只剩零个或一个分区时，仍能关闭隐藏空字段恢复完整资料', async () => {
    const def = { ...getResourceDef('self-media')!, fields: [
      { key: 'first', label: '第一字段', type: 'text', group: '第一分区' },
      { key: 'second', label: '第二字段', type: 'text', group: '第二分区' },
    ] as FieldDef[] };
    vi.mocked(resourceApi.get).mockResolvedValue(dto(def));
    show(def);
    fireEvent.click(await screen.findByRole('checkbox', { name: '隐藏空字段' }));
    expect(document.querySelectorAll('.rd-item')).toHaveLength(0);
    fireEvent.click(screen.getByRole('checkbox', { name: '隐藏空字段' }));
    expect(document.querySelectorAll('.rd-item')).toHaveLength(2);
  });

  it('原位编辑时标题栏关闭也检查未保存内容，不会绕过确认丢失输入', async () => {
    const def = getResourceDef('self-media')!;
    vi.mocked(resourceApi.get).mockResolvedValue(dto(def, { name: '原账号', platform: 'douyin' }));
    show(def);
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox', { name: /账号名称/ }), { target: { value: '未保存名称' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: /账号名称/ })).toHaveProperty('value', '未保存名称');
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
    expect(document.querySelector('.resource-detail-editor')).toBeNull();
    expect(resourceApi.update).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('受限字段在查看和编辑中都不显示，不因补齐布局而扩大权限', async () => {
    auth.user.permissions = { isCompanyAdmin: false, allow: ['resource.self-media.view', 'resource.self-media.edit'], deny: [] };
    const def = { ...getResourceDef('self-media')!, fields: [...getResourceDef('self-media')!.fields, { key: 'restricted', label: '受限字段', type: 'text', group: '账号基础资料', permission: 'product.cost.view' } as FieldDef] };
    vi.mocked(resourceApi.get).mockResolvedValue(dto(def, { name: '账号', platform: 'douyin', restricted: '不可泄漏' }));
    show(def);
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    expect(screen.queryByText('受限字段')).toBeNull();
    expect(screen.queryByText('不可泄漏')).toBeNull();
  });
});

describe('字段格式一致性', () => {
  it('多选显示每项中文；缺少引用名称仍保留编号而不是显示空值', () => {
    const record = dto(getResourceDef('self-media')!, { choices: ['a', 'b'], refs: [1, 95] });
    expect(displayValue({ key: 'choices', type: 'select', multi: true, group: '基础', label: '多选', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }] }, record)).toBe('甲、乙');
    expect(displayValue({ key: 'refs', type: 'refs', group: '基础', label: '关联' }, record)).toBe('#1、#95');
  });
});


describe('专用资料查看不再遗漏编辑字段', () => {
  it.each([
    ['raw', undefined], ['self_made', undefined], ['purchased', 'original_purchase'], ['purchased', 'supplier_oem'],
    ['package', undefined], ['oem_package', undefined], ['shipping_material', undefined], ['custom', undefined],
  ])('%s/%s：每个实际编辑输入字段都能在只读查看中找到', async (archiveType, supplyMode) => {
    const def = getResourceDef('finance-products')!;
    const record = dto(def, { archiveType, supplyMode, name: '商品字段验收', specQty: 500, specUnit: 'G', shape: '圆形', giftShortName: '赠品简称甲', giftCodeShortName: 'ZP', zeroValueReason: '实际运费为零', freight: 0, brandId: 1, purchaseSpec: '斤', categoryId: 1 });
    const form = render(<MemoryRouter><RecordForm def={def} record={record} onClose={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>);
    const editable = [...form.container.querySelectorAll<HTMLElement>('.rf-field[data-field]')].map(el => el.dataset.field!);
    form.unmount();
    vi.mocked(resourceApi.get).mockResolvedValue(record);
    show(def);
    await waitFor(() => expect(document.querySelector('.finance-detail-dialog')).toBeTruthy());
    const view = document.querySelector('.resource-detail')!;
    for (const key of editable) expect(view.querySelector(`[data-field="${key}"]`), `${archiveType}/${supplyMode} 缺少 ${key}`).toBeTruthy();
  });

  it.each(['raw','self_made'])('仓库只读模式%s不额外读取供货、组成和成本资料', async archiveType => {
    const def = getResourceDef('finance-products')!;
    const record = { ...dto(def, { archiveType, name: '仓库商品', freight: 999 }), warehouseMode: true as const };
    vi.mocked(resourceApi.get).mockResolvedValue(record);
    show(def);
    await waitFor(() => expect(document.querySelector('.finance-detail-dialog')).toBeTruthy());
    expect(screen.queryByRole('region', { name: '供货来源' })).toBeNull();
    expect(screen.queryByRole('region', { name: '生产资料与成本' })).toBeNull();
    expect(screen.queryByRole('region', { name: '成本汇总' })).toBeNull();
    expect(resourceApi.list).not.toHaveBeenCalledWith('finance-product-sources', expect.anything());
    expect(resourceApi.list).not.toHaveBeenCalledWith('finance-product-boms', expect.anything());
  });

  it.each(['finance-base-codes', 'finance-bundles', 'finance-customers', 'finance-fee-items'])('%s：未填写的补充字段也有查看位置', async type => {
    const def = getResourceDef(type)!;
    const record = dto(def, { name: '专用档案' });
    vi.mocked(resourceApi.get).mockResolvedValue(record);
    show(def);
    await waitFor(() => expect(document.querySelector('.finance-detail-dialog')).toBeTruthy());
    for (const field of def.fields.filter(f => ['note','shortName'].includes(f.key))) expect(document.querySelector(`.resource-detail [data-field="${field.key}"]`), `${type} 缺少 ${field.key}`).toBeTruthy();
  });
});


describe('财务专用布局与字段修复兼容', () => {
  it.each(['finance-brands', 'finance-fee-items'])('%s保留财务弹窗布局，同时保留完整字段和取消行为', async type => {
    const def = getResourceDef(type)!;
    const record = dto(def, { name: '财务资料验收', code: 'DEMO-01', isCommon: false });
    vi.mocked(resourceApi.get).mockResolvedValue(record);
    render(<MemoryRouter><FinanceReferenceLayout><RecordDetail def={def} id={1} onClose={vi.fn()} onChanged={vi.fn()} /></FinanceReferenceLayout></MemoryRouter>);
    const edit = await screen.findByRole('button', { name: '编辑' });
    expect(document.querySelector('aside.rd')?.classList.contains('resource-detail')).toBe(false);
    fireEvent.click(edit);
    const dialog = screen.getByRole('dialog', { name: `编辑${def.label}` });
    expect(dialog.classList.contains('finance-reference-editor')).toBe(true);
    expect(document.querySelector('.resource-detail-editor')).toBeNull();
    expect(dialog.querySelector('[data-field="name"]')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /取消/ }));
    expect(document.querySelector('.finance-reference-editor')).toBeNull();
    expect(resourceApi.update).not.toHaveBeenCalled();
  });
});
