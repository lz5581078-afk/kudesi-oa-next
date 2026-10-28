import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import type { ResourceDto } from '../api';
import { resourceApi } from '../api';

let perms = { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] };
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: perms } }) }));
vi.mock('../api', async (orig) => {
  const mod = await orig<typeof import('../api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, gridSave: vi.fn(), get: vi.fn(), list: vi.fn().mockResolvedValue({ items: [{ id: 5, title: '店铺五' }, { id: 6, title: '店铺六' }], total: 2 }), users: vi.fn().mockResolvedValue([]), departments: vi.fn().mockResolvedValue([]) } };
});
import { ResourceGrid } from './ResourceGrid';
import { clearRefChoices } from './refResolve';

const def = getResourceDef('software')!;
const SHOWN = ['name', 'account', 'renewAt', 'annualFee', 'storeId', 'password'];
const dto = (id: number, data: Record<string, unknown>): ResourceDto => ({ id, type: 'software', title: String(data.name), status: 'normal', statusReason: null, data, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '', version: `v${id}` });
const items = [dto(1, { name: 'A', account: 'a' }), dto(2, { name: 'B', account: 'b' }), dto(3, { name: 'C', account: 'c' })];
/** 列的位置按表头文字现查：显示哪些列由表格自己的列选择决定 */
const colIdx = (k: string) => Array.from(document.querySelectorAll('thead th')).findIndex((th) => th.querySelector('button,span')?.textContent === def.fields.find((f) => f.key === k)!.label) - 1;

const props = () => ({ def, items, derived: [], sort: null, onSort: vi.fn(), onDirtyChange: vi.fn(), onOpen: vi.fn(), onSaved: vi.fn(), onExit: vi.fn() });
const cell = (r: number, k: string) => document.querySelector(`td[data-r="${r}"][data-c="${colIdx(k)}"]`) as HTMLElement;
const scope = () => screen.getByRole('application');
const select = (r: number, k: string) => { fireEvent.mouseDown(cell(r, k)); fireEvent.mouseUp(window); };
const typeInto = async (r: number, k: string, text: string) => {
  select(r, k);
  fireEvent.keyDown(scope(), { key: 'Enter' });
  const input = screen.getByLabelText(/^编辑/) as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
};
const pasteText = async (text: string) => { await act(async () => { fireEvent.paste(scope(), { clipboardData: { getData: () => text } }); }); };
const confirmMock = vi.fn((_msg?: string) => true);
const realConfirm = window.confirm;

beforeEach(() => { localStorage.setItem('kudesi.grid.cols.software', JSON.stringify(SHOWN)); window.confirm = confirmMock as never; confirmMock.mockReturnValue(true); perms = { isCompanyAdmin: true, allow: [], deny: [] }; clearRefChoices(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); window.confirm = realConfirm; });

describe('资料表格编辑网格', () => {
  it('回车编辑、回车提交并下移；改过的格子高亮，顶部显示“x 处修改”', async () => {
    render(<ResourceGrid {...props()} />);
    expect(screen.getByText('没有修改')).toBeTruthy();
    await typeInto(0, 'account', 'zz');
    expect(await screen.findByText('1 处修改')).toBeTruthy();
    expect(cell(0, 'account').className).toContain('changed');
    expect(cell(0, 'account').textContent).toBe('zz');
    expect(cell(1, 'account').className).toContain('active'); // 提交后焦点下移
  });

  it('直接键入字符替换内容；Esc 取消不留改动', async () => {
    render(<ResourceGrid {...props()} />);
    select(0, 'name');
    fireEvent.keyDown(scope(), { key: 'q' });
    const input = screen.getByLabelText('编辑软件名称') as HTMLInputElement;
    expect(input.value).toBe('q');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('编辑软件名称')).toBeNull();
    expect(screen.getByText('没有修改')).toBeTruthy();
  });

  it('金额按元输入，保存时是整数分；日期写法统一；格式不对标红并拦住保存', async () => {
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'update', id: 1, ok: true, row: dto(1, { name: 'A', account: 'a', annualFee: 1250 }) }] });
    const p = props();
    render(<ResourceGrid {...p} />);
    await typeInto(0, 'annualFee', '12.5');
    await typeInto(1, 'renewAt', '2030/3/5');
    expect(cell(1, 'renewAt').textContent).toBe('2030-03-05');
    await typeInto(2, 'renewAt', '随便');
    expect(cell(2, 'renewAt').className).toContain('invalid');
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    expect(await screen.findByText(/格式不对/, { selector: '.grid-msg span' })).toBeTruthy();
    expect(resourceApi.gridSave).not.toHaveBeenCalled();
    await typeInto(2, 'renewAt', '2031-01-01');
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(resourceApi.gridSave).toHaveBeenCalled());
    const body = vi.mocked(resourceApi.gridSave).mock.calls[0][1];
    expect(body.updates).toEqual([
      { id: 1, version: 'v1', data: { annualFee: 1250 } },
      { id: 2, version: 'v2', data: { renewAt: '2030-03-05' } },
      { id: 3, version: 'v3', data: { renewAt: '2031-01-01' } },
    ]);
  });

  it('粘贴 Excel 多行多列；超出现有行数先询问，同意才新增行', async () => {
    const confirm = confirmMock;
    render(<ResourceGrid {...props()} />);
    select(2, 'renewAt');
    await pasteText('2030-01-02\t12\n2031/2/3\t13.5\n');
    await waitFor(() => expect(cell(3, 'renewAt')?.textContent).toBe('2031-02-03'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('超出现有行数 1 行');
    expect(cell(2, 'renewAt').textContent).toBe('2030-01-02');
    expect(cell(2, 'annualFee').textContent).toContain('12');
    expect(cell(3, 'renewAt').closest('tr')!.className).toContain('new');
    expect(await screen.findByText('3 处修改')).toBeTruthy(); // 现有行改了 2 格 + 新增 1 行
  });

  it('粘贴超出行数时选“取消”：只粘贴到现有的行', async () => {
    confirmMock.mockReturnValue(false);
    render(<ResourceGrid {...props()} />);
    select(2, 'name');
    await pasteText('甲\n乙');
    await waitFor(() => expect(cell(2, 'name').textContent).toBe('甲'));
    expect(document.querySelector('tr.new')).toBeNull();
  });

  it('单个值粘贴到选区：整块都填这个值；粘贴不能改的列被跳过', async () => {
    render(<ResourceGrid {...props()} />);
    fireEvent.mouseDown(cell(0, 'account'));
    fireEvent.mouseOver(cell(2, 'account'));
    fireEvent.mouseUp(window);
    await pasteText('同一个');
    await waitFor(() => expect(cell(2, 'account').textContent).toBe('同一个'));
    expect(cell(0, 'account').textContent).toBe('同一个');
  });

  it('Delete 清空选区；Ctrl+D 向下填充；Ctrl+Z 撤销、Ctrl+Y 重做', async () => {
    render(<ResourceGrid {...props()} />);
    select(0, 'account');
    fireEvent.keyDown(scope(), { key: 'Delete' });
    await waitFor(() => expect(cell(0, 'account').textContent).toBe(''));
    fireEvent.keyDown(scope(), { key: 'z', ctrlKey: true });
    await waitFor(() => expect(cell(0, 'account').textContent).toBe('a'));
    fireEvent.keyDown(scope(), { key: 'y', ctrlKey: true });
    await waitFor(() => expect(cell(0, 'account').textContent).toBe(''));
    fireEvent.keyDown(scope(), { key: 'z', ctrlKey: true });
    fireEvent.mouseDown(cell(0, 'name'));
    fireEvent.mouseOver(cell(2, 'name'));
    fireEvent.mouseUp(window);
    fireEvent.keyDown(scope(), { key: 'd', ctrlKey: true });
    await waitFor(() => expect(cell(2, 'name').textContent).toBe('A'));
    expect(screen.getByText('2 处修改')).toBeTruthy();
  });

  it('拖拽小方块向下填充', async () => {
    render(<ResourceGrid {...props()} />);
    select(0, 'name');
    const handle = cell(0, 'name').querySelector('.fill-handle') as HTMLElement;
    fireEvent.mouseDown(handle);
    fireEvent.mouseOver(cell(2, 'name'));
    fireEvent.mouseUp(window);
    await waitFor(() => expect(cell(2, 'name').textContent).toBe('A'));
    expect(cell(1, 'name').textContent).toBe('A');
  });

  it('复制：选区按 TSV 放进剪贴板', () => {
    render(<ResourceGrid {...props()} />);
    fireEvent.mouseDown(cell(0, 'name'));
    fireEvent.mouseOver(cell(1, 'account'));
    fireEvent.mouseUp(window);
    const setData = vi.fn();
    fireEvent.copy(scope(), { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', 'A\t\ta\nB\t\tb');
  });

  it('底部空行直接输入=新增；保存失败的行留在表格里标红并写明原因，成功的行落定', async () => {
    vi.mocked(resourceApi.gridSave).mockResolvedValue({
      saved: 1, failed: 2,
      results: [
        { kind: 'update', id: 1, ok: true, row: dto(1, { name: 'A', account: 'new' }) },
        { kind: 'update', id: 2, ok: false, code: 'conflict', message: '这条资料刚被别人修改过，请刷新后再改' },
        { kind: 'create', clientId: 'new-1', ok: false, code: 'invalid', message: '账号不能为空' },
      ],
    });
    const p = props();
    render(<ResourceGrid {...p} />);
    await typeInto(0, 'account', 'new');
    await typeInto(1, 'account', 'bbb');
    await typeInto(3, 'name', '新增的软件');
    expect(document.querySelectorAll('tr.new')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    expect(await screen.findByText('这条资料刚被别人修改过，请刷新后再改')).toBeTruthy();
    expect(screen.getByText('账号不能为空')).toBeTruthy();
    expect(cell(1, 'account').closest('tr')!.className).toContain('failed');
    expect(cell(1, 'account').textContent).toBe('bbb'); // 改动还在，可以修改后重试
    expect(cell(0, 'account').className).not.toContain('changed');
    expect(p.onSaved).toHaveBeenCalledWith(false);
    const body = vi.mocked(resourceApi.gridSave).mock.calls[0][1];
    expect(body.creates).toEqual([{ clientId: 'new-1', data: { name: '新增的软件' } }]);
    // 冲突行：放弃我的修改，载入最新
    vi.mocked(resourceApi.get).mockResolvedValue(dto(2, { name: 'B', account: '别人改的' }));
    fireEvent.click(screen.getByRole('button', { name: '放弃我的修改，载入最新' }));
    await waitFor(() => expect(cell(1, 'account').textContent).toBe('别人改的'));
  });

  it('全部成功：通知上层刷新；放弃会还原；有未保存改动时通知上层锁定', async () => {
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'update', id: 1, ok: true, row: dto(1, { name: 'A', account: 'x' }) }] });
    const p = props();
    render(<ResourceGrid {...p} />);
    await typeInto(0, 'account', 'x');
    await waitFor(() => expect(p.onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    await waitFor(() => expect(cell(0, 'account').textContent).toBe('a'));
    await typeInto(0, 'account', 'x');
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(p.onSaved).toHaveBeenCalledWith(true));
    expect(screen.getByText(/已保存 1 行/)).toBeTruthy();
  });

  it('待删除=标记，保存时按归档，必须填原因；新增行直接去掉', async () => {
    vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'archive', id: 2, ok: true }] });
    render(<ResourceGrid {...props()} />);
    fireEvent.mouseDown(screen.getByText('2').closest('th')!);
    fireEvent.click(screen.getByRole('button', { name: '删除/归档所选行' }));
    expect(cell(1, 'name').closest('tr')!.className).toContain('deleted');
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    expect(await screen.findByText(/填写归档原因/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/必须填写原因/), { target: { value: '不用了' } });
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(resourceApi.gridSave).toHaveBeenCalled());
    expect(vi.mocked(resourceApi.gridSave).mock.calls[0][1].archives).toEqual([{ id: 2, version: 'v2', reason: '不用了' }]);
  });

  it('没有“查看明文”权限：密码列不出现在列里（也不在列选择器里）；其他列照常可改', () => {
    perms = { isCompanyAdmin: false, allow: ['resource.software.view', 'resource.software.edit', 'resource.software.create'], deny: [] };
    render(<ResourceGrid {...props()} />);
    expect(colIdx('password')).toBe(-2);
    fireEvent.click(screen.getByRole('button', { name: /^列（/ }));
    expect(screen.queryByLabelText('密码')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    select(0, 'name');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    expect(screen.getByLabelText('编辑软件名称')).toBeTruthy();
  });

  it('密码列：有权限才能写新值，显示为圆点不回显', async () => {
    render(<ResourceGrid {...props()} />);
    select(0, 'password');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    const input = screen.getByLabelText('编辑密码') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'S3cret' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(cell(0, 'password').textContent).toBe('••••••'));
    expect(document.body.textContent).not.toContain('S3cret');
  });

  it('没有新增权限：底部没有空行，粘贴不新增', async () => {
    perms = { isCompanyAdmin: false, allow: ['resource.software.view', 'resource.software.edit'], deny: [] };
    render(<ResourceGrid {...props()} />);
    expect(document.querySelector('tr.ghost')).toBeNull();
    select(2, 'name');
    await pasteText('甲\n乙');
    await waitFor(() => expect(cell(2, 'name').textContent).toBe('甲'));
    expect(document.querySelector('tr.new')).toBeNull();
  });

  it('引用单元格：搜索选择，保存的是记录 id；粘贴名称按完全匹配解析，找不到标红', async () => {
    render(<ResourceGrid {...props()} />);
    select(0, 'storeId');
    fireEvent.keyDown(scope(), { key: 'Enter' });
    const opt = await screen.findByRole('button', { name: '店铺六' });
    fireEvent.click(opt);
    await waitFor(() => expect(cell(0, 'storeId').textContent).toBe('店铺六'));
    select(1, 'storeId');
    await pasteText('店铺五');
    await waitFor(() => expect(cell(1, 'storeId').textContent).toBe('店铺五'));
    select(2, 'storeId');
    await pasteText('不存在的店');
    await waitFor(() => expect(cell(2, 'storeId').className).toContain('invalid'));
    expect(within(cell(2, 'storeId')).getByText('不存在的店')).toBeTruthy();
  });
});
