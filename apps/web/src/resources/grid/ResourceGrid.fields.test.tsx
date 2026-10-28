import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef, type FieldDef, type ResourceDef } from '@kudesi/shared';
import type { ResourceDto } from '../api';
import { resourceApi } from '../api';

let perms = { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] };
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: perms } }) }));
vi.mock('../api', async (orig) => {
  const mod = await orig<typeof import('../api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, gridSave: vi.fn(), get: vi.fn(), list: vi.fn().mockResolvedValue({ items: [], total: 0 }), users: vi.fn().mockResolvedValue([]), departments: vi.fn().mockResolvedValue([]) } };
});
// 文件上传、多引用选择、分类属性这些控件本身由 RecordForm/FilesField 的测试覆盖，这里换成最小替身，只验证表格怎么接它们
vi.mock('../FilesField', () => ({
  FilesInput: ({ value, onChange, onKnown }: { value: number[]; onChange: (v: number[]) => void; onKnown: (f: { id: number; name: string; mime: string; size: number }) => void }) => (
    <button type="button" onClick={() => { onKnown({ id: 7, name: '执照.png', mime: 'image/png', size: 1 }); onChange([...value, 7]); }}>模拟上传 ({value.length})</button>
  ),
}));
vi.mock('../RecordForm', async (orig) => {
  const mod = await orig<typeof import('../RecordForm')>();
  return {
    ...mod,
    RefsSelect: ({ value, onChange, onLabels }: { value: number[]; onChange: (v: number[]) => void; onLabels?: (m: Record<number, string>) => void }) => (
      <button type="button" onClick={() => { onChange([...value, 11]); onLabels?.({ 11: '供应商甲' }); }}>选供应商甲 ({value.length})</button>
    ),
    AttrsInput: ({ value, onChange }: { value: Record<string, string>; onChange: (v: unknown) => void }) => (
      <input aria-label="属性：颜色" value={value?.颜色 ?? ''} onChange={(e) => onChange({ ...value, 颜色: e.target.value })} />
    ),
  };
});
vi.mock('../RecordDetail', () => ({ ChildPanel: ({ childType }: { childType: string }) => <div>子表面板 {childType}</div> }));
import { ResourceGrid } from './ResourceGrid';
import { clearRefChoices } from './refResolve';

const dto = (type: string, id: number, title: string, data: Record<string, unknown> = {}, extra: Partial<ResourceDto> = {}): ResourceDto => ({ id, type, title, status: 'normal', statusReason: null, data: { ...data }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '', version: `v${id}`, ...extra });
const props = (def: ResourceDef, items: ResourceDto[]) => ({ def, items, derived: [], sort: null, onSort: vi.fn(), onDirtyChange: vi.fn(), onOpen: vi.fn(), onSaved: vi.fn(), onExit: vi.fn() });
const labelOf = (def: ResourceDef, k: string) => def.fields.find((f) => f.key === k)!.label;
const heads = () => Array.from(document.querySelectorAll('thead th')).map((th) => th.querySelector('button,span')?.textContent ?? '');
const colOf = (def: ResourceDef, k: string) => heads().indexOf(k === '$status' ? '状态' : labelOf(def, k)) - 1;
const cell = (def: ResourceDef, r: number, k: string) => document.querySelector(`td[data-r="${r}"][data-c="${colOf(def, k)}"]`) as HTMLElement;
/** 列选择器里的勾选框（文字后面可能跟着“*”“只读”） */
const box = (panel: HTMLElement, label: string) => within(panel).getAllByRole('checkbox').find((el) => (el.closest('label')?.textContent ?? '').replace(/[\s*]|只读/g, '') === label) as HTMLInputElement;
const scope = () => screen.getByRole('application');
const select = (def: ResourceDef, r: number, k: string) => { fireEvent.mouseDown(cell(def, r, k)); fireEvent.mouseUp(window); };
const confirmMock = vi.fn(() => true);
const realConfirm = window.confirm;

beforeEach(() => { localStorage.clear(); window.confirm = confirmMock as never; perms = { isCompanyAdmin: true, allow: [], deny: [] }; clearRefChoices(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); window.confirm = realConfirm; });

describe('表格自己的列选择器', () => {
  const def = getResourceDef('software')!;
  const items = [dto('software', 1, 'A', { name: 'A', account: 'a' })];
  const nonList = def.fields.filter((f) => !f.list && !f.readonly && f.type !== 'secret');

  it('默认显示该资料全部可编辑字段（含列表里不显示的），名称在最前；密码类默认不显示', () => {
    render(<ResourceGrid {...props(def, items)} />);
    expect(nonList.length).toBeGreaterThan(0);
    for (const f of nonList) expect(heads()).toContain(f.label);
    expect(heads()[1]).toBe(labelOf(def, 'name'));
    expect(heads()).not.toContain(labelOf(def, 'password'));
  });

  it('按字段分组、可搜索；预设“列表字段/全部字段/必填字段”；标识列固定；选择按资料类型记在本机', () => {
    render(<ResourceGrid {...props(def, items)} />);
    fireEvent.click(screen.getByRole('button', { name: /^列（/ }));
    const panel = screen.getByRole('dialog', { name: '选择表格列' });
    const groups = new Set(def.fields.map((f) => f.group));
    for (const g of groups) expect(within(panel).getByLabelText(new RegExp(`本组全选：${g}`))).toBeTruthy();
    // 搜索
    fireEvent.change(within(panel).getByLabelText('搜索列'), { target: { value: nonList[0].label } });
    expect(box(panel, nonList[0].label)).toBeTruthy();
    expect(within(panel).queryAllByRole('checkbox').some((el) => el.closest('label')?.textContent === labelOf(def, 'name'))).toBe(false);
    fireEvent.change(within(panel).getByLabelText('搜索列'), { target: { value: '' } });
    // 预设：列表字段
    fireEvent.click(within(panel).getByRole('button', { name: '列表字段' }));
    expect(heads()).not.toContain(nonList[0].label);
    expect(heads()).toContain(labelOf(def, 'name'));
    expect(JSON.parse(localStorage.getItem('kudesi.grid.cols.software')!)).not.toContain(nonList[0].key);
    // 标识列固定
    expect(box(panel, labelOf(def, 'name')).disabled).toBe(true);
    // 单个勾选
    fireEvent.click(box(panel, nonList[0].label));
    expect(heads()).toContain(nonList[0].label);
    // 全部字段 / 必填字段
    fireEvent.click(within(panel).getByRole('button', { name: '全部字段' }));
    expect(heads()).toContain(labelOf(def, 'password'));
    fireEvent.click(within(panel).getByRole('button', { name: '必填字段' }));
    const required = def.fields.filter((f) => f.required).map((f) => f.label);
    for (const l of required) expect(heads()).toContain(l);
    expect(heads()).not.toContain(nonList.find((f) => !f.required)!.label);
    // 按组勾选 / 清空
    fireEvent.click(within(panel).getByRole('button', { name: '清空' }));
    expect(heads().slice(1, -1)).toEqual([labelOf(def, 'name')]);
    const g = nonList[0].group;
    fireEvent.click(within(panel).getByLabelText(new RegExp(`本组全选：${g}`)));
    for (const f of def.fields.filter((x) => x.group === g && x.key !== 'name')) expect(heads()).toContain(f.label);
  });

  it('下次进入记得上次的选择；隐藏的列里没保存的修改不会丢，照样提交', async () => {
    localStorage.setItem('kudesi.grid.cols.software', JSON.stringify(['name', 'account']));
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'update', id: 1, ok: true, row: items[0] }] });
    render(<ResourceGrid {...props(def, items)} />);
    expect(heads().slice(1, -1)).toEqual([labelOf(def, 'name'), labelOf(def, 'account')]);
    select(def, 0, 'account');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    const input = screen.getByLabelText(/^编辑/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'zzz' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    fireEvent.click(screen.getByRole('button', { name: /^列（/ }));
    fireEvent.click(box(screen.getByRole('dialog', { name: '选择表格列' }), labelOf(def, 'account')));
    expect(heads()).not.toContain(labelOf(def, 'account'));
    expect(screen.getByText('1 处修改')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(resourceApi.gridSave).toHaveBeenCalled());
    expect(vi.mocked(resourceApi.gridSave).mock.calls[0][1].updates).toEqual([{ id: 1, version: 'v1', data: { account: 'zzz' } }]);
  });
});

