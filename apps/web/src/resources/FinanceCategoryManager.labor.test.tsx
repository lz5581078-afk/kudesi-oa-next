import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { FinanceCategoryManager } from './FinanceCategoryManager';
import { resourceApi, type ResourceDto } from './api';

const auth = vi.hoisted(() => ({ companyId: 1, id: 1, permissions: { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] } }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: auth }) }));
vi.mock('./api', () => ({ resourceApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), reorderCategories: vi.fn(), saveArchivePrefix: vi.fn() } }));
const target = 'finance-labor-categories';
const node = (id: number, title: string, parentId = 0, versionId = 10, referenceCount = 0): ResourceDto => ({ id, type: target, title, data: { name: title, code: `C${id}`, parentId, versionId, sortOrder: id * 10, referenceCount }, status: 'active', statusReason: null, refLabels: {}, files: {}, secretConfigured: {}, createdAt: '', updatedAt: '' });
let rows: ResourceDto[];
const result = (items: ResourceDto[], total = items.length) => ({ items, total, page: 1, pageSize: 200 });
const context = (value = 10) => ({ field: 'versionId', value, label: '当前版本标识', text: `RL-${value}` });
const presentation = { kicker: '人力成本表 · 归档设置', description: '合成当前版本目录', unit: '个工作项目', footer: '草稿版本可维护全部归档分类。' };
const changed = vi.fn(), close = vi.fn();
const manager = (versionId = 10) => <FinanceCategoryManager target={target} context={context(versionId)} presentation={presentation} guardDeleteReferences={false} confirmation="message" onChanged={changed} onClose={close}/>;
beforeEach(() => {
  vi.resetAllMocks(); auth.companyId = 1; auth.permissions = { isCompanyAdmin: true, allow: [], deny: [] };
  rows = [node(1, '合成根甲'), node(2, '合成二级', 1), node(3, '合成末级', 2, 10, 1)];
  vi.mocked(resourceApi.list).mockImplementation(async (_type, query) => { const scoped = rows.filter(row => row.data.versionId === query.fieldValue); const page = query.page ?? 1; return result(scoped.slice((page - 1) * 200, page * 200), scoped.length); });
  vi.mocked(resourceApi.create).mockImplementation(async (_type, data) => { const saved = { ...node(4, String(data.name), Number(data.parentId) || 0, Number(data.versionId)), data: { ...data, referenceCount: 0 } }; rows.push(saved); return saved; });
  vi.mocked(resourceApi.update).mockImplementation(async (_type, id, data) => { const saved = { ...rows.find(row => row.id === id)!, title: String(data.name), data: { ...rows.find(row => row.id === id)!.data, ...data } }; rows = rows.map(row => row.id === id ? saved : row); return saved; });
  vi.mocked(resourceApi.reorderCategories).mockImplementation(async (_type, ids) => { rows = rows.map(row => ids.includes(row.id) ? { ...row, data: { ...row.data, sortOrder: (ids.indexOf(row.id) + 1) * 10 } } : row); return { ok: true, changed: ids.length }; });
});
afterEach(cleanup);

it('按版本完整读取501项并提交整份同级拖动顺序，版本标识只能查看', async () => {
  rows = Array.from({ length: 501 }, (_, index) => node(index + 1, `合成分类${index + 1}`));
  render(manager());
  // 大目录使用明确的无障碍标签查询，避免对每个按钮重复计算可见性和名称。
  await screen.findByLabelText('编辑合成分类501');
  expect(resourceApi.list).toHaveBeenCalledWith(target, expect.objectContaining({ fieldKey: 'versionId', fieldValue: 10, page: 3, pageSize: 200 }));
  expect(screen.getByLabelText('当前版本标识')).toHaveProperty('readOnly', true);
  expect(screen.getByLabelText('当前版本标识')).toHaveProperty('value', 'RL-10');
  const first = screen.getByLabelText('编辑合成分类1').closest('.fcm-row')!;
  const last = screen.getByLabelText('编辑合成分类501').closest('.fcm-row')!;
  fireEvent.dragStart(last); fireEvent.drop(first);
  await waitFor(() => expect(resourceApi.reorderCategories).toHaveBeenCalledWith(target, [501, ...Array.from({ length: 500 }, (_, index) => index + 1)]));
}, 15000); // 全套并行测试下渲染501个完整交互行，为该压力用例单独留足时间。

it('三级新增固定所属版本和父级，编号输入大写；编辑没有换版本或换层级控件', async () => {
  render(manager()); await screen.findByRole('button', { name: '编辑合成根甲' });
  fireEvent.click(screen.getByRole('button', { name: /^合成根甲 / }));
  fireEvent.click(screen.getByRole('button', { name: /^合成二级 / }));
  fireEvent.click(within(screen.getByRole('region', { name: '三级分类' })).getByRole('button', { name: '新增' }));
  const editor = screen.getByRole('dialog', { name: '新增三级分类' });
  expect(within(editor).getByText('用于归档目录识别')).toBeTruthy();
  fireEvent.change(within(editor).getByRole('textbox', { name: /分类名称/ }), { target: { value: '合成新末级' } });
  fireEvent.change(within(editor).getByRole('textbox', { name: /分类标识/ }), { target: { value: 'new-code' } });
  fireEvent.click(within(editor).getByRole('button', { name: '确认创建' }));
  await waitFor(() => expect(resourceApi.create).toHaveBeenCalledWith(target, expect.objectContaining({ versionId: 10, parentId: 2, name: '合成新末级', code: 'NEW-CODE', sortOrder: 0 })));
  await screen.findByRole('button', { name: '编辑合成新末级' });
  fireEvent.click(screen.getByRole('button', { name: '编辑合成新末级' }));
  const edit = screen.getByRole('dialog', { name: '编辑分类' });
  expect(within(edit).queryByRole('combobox')).toBeNull();
  fireEvent.change(within(edit).getByRole('textbox', { name: /分类名称/ }), { target: { value: '合成改名末级' } });
  fireEvent.click(within(edit).getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(resourceApi.update).toHaveBeenCalledWith(target, 4, { name: '合成改名末级', code: 'NEW-CODE' }));
});

