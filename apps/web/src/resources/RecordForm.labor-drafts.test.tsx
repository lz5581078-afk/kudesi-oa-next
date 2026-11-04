import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { RecordForm, clearRefCache } from './RecordForm';
import { draftApi, resourceApi, type ResourceDto } from './api';
import { resetUnitOptionsForTest } from './unitOptions';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, companyId: 1, permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('../api/client', async original => ({ ...(await original<typeof import('../api/client')>()), api: vi.fn().mockResolvedValue({ code: 'SYNTHETIC-PREVIEW' }) }));
vi.mock('./api', async original => {
  const module = await original<typeof import('./api')>();
  return { ...module, resourceApi: { ...module.resourceApi, list: vi.fn(), get: vi.fn(), create: vi.fn() }, draftApi: { ...module.draftApi, get: vi.fn(), save: vi.fn(), remove: vi.fn() } };
});
const version = getResourceDef('finance-labor-versions')!, project = getResourceDef('finance-labor-costs')!;
const values = { versionId: 10, archiveCategoryId: 21, workTypeId: 3, unitId: 4, workName: '合成工作', unitPrice: 100 };
const dto: ResourceDto = { id: 81, type: project.key, title: '合成项目', data: values, status: 'active', statusReason: null, refLabels: {}, files: {}, secretConfigured: {}, createdAt: '', updatedAt: '' };
beforeEach(() => {
  vi.clearAllMocks(); resetUnitOptionsForTest({}); clearRefCache();
  vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
  vi.mocked(resourceApi.get).mockImplementation(async (type, id) => ({ ...dto, type, id, title: type === 'finance-labor-categories' ? `归档${id}` : type === 'finance-labor-units' ? '件' : '包装' }));
  vi.mocked(resourceApi.create).mockResolvedValue(dto);
  vi.mocked(draftApi.get).mockResolvedValue({ draft: null }); vi.mocked(draftApi.save).mockResolvedValue({}); vi.mocked(draftApi.remove).mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('人工成本的手动草稿', () => {
  it('版本编号输入按原版转大写，日期和名称保存仍走通用资料接口', async () => {
    render(<RecordForm record={null} def={version} onClose={vi.fn()} onSaved={vi.fn()}/>);
    const code = screen.getByRole('textbox', { name: '版本编号' });
    fireEvent.change(code, { target: { value: 'rl-mixed-01' } });
    expect(code).toHaveProperty('value', 'RL-MIXED-01');
    fireEvent.change(screen.getByRole('textbox', { name: '版本名称' }), { target: { value: '合成大写版本' } });
    fireEvent.click(screen.getByRole('button', { name: '保存版本' }));
    await waitFor(() => expect(resourceApi.create).toHaveBeenCalledWith(version.key, expect.objectContaining({ versionCode: 'RL-MIXED-01', versionName: '合成大写版本' }), 'draft'));
  });
  it('版本不再自动保存，固定草稿且隐藏默认/启用字段；手动存草稿成功后关闭并保留旧键', async () => {
    vi.useFakeTimers(); const close = vi.fn();
    render(<RecordForm record={null} def={version} initial={{ versionCode: 'RL-TEST' }} onClose={close} onSaved={vi.fn()}/>);
    fireEvent.change(screen.getByRole('textbox', { name: /版本名称/ }), { target: { value: '合成版本草稿' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(draftApi.save).not.toHaveBeenCalled(); expect(screen.queryByText('初始状态')).toBeNull(); expect(screen.queryByRole('checkbox', { name: /默认版本/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' })); await act(async () => {});
    expect(draftApi.save).toHaveBeenCalledWith(draftApi.key(`resource:${version.key}`, ['', '']), expect.objectContaining({ moduleKey: `resource:${version.key}`, payload: expect.objectContaining({ versionName: '合成版本草稿' }) }));
    expect(close).toHaveBeenCalledTimes(1); expect(resourceApi.create).not.toHaveBeenCalled();
  });

  it('项目按版本恢复草稿、状态和零值确认；外侧版本不能被草稿改写，显示和提交均保留草稿原分类', async () => {
    const confirmation = { reason: '合成优惠', context: JSON.stringify(['草稿工作', '件', '包装']) };
    vi.mocked(draftApi.get).mockImplementation(async key => ({ draft: key === draftApi.key(`resource:${project.key}`, ['10']) ? { payload: { ...values, versionId: 999, archiveCategoryId: 23, workName: '草稿工作', unitPrice: 0, zeroReason: '合成优惠', zeroCostConfirmation: confirmation, workCode: 'DO-NOT-RESTORE', __draftStatus: 'inactive' }, title: '合成草稿', updatedAt: '' } : null }));
    const close = vi.fn(); const view = render(<RecordForm record={null} def={project} initial={{ versionId: 10, archiveCategoryId: 21 }} lockedFields={['versionId', 'archiveCategoryId']} onClose={close} onSaved={vi.fn()}/>);
    await screen.findByDisplayValue('草稿工作');
    expect(screen.getByRole('switch', { name: '状态' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('combobox', { name: '项目归档分类' })).toBeNull();
    await screen.findByText('归档分类：归档23');
    expect(screen.queryByDisplayValue('DO-NOT-RESTORE')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(draftApi.save).toHaveBeenCalledWith(draftApi.key(`resource:${project.key}`, ['10']), expect.objectContaining({ payload: expect.objectContaining({ versionId: 10, archiveCategoryId: 23, __draftStatus: 'inactive', zeroCostConfirmation: confirmation }) }));
    view.unmount(); render(<RecordForm record={null} def={project} initial={{ versionId: 20, archiveCategoryId: 31 }} lockedFields={['versionId', 'archiveCategoryId']} onClose={vi.fn()} onSaved={vi.fn()}/>);
    await waitFor(() => expect(draftApi.get).toHaveBeenLastCalledWith(draftApi.key(`resource:${project.key}`, ['20'])));
    expect(screen.queryByDisplayValue('草稿工作')).toBeNull();
  });

  it('迟到的草稿保留本次正在输入的字段，继续恢复未改字段', async () => {
    let finish!: (value: Awaited<ReturnType<typeof draftApi.get>>) => void;
    vi.mocked(draftApi.get).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<RecordForm record={null} def={project} initial={{ versionId: 10, archiveCategoryId: 21 }} lockedFields={['versionId', 'archiveCategoryId']} onClose={vi.fn()} onSaved={vi.fn()}/>);
    fireEvent.change(screen.getByRole('textbox', { name: /工作名称/ }), { target: { value: '本次正在填写' } });
    fireEvent.click(screen.getByRole('switch', { name: '状态' }));
    await act(async () => { finish({ draft: { payload: { ...values, versionId: 999, workName: '迟到旧名称', __draftStatus: 'active' }, title: '旧草稿', updatedAt: '' } }); });
    expect(screen.getByRole('textbox', { name: /工作名称/ })).toHaveProperty('value', '本次正在填写');
    expect(screen.getByRole('combobox', { name: '计价单位' })).toHaveProperty('value', '4');
    expect(screen.getByRole('switch', { name: '状态' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(draftApi.save).toHaveBeenCalled());
    expect(vi.mocked(draftApi.save).mock.calls[0][1].payload).toMatchObject({ versionId: 10, workName: '本次正在填写', unitId: 4 });
  });

  it('复制新增不读旧草稿，仍可存带来源的草稿且不带原零值确认', async () => {
    render(<RecordForm record={null} def={project} initial={{ ...values, __copyOf: 91, unitPrice: 0, zeroReason: '原零价事实' }} lockedFields={['versionId', 'archiveCategoryId']} onClose={vi.fn()} onSaved={vi.fn()}/>);
    expect(draftApi.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(draftApi.save).toHaveBeenCalled());
    const body = vi.mocked(draftApi.save).mock.calls[0][1];
    expect(body.sourceRecordId).toBe('91'); expect(body.payload).toMatchObject({ workName: values.workName, __draftStatus: 'active', unitPrice: 0 }); expect(body.payload).not.toHaveProperty('zeroCostConfirmation');
  });

  it('正式保存失败保留草稿，成功后才清当前版本草稿；失败也不关闭', async () => {
    vi.mocked(resourceApi.create).mockRejectedValueOnce(new Error('合成失败')).mockResolvedValueOnce(dto);
    const saved = vi.fn(), close = vi.fn();
    render(<RecordForm record={null} def={project} initial={values} lockedFields={['versionId', 'archiveCategoryId']} onClose={close} onSaved={saved}/>);
    fireEvent.click(screen.getByRole('button', { name: '保存项目' })); await screen.findByText('保存失败，请重试');
    expect(draftApi.remove).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存项目' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(dto));
    expect(draftApi.remove).toHaveBeenCalledWith(draftApi.key(`resource:${project.key}`, ['10']));
  });

  it('手动存草稿失败不关闭或清内容，重试成功后关闭；旧版本草稿不能带回隐藏的默认设置', async () => {
    vi.mocked(draftApi.get).mockResolvedValueOnce({ draft: { payload: { versionCode: 'RL-OLD', versionName: '合成旧草稿', isDefault: true, activatedAt: '不应恢复' }, title: '旧版本', updatedAt: '' } });
    vi.mocked(draftApi.save).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    const close = vi.fn(); render(<RecordForm record={null} def={version} onClose={close} onSaved={vi.fn()}/>);
    await screen.findByDisplayValue('合成旧草稿');
    expect(screen.queryByText('不应恢复')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' })); await screen.findByText('草稿保存失败');
    expect(close).not.toHaveBeenCalled(); expect(screen.getByDisplayValue('合成旧草稿')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' })); await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(draftApi.save).mock.calls[1][1].payload;
    expect(payload).not.toHaveProperty('isDefault'); expect(payload).not.toHaveProperty('activatedAt');
  });

  it('离开旧版本表单后，迟到的存草稿结果不关闭新上下文表单', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(draftApi.save).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const oldClose = vi.fn(), newClose = vi.fn();
    const old = render(<RecordForm record={null} def={project} initial={values} lockedFields={['versionId', 'archiveCategoryId']} onClose={oldClose} onSaved={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(draftApi.save).toHaveBeenCalledTimes(1));
    old.unmount();
    render(<RecordForm record={null} def={project} initial={{ ...values, versionId: 20, workName: '新上下文保留' }} lockedFields={['versionId', 'archiveCategoryId']} onClose={newClose} onSaved={vi.fn()}/>);
    await act(async () => { finish({}); });
    expect(oldClose).not.toHaveBeenCalled(); expect(newClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('新上下文保留')).toBeTruthy();
  });
});