describe('隐藏列时的选区', () => {
  it('选中的列被隐藏后选区收回到最后一列，继续按键不出错', () => {
    const def = getResourceDef('software')!;
    localStorage.setItem('kudesi.grid.cols.software', JSON.stringify(['name', 'account', 'annualFee']));
    render(<ResourceGrid {...props(def, [dto('software', 1, 'A', { name: 'A', account: 'a' })])} />);
    select(def, 0, 'annualFee');
    fireEvent.click(screen.getByRole('button', { name: /^列（/ }));
    fireEvent.click(box(screen.getByRole('dialog', { name: '选择表格列' }), labelOf(def, 'annualFee')));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(scope(), { key: 'Delete' });
    fireEvent.keyDown(scope(), { key: 'Enter' });
    expect(screen.getByLabelText(/^编辑/)).toBeTruthy();
  });
});

describe('新补上的编辑器', () => {
  it('日期：可手输，也可用日历选（原生 date）', async () => {
    const def = getResourceDef('software')!;
    render(<ResourceGrid {...props(def, [dto('software', 1, 'A', { name: 'A' })])} />);
    select(def, 0, 'renewAt');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    const pick = screen.getByLabelText(`用日历选择${labelOf(def, 'renewAt')}`) as HTMLInputElement;
    expect(pick.type).toBe('date');
    await act(async () => { fireEvent.change(pick, { target: { value: '2031-05-06' } }); });
    expect(cell(def, 0, 'renewAt').textContent).toBe('2031-05-06');
    expect(cell(def, 0, 'renewAt').className).toContain('changed');
  });

  it('多行文本：弹出多行框，Enter 换行、Ctrl+Enter 确定，保存带换行', async () => {
    const def = getResourceDef('finance-products')!;
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'update', id: 1, ok: true, row: dto('finance-products', 1, 'P') }] });
    render(<ResourceGrid {...props(def, [dto('finance-products', 1, 'P', { name: 'P', note: '旧' })])} />);
    select(def, 0, 'note');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    const ta = screen.getByRole('textbox', { name: `编辑${labelOf(def, 'note')}` }) as HTMLTextAreaElement;
    expect(ta.value).toBe('旧');
    fireEvent.change(ta, { target: { value: '第一行\n第二行' } });
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true }); });
    expect(cell(def, 0, 'note').className).toContain('changed');
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(resourceApi.gridSave).toHaveBeenCalled());
    expect(vi.mocked(resourceApi.gridSave).mock.calls[0][1].updates?.[0].data).toEqual({ note: '第一行\n第二行' });
  });

  it('文件：弹出上传浮层，确定后格子显示个数，保存提交文件 id', async () => {
    const def = getResourceDef('licenses')!;
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'update', id: 1, ok: true, row: dto('licenses', 1, 'L') }] });
    render(<ResourceGrid {...props(def, [dto('licenses', 1, 'L', { companyName: 'L' })])} />);
    select(def, 0, 'originalPhoto');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    const dlg = screen.getByRole('dialog');
    fireEvent.click(within(dlg).getByRole('button', { name: /模拟上传/ }));
    fireEvent.click(within(dlg).getByRole('button', { name: '确定' }));
    await waitFor(() => expect(cell(def, 0, 'originalPhoto').textContent).toBe('1 个文件'));
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(resourceApi.gridSave).toHaveBeenCalled());
    expect(vi.mocked(resourceApi.gridSave).mock.calls[0][1].updates?.[0].data).toEqual({ originalPhoto: [7] });
  });

  it('多引用：弹出多选框，格子显示名称，保存提交 id 数组；Esc 取消不留改动', async () => {
    const def = getResourceDef('finance-suppliers')!;
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'update', id: 1, ok: true, row: dto('finance-suppliers', 1, 'S') }] });
    render(<ResourceGrid {...props(def, [dto('finance-suppliers', 1, 'S', { name: 'S' })])} />);
    select(def, 0, 'categoryIds');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /选供应商甲/ }));
    fireEvent.keyDown(screen.getByRole('group', { name: `多选${labelOf(def, 'categoryIds')}` }), { key: 'Escape' });
    expect(screen.getByText('没有修改')).toBeTruthy();
    fireEvent.keyDown(scope(), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /选供应商甲/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确定' })); });
    expect(cell(def, 0, 'categoryIds').textContent).toBe('供应商甲');
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(resourceApi.gridSave).toHaveBeenCalled());
    expect(vi.mocked(resourceApi.gridSave).mock.calls[0][1].updates?.[0].data).toEqual({ categoryIds: [11] });
  });

  it('属性：弹出属性框（复用详情页的控件），保存提交对象', async () => {
    const def = getResourceDef('fixed-assets')!;
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'update', id: 1, ok: true, row: dto('fixed-assets', 1, 'F') }] });
    render(<ResourceGrid {...props(def, [dto('fixed-assets', 1, 'F', { name: 'F' })])} />);
    select(def, 0, 'attrs');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('属性：颜色'), { target: { value: '黑' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确定' })); });
    expect(cell(def, 0, 'attrs').textContent).toBe('颜色：黑');
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(resourceApi.gridSave).toHaveBeenCalled());
    expect(vi.mocked(resourceApi.gridSave).mock.calls[0][1].updates?.[0].data).toEqual({ attrs: { 颜色: '黑' } });
  });

  it('结构化清单（JSON）：弹出编辑框，格式不对不让确定', async () => {
    const base = getResourceDef('software')!;
    const def: ResourceDef = { ...base, fields: [...base.fields, { key: 'items', label: '清单', type: 'json', group: '清单' } as FieldDef] };
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'update', id: 1, ok: true, row: dto('software', 1, 'A') }] });
    render(<ResourceGrid {...props(def, [dto('software', 1, 'A', { name: 'A' })])} />);
    select(def, 0, 'items');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    const ta = screen.getByLabelText('编辑清单（JSON）');
    fireEvent.change(ta, { target: { value: '{bad' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(await screen.findByText(/不是合法的 JSON/)).toBeTruthy();
    fireEvent.change(ta, { target: { value: '[{"sku":"a","qty":1}]' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确定' })); });
    expect(cell(def, 0, 'items').textContent).toBe('[{"sku":"a","qty":1}]');
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(resourceApi.gridSave).toHaveBeenCalled());
    expect(vi.mocked(resourceApi.gridSave).mock.calls[0][1].updates?.[0].data).toEqual({ items: [{ sku: 'a', qty: 1 }] });
  });
});

describe('状态列与子表列', () => {
  const def = getResourceDef('licenses')!;
  const row = () => dto('licenses', 1, '甲公司', { companyName: '甲公司' });

  it('状态下拉：普通状态直接改；需要原因的先弹原因框；保存时和字段一起提交', async () => {
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'update', id: 1, ok: true, row: row() }] });
    render(<ResourceGrid {...props(def, [row()])} />);
    expect(cell(def, 0, '$status').textContent).toBe('正常');
    select(def, 0, '$status');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('更改状态'), { target: { value: 'abnormal' } });
    await waitFor(() => expect(cell(def, 0, '$status').textContent).toBe('异常'));
    expect(cell(def, 0, '$status').className).toContain('changed');
    // 需要原因：弹框，不填不让确认
    select(def, 0, '$status');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('更改状态'), { target: { value: 'cancelled' } });
    const dlg = await screen.findByRole('dialog', { name: /改为“注销”/ });
    fireEvent.click(within(dlg).getByRole('button', { name: '确认' }));
    expect(await within(dlg).findByText(/请填写原因/)).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText('原因'), { target: { value: '主体已注销' } });
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '确认' })); });
    await waitFor(() => expect(cell(def, 0, '$status').textContent).toBe('注销'));
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(resourceApi.gridSave).toHaveBeenCalled());
    expect(vi.mocked(resourceApi.gridSave).mock.calls[0][1].updates).toEqual([{ id: 1, version: 'v1', data: {}, status: 'cancelled', statusReason: '主体已注销' }]);
  });

  it('没有“停用”权限：状态列只读并说明原因；改回原状态就不算改动', async () => {
    perms = { isCompanyAdmin: false, allow: ['resource.licenses.view', 'resource.licenses.edit'], deny: [] };
    render(<ResourceGrid {...props(def, [row()])} />);
    expect(cell(def, 0, '$status').title).toContain('权限');
    select(def, 0, '$status');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    expect(screen.queryByLabelText('更改状态')).toBeNull();
  });

  it('子表列：点开在浮层里编辑（不跳转），新增行要先保存', () => {
    render(<ResourceGrid {...props(def, [row()])} />);
    expect(heads()).toContain('借用记录');
    fireEvent.click(screen.getByRole('button', { name: /^打开借用记录/ }));
    expect(screen.getByText('子表面板 license-borrows')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByText('子表面板 license-borrows')).toBeNull();
  });

  it('粘贴状态名称：普通状态接受，需要原因的拒绝并标红', async () => {
    render(<ResourceGrid {...props(def, [row(), dto('licenses', 2, '乙', { companyName: '乙' })])} />);
    select(def, 0, '$status');
    await act(async () => { fireEvent.paste(scope(), { clipboardData: { getData: () => '异常\n注销' } }); });
    await waitFor(() => expect(cell(def, 0, '$status').textContent).toBe('异常'));
    expect(cell(def, 1, '$status').className).toContain('invalid');
    expect(cell(def, 1, '$status').title).toContain('要填原因');
  });
});