it('创建成功后刷新失败仍显示服务器已保存的资料，不让成功记录消失', async () => {
  let saved = false;
  const list = vi.mocked(resourceApi.list).getMockImplementation()!;
  vi.mocked(resourceApi.list).mockImplementation(async (...args) => { if (saved) throw new Error('合成分类刷新失败'); return list(...args); });
  const create = vi.mocked(resourceApi.create).getMockImplementation()!;
  vi.mocked(resourceApi.create).mockImplementation(async (...args) => { const row = await create(...args); saved = true; return row; });
  render(manager()); await screen.findByRole('button', { name: '编辑合成根甲' });
  fireEvent.click(within(screen.getByRole('region', { name: '一级分类' })).getByRole('button', { name: '新增' }));
  fireEvent.change(screen.getByRole('textbox', { name: /分类名称/ }), { target: { value: '合成已保存分类' } });
  fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '合成分类刷新失败');
  expect(screen.getByRole('button', { name: '编辑合成已保存分类' })).toBeTruthy();
  expect(changed).toHaveBeenCalledTimes(1); expect(resourceApi.create).toHaveBeenCalledTimes(1);
});

it('切版本/公司后迟到的目录不会显示，也不会继续读取旧分页', async () => {
  let finish!: (value: ReturnType<typeof result>) => void;
  vi.mocked(resourceApi.list).mockImplementation(async (_type, query) => query.fieldValue === 10 ? new Promise(resolve => { finish = resolve; }) : result([node(900, '乙公司目录', 0, 20)]));
  const view = render(manager()); await waitFor(() => expect(finish).toBeTruthy());
  auth.companyId = 2; view.rerender(manager(20)); await screen.findByRole('button', { name: '编辑乙公司目录' });
  await act(async () => finish(result(Array.from({ length: 200 }, (_, index) => node(index + 1, `旧目录${index}`)), 201)));
  expect(screen.queryByRole('button', { name: '编辑旧目录0' })).toBeNull();
  expect(resourceApi.list).not.toHaveBeenCalledWith(target, expect.objectContaining({ fieldValue: 10, page: 2 }));
});

it('旧公司创建回复不关闭新公司正在填写的编辑窗', async () => {
  let finish!: (row: ResourceDto) => void;
  vi.mocked(resourceApi.create).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(manager()); await screen.findByRole('button', { name: '编辑合成根甲' });
  fireEvent.click(within(screen.getByRole('region', { name: '一级分类' })).getByRole('button', { name: '新增' }));
  fireEvent.change(screen.getByRole('textbox', { name: /分类名称/ }), { target: { value: '甲公司创建中' } });
  fireEvent.click(screen.getByRole('button', { name: '确认创建' })); await waitFor(() => expect(finish).toBeTruthy());
  rows = [node(900, '乙公司目录', 0, 20)]; auth.companyId = 2; view.rerender(manager(20));
  await screen.findByRole('button', { name: '编辑乙公司目录' });
  fireEvent.click(within(screen.getByRole('region', { name: '一级分类' })).getByRole('button', { name: '新增' }));
  fireEvent.change(screen.getByRole('textbox', { name: /分类名称/ }), { target: { value: '乙公司尚未保存' } });
  await act(async () => finish(node(99, '甲公司创建完成')));
  expect(screen.getByRole('textbox', { name: /分类名称/ })).toHaveProperty('value', '乙公司尚未保存');
  expect(changed).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: '编辑甲公司创建完成' })).toBeNull();
});

it('编辑内的删除走纯确认，引用失败和取消确认不丢失未保存字段', async () => {
  vi.mocked(resourceApi.remove).mockRejectedValue(new ApiError(409, '合成工作项目引用，不能删除'));
  render(manager()); await screen.findByRole('button', { name: '编辑合成根甲' });
  fireEvent.click(screen.getByRole('button', { name: /^合成根甲 / })); fireEvent.click(screen.getByRole('button', { name: /^合成二级 / }));
  fireEvent.click(screen.getByRole('button', { name: '编辑合成末级' }));
  fireEvent.change(screen.getByRole('textbox', { name: /分类名称/ }), { target: { value: '尚未保存的合成改名' } });
  fireEvent.click(screen.getByRole('button', { name: '删除分类' }));
  const confirm = screen.getByRole('dialog', { name: '请确认操作' }); expect(within(confirm).queryByRole('textbox')).toBeNull();
  fireEvent.click(within(confirm).getByRole('button', { name: '确认' })); await screen.findByText('合成工作项目引用，不能删除');
  fireEvent.click(within(confirm).getByRole('button', { name: '取消' }));
  expect(screen.getByRole('textbox', { name: /分类名称/ })).toHaveProperty('value', '尚未保存的合成改名');
  expect(resourceApi.update).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: '编辑合成末级' })).toBeTruthy();
});
