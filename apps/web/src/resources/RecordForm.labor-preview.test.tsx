import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS } from '@kudesi/shared';
import { RecordForm } from './RecordForm';
import { resourceApi, draftApi, type ResourceDto } from './api';
import { api } from '../api/client';
import { resetUnitOptionsForTest } from './unitOptions';
import { clearRefCache } from './ResourceReferenceControls';

const formAuth = vi.hoisted(() => ({ permissions: { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] } }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, companyId: 1, permissions: formAuth.permissions } }) }));
vi.mock('../api/client', async original => ({ ...(await original<typeof import('../api/client')>()), api: vi.fn() }));
vi.mock('./api', async original => {
  const module = await original<typeof import('./api')>();
  return { ...module, resourceApi: { ...module.resourceApi, list: vi.fn(), gridSave: vi.fn(), update: vi.fn(), create: vi.fn(), get: vi.fn() }, draftApi: { ...module.draftApi, get: vi.fn(), clear: vi.fn() } };
});

it('项目表单内新增工作分类后直接选中，内窗Enter和Escape不会保存或关闭父表单', async () => {
  const added: ResourceDto = { ...record, id: 92, type: 'finance-labor-work-types', title: '合成新分类', data: { name: '合成新分类', code: 'HCXFL', referenceCount: 0 } };
  let created = false;
  vi.mocked(resourceApi.create).mockImplementation(async () => { created = true; return added; });
  vi.mocked(resourceApi.list).mockImplementation(async type => { const items = created && type === added.type ? [added] : []; return { items, total: items.length, page: 1, pageSize: 200 }; });
  const close = vi.fn(), saved = vi.fn();
  render(<RecordForm def={def} record={record} lockedFields={['versionId', 'archiveCategoryId']} onClose={close} onSaved={saved}/>);
  fireEvent.click(screen.getByRole('button', { name: '管理分类' }));
  const input = screen.getByRole('textbox', { name: '分类名称' });
  fireEvent.change(input, { target: { value: '合成新分类' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '管理工作分类' })).toBeNull());
  await screen.findByRole('option', { name: '合成新分类（HCXFL）' });
  expect(screen.getByRole('combobox', { name: '工作分类' })).toHaveProperty('value', '92');
  expect(screen.getByRole('textbox', { name: /工作名称/ })).toHaveProperty('value', '合成装袋');
  expect(resourceApi.update).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '管理分类' }));
  fireEvent.keyDown(screen.getByRole('textbox', { name: '分类名称' }), { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: '管理工作分类' })).toBeNull(); expect(close).not.toHaveBeenCalled();
});
const def = FINANCE_RESOURCE_DEFS.find(resource => resource.key === 'finance-labor-costs')!;
const record: ResourceDto = { id: 81, type: def.key, title: '合成包装/装袋', status: 'active', statusReason: null, data: { label: '不应出现的标题', workCode: 'STORED-CODE', versionId: 1, archiveCategoryId: 2, workTypeId: 3, unitId: 4, workName: '合成装袋', unitPrice: 100 }, secretConfigured: {}, refLabels: { versionId: '合成版本', archiveCategoryId: '合成归档', workTypeId: '合成工作分类', unitId: '件' }, files: {}, createdAt: '', updatedAt: '' };
beforeEach(() => {
  vi.clearAllMocks(); formAuth.permissions = { isCompanyAdmin: true, allow: [], deny: [] }; resetUnitOptionsForTest({});
  vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
  vi.mocked(api).mockResolvedValue({ code: 'SERVER-PREVIEW' });
  vi.mocked(draftApi.get).mockResolvedValue({ draft: null });
  vi.mocked(resourceApi.update).mockResolvedValue(record);
  vi.mocked(resourceApi.get).mockImplementation(async (type, id) => ({ ...record, type, id, title: type === 'finance-labor-units' ? '件' : '合成工作分类' }));
});

it('实际零成本表单通过明确确认生成当前上下文，改名需重新确认；保存只提交确认原因和上下文', async () => {
  render(<RecordForm def={def} record={{ ...record, data: { ...record.data, unitPrice: 0, zeroReason: '旧原因' } }} lockedFields={['versionId', 'archiveCategoryId']} onClose={vi.fn()} onSaved={vi.fn()}/>);
  fireEvent.change(screen.getByRole('textbox', { name: '零人力成本原因' }), { target: { value: '合成优惠' } });
  const confirm = screen.getByRole('button', { name: '确认该项为0' });
  await waitFor(() => expect(confirm).toHaveProperty('disabled', false)); fireEvent.click(confirm);
  expect(screen.getByText('已确认：合成优惠')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: /工作名称/ }), { target: { value: '合成改名后' } });
  expect(screen.queryByText('已确认：合成优惠')).toBeNull();
  fireEvent.click(confirm); fireEvent.click(screen.getByRole('button', { name: '保存项目' }));
  await waitFor(() => expect(resourceApi.update).toHaveBeenCalled());
  expect(vi.mocked(resourceApi.update).mock.calls[0][2]).toMatchObject({ unitPrice: 0, zeroReason: '合成优惠', zeroCostConfirmation: { reason: '合成优惠', context: JSON.stringify(['合成改名后', '件', '合成工作分类']) } });
  expect(document.querySelector('[data-field="zeroCostConfirmation"]')).toBeNull();
});
afterEach(cleanup);

