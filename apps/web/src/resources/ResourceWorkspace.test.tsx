import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESOURCE_DEFS, getResourceDef, type FieldDef } from '@kudesi/shared';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('./api', async orig => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), get: vi.fn(), update: vi.fn(), users: vi.fn(), departments: vi.fn(), relations: vi.fn().mockResolvedValue([]), logs: vi.fn().mockResolvedValue([]), similarCheck: vi.fn().mockResolvedValue({ blocked: [], warnings: [] }) }, draftApi: { ...mod.draftApi, get: vi.fn().mockResolvedValue({ draft: null }) } };
});
import { resourceApi } from './api';
import { RecordDetail } from './RecordDetail';
import { clearRefCache, RecordForm, RefSelect, RefsSelect } from './RecordForm';
const field = { key: 'storeIds', label: '更多关联店铺', type: 'refs', ref: 'stores', group: '关联信息' } as FieldDef;
const store = (id: number, title: string) => ({ id, title, type: 'stores', data: {}, status: 'normal', refLabels: {}, secretConfigured: {}, files: {}, statusReason: null, createdAt: '', updatedAt: '' });
beforeEach(() => {
  clearRefCache();
  vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
  vi.mocked(resourceApi.get).mockResolvedValue(store(1, '来源资料'));
  vi.mocked(resourceApi.users).mockResolvedValue([]);
  vi.mocked(resourceApi.departments).mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// 共用界面必须覆盖所有配置，尤其不能为了排版把复杂字段放回嵌套 label。
describe('全部资料编辑入口的控件语义', () => {
  it.each(RESOURCE_DEFS.filter(def => !def.readOnly && def.fields.some(f => !f.readonly)).map(def => [def.key, def] as const))('%s：复合字段不嵌套标签，单字段显式关联输入', async (_key, def) => {
    const view = render(<MemoryRouter><RecordForm def={def} record={null} onClose={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>);
    const dialog = screen.getByRole('dialog');
    expect(dialog.classList.contains('resource-editor')).toBe(true);
    expect(dialog.querySelector('label label')).toBeNull();
    for (const label of dialog.querySelectorAll<HTMLLabelElement>('.rf-field > label[for]')) {
      expect(document.getElementById(label.htmlFor)).toBeTruthy();
    }
    await waitFor(() => expect(view.baseElement.querySelector('.resource-editor')).toBeTruthy());
  });

  it('两个相同资料表单同时存在时，分区和字段id各自独立', () => {
    const def = getResourceDef('self-media')!;
    render(<><RecordForm def={def} record={null} onClose={vi.fn()} onSaved={vi.fn()} /><RecordForm def={def} record={null} onClose={vi.fn()} onSaved={vi.fn()} /></>);
    const ids = [...document.querySelectorAll('[id^="rf-field-"],[id^="rf-sec-"]')].map(el => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('关联资料多选与历史选择保护', () => {
  it('页外已选项名称匹配原id；搜索不清空选择，可通过已选标签独立移除', async () => {
    vi.mocked(resourceApi.list).mockImplementation(async (_type, query) => ({ items: query.keyword ? [store(88, '搜索结果店铺')] : [store(1, '已选主店'), store(2, '另一家店铺')], total: query.keyword ? 1 : 104, page: 1, pageSize: 50 }));
    const changed = vi.fn();
    function Fixture() {
      const [value, setValue] = useState([1,95]);
      return <RefsSelect field={field} value={value} labelNow="已选主店、历史长名称店铺" onChange={v => { changed(v); setValue(v); }} />;
    }
    render(<Fixture />);
    const historical = await screen.findByRole('checkbox', { name: /历史长名称店铺/ });
    expect((historical as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByRole('checkbox', { name: /^已选主店$/ })).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索更多关联店铺' }), { target: { value: '搜索' } });
    await screen.findByRole('checkbox', { name: '搜索结果店铺' });
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '移除更多关联店铺：历史长名称店铺' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '移除更多关联店铺：已选主店' }));
    expect(changed).toHaveBeenLastCalledWith([95]);
    expect(screen.getByRole('button', { name: '移除更多关联店铺：历史长名称店铺' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '移除更多关联店铺：历史长名称店铺' }));
    expect(changed).toHaveBeenLastCalledWith([]);
    expect(screen.queryByRole('checkbox', { name: /历史长名称店铺/ })).toBeNull();
  });

  it('加载失败保留当前值并允许重试，不显示成空资料，也不主动清空值', async () => {
    const changed = vi.fn();
    vi.mocked(resourceApi.list).mockRejectedValueOnce(new Error('network')).mockResolvedValue({ items: [store(95,'历史关联店铺')], total: 1, page: 1, pageSize: 50 });
    render(<RefSelect field={{...field,type:'ref'}} value={95} labelNow="历史关联店铺" onChange={changed} />);
    await screen.findByRole('alert');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('历史关联店铺');
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
    await screen.findByRole('option', { name: '历史关联店铺' });
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('95');
    expect(changed).not.toHaveBeenCalled();
  });

  it('编辑自媒体时，多选增删后保存同一组真实编号，不改密码和其他字段', async () => {
    const record = { ...store(3,'测试自媒体'), type: 'self-media', data: { name: '测试自媒体', platform: 'douyin', livePermission: true, storeIds: [1,95], certifiedName: '认证人' }, refLabels: { storeIds: '已选主店、历史长名称店铺' }, secretConfigured: { password: true } };
    vi.mocked(resourceApi.list).mockImplementation(async type => ({ items: type === 'stores' ? [store(1,'已选主店'),store(2,'另一家店铺')] : [], total: type === 'stores' ? 104 : 0, page: 1, pageSize: 50 }));
    vi.mocked(resourceApi.update).mockResolvedValue(record);
    render(<RecordForm def={getResourceDef('self-media')!} record={record} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: '另一家店铺' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(resourceApi.update).toHaveBeenCalledWith('self-media',3,expect.objectContaining({ storeIds: [1,95,2], certifiedName: '认证人', livePermission: true })));
    const sent = vi.mocked(resourceApi.update).mock.calls[0][2];
    expect(sent).not.toHaveProperty('password');
    expect(within(screen.getByRole('dialog')).queryAllByRole('checkbox').length).toBeGreaterThan(0);
  });
});

// 详情入口包含子资料和只读历史，全部沿用同一外观，而不是只改截图中的一个类型。
describe('全部资料查看入口', () => {
  it.each(RESOURCE_DEFS.map(def => [def.key, def] as const))('%s：详情在同一界面加载，操作与分区仍可用', async (_key, def) => {
    const record = { ...store(1, `${def.label}查看验收`), type: def.key, status: def.defaultStatus, data: {} };
    vi.mocked(resourceApi.get).mockResolvedValue(record);
    render(<MemoryRouter><RecordDetail def={def} id={1} onClose={vi.fn()} onChanged={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector('.resource-detail')).toBeTruthy());
    expect(document.querySelector('.resource-detail')?.getAttribute('aria-label')).toBe(`${def.label}详情`);
  });
});