it('工作分类完整加载后获得初始焦点，维护刷新不夺走正在填写的名称焦点', async () => {
  render(<RecordForm def={def} record={record} lockedFields={['versionId', 'archiveCategoryId']} onClose={vi.fn()} onSaved={vi.fn()}/>);
  const select = screen.getByRole('combobox', { name: '工作分类' });
  await waitFor(() => expect(document.activeElement).toBe(select));
  const name = screen.getByRole('textbox', { name: /工作名称/ }); name.focus();
  act(() => clearRefCache('finance-labor-work-types'));
  await waitFor(() => expect(select).toHaveProperty('disabled', false));
  expect(document.activeElement).toBe(name);
});

it('等候工作分类时用户先填写其他字段，加载完成后保留当前焦点和输入', async () => {
  let finish!: (result: Awaited<ReturnType<typeof resourceApi.list>>) => void;
  vi.mocked(resourceApi.list).mockImplementation(async type => type === 'finance-labor-work-types' ? new Promise(resolve => { finish = resolve; }) : { items: [], total: 0, page: 1, pageSize: 200 });
  render(<RecordForm def={def} record={record} lockedFields={['versionId', 'archiveCategoryId']} onClose={vi.fn()} onSaved={vi.fn()}/>);
  const name = screen.getByRole('textbox', { name: /工作名称/ }); name.focus();
  fireEvent.change(name, { target: { value: '合成继续填写' } });
  await act(async () => finish({ items: [], total: 0, page: 1, pageSize: 200 }));
  expect(screen.getByRole('combobox', { name: '工作分类' })).toHaveProperty('disabled', false);
  expect(document.activeElement).toBe(name); expect(name).toHaveProperty('value', '合成继续填写');
});

it('项目分区固定外侧归属，状态和资料一起保存；失败不关闭，重试保留填写', async () => {
  const saved = vi.fn();
  vi.mocked(resourceApi.gridSave).mockResolvedValueOnce({ results: [{ kind: 'update', id: record.id, ok: false, message: '合成引用阻止停用' }], saved: 0, failed: 1 }).mockResolvedValueOnce({ results: [{ kind: 'update', id: record.id, ok: true, row: { ...record, status: 'inactive' } }], saved: 1, failed: 0 });
  render(<RecordForm def={def} record={record} lockedFields={['versionId', 'archiveCategoryId']} onClose={vi.fn()} onSaved={saved}/>);
  expect(screen.getByRole('dialog', { name: '编辑人力成本项目' })).toBeTruthy();
  for (const name of ['工作基础信息', '计价标准', '其他信息']) expect(screen.getByRole('region', { name })).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: '成本版本' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: '项目归档分类' })).toBeNull();
  expect(screen.queryByLabelText('表单分区')).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: /工作名称/ }), { target: { value: '合成原位改名' } });
  fireEvent.click(screen.getByRole('switch', { name: '状态' }));
  fireEvent.click(screen.getByRole('button', { name: '保存项目' }));
  expect(await screen.findByText('合成引用阻止停用')).toBeTruthy();
  expect(saved).not.toHaveBeenCalled(); expect(resourceApi.update).not.toHaveBeenCalled();
  expect(vi.mocked(resourceApi.gridSave).mock.calls[0][1]).toMatchObject({ updates: [{ id: record.id, data: { workName: '合成原位改名', versionId: 1, archiveCategoryId: 2 }, status: 'inactive', statusReason: '' }] });
  fireEvent.click(screen.getByRole('button', { name: '保存项目' }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
});

it('无停用权限不能改变已有项目的状态，取消按原版直接关闭且不引入原生确认', () => {
  formAuth.permissions = { isCompanyAdmin: false, allow: ['resource.finance-labor-costs.view', 'resource.finance-labor-costs.edit', 'product.cost.view', 'product.cost.edit'], deny: ['resource.finance-labor-costs.disable'] };
  const close = vi.fn(), confirm = vi.spyOn(window, 'confirm');
  render(<RecordForm def={def} record={record} onClose={close} onSaved={vi.fn()}/>);
  expect(screen.getByRole('switch', { name: '状态' })).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByRole('textbox', { name: /工作名称/ }), { target: { value: '尚未保存' } });
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(close).toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); confirm.mockRestore();
});

it('实际编辑窗只显示一处编号预览，隐藏派生标题；保存不把编号或标题回传', async () => {
  const saved = vi.fn();
  render(<RecordForm def={def} record={record} lockedFields={['versionId', 'archiveCategoryId']} onClose={vi.fn()} onSaved={saved}/>);
  expect(screen.queryByText('不应出现的标题')).toBeNull();
  expect(screen.queryByDisplayValue('STORED-CODE')).toBeNull();
  expect(await screen.findByText('SERVER-PREVIEW')).toBeTruthy();
  expect(screen.getAllByRole('status', { name: '工作编号' })).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox', { name: /工作名称/ }), { target: { value: '合成新名称' } });
  fireEvent.click(screen.getByRole('button', { name: '保存项目' }));
  await waitFor(() => expect(resourceApi.update).toHaveBeenCalled());
  const body = vi.mocked(resourceApi.update).mock.calls[0][2];
  expect(body).toMatchObject({ workName: '合成新名称', versionId: 1, archiveCategoryId: 2 });
  expect(body).not.toHaveProperty('workCode'); expect(body).not.toHaveProperty('label');
  expect(saved).toHaveBeenCalled();
});
