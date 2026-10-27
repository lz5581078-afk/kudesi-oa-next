import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS } from '@kudesi/shared';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const create = vi.fn();
const similar = vi.fn();
const draftGet = vi.fn();
const draftSave = vi.fn();
const draftRemove = vi.fn();
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return {
    ...mod,
    resourceApi: { ...mod.resourceApi, create: (...a: unknown[]) => create(...a), similarCheck: (...a: unknown[]) => similar(...a), list: vi.fn().mockResolvedValue({ items: [], total: 0 }) },
    draftApi: { ...mod.draftApi, get: (...a: unknown[]) => draftGet(...a), save: (...a: unknown[]) => draftSave(...a), remove: (...a: unknown[]) => draftRemove(...a) },
  };
});
import { RecordForm } from './RecordForm';

const def = FINANCE_RESOURCE_DEFS.find((d) => d.key === 'finance-products')!;
const saved = { id: 9, type: 'finance-products', title: '苹果', status: 'active', statusReason: null, data: {}, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' };
/** 必填的分类、规格数量、规格单位（客户端会先拦住没填的必填项） */
const REQ = { archiveType: 'raw', categoryId: 1, specQty: 1, specUnit: 'kg' };
const fill = (label: string, value: string) => fireEvent.change(screen.getAllByLabelText(new RegExp(`^${label}`))[0], { target: { value } });
/** 原料的必填核算资料都填上，核算资料确认没有未完成项 */
const fillRaw = (name: string) => { fill('商品名称', name); fill('系统规格', '千克'); fill('运费', '1'); fill('装卸费', '1'); };
const confirmQuality = async () => { fireEvent.click(await screen.findByRole('button', { name: '确认并保存' })); };

beforeEach(() => {
  create.mockReset().mockResolvedValue(saved);
  similar.mockReset().mockResolvedValue({ blocked: [], warnings: [] });
  draftGet.mockReset().mockResolvedValue({ draft: null });
  draftSave.mockReset().mockResolvedValue({});
  draftRemove.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe('商品档案新建：草稿、继续新建、零值确认', () => {
  it('存为草稿：把当前填的内容存到服务器并关闭；再打开自动恢复，可清除', async () => {
    const onClose = vi.fn();
    const { unmount } = render(<RecordForm def={def} record={null} initial={{ archiveType: 'raw' }} onClose={onClose} onSaved={() => undefined} onContinued={() => undefined} />);
    fill('商品名称', '半成品苹果');
    fireEvent.click(screen.getByRole('button', { name: '存为草稿' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(draftSave).toHaveBeenCalledTimes(1);
    expect(draftSave.mock.calls[0][0]).toBe('resource%3Afinance-products:raw:_');
    expect((draftSave.mock.calls[0][1] as { payload: Record<string, unknown> }).payload.name).toBe('半成品苹果');
    unmount();
    draftGet.mockResolvedValue({ draft: { payload: { name: '半成品苹果' }, title: '', updatedAt: '' } });
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'raw' }} onClose={() => undefined} onSaved={() => undefined} />);
    await screen.findByText(/已恢复上次保存的草稿/);
    expect((screen.getAllByLabelText(/^商品名称/)[0] as HTMLInputElement).value).toBe('半成品苹果');
    fireEvent.click(screen.getByRole('button', { name: '清除草稿' }));
    await waitFor(() => expect(draftRemove).toHaveBeenCalled());
    expect(screen.queryByText(/已恢复上次保存的草稿/)).toBeNull();
  });

  it('保存并继续新建：不关弹窗，只留档案类型，列表由 onContinued 刷新；成功后清掉草稿', async () => {
    const onSaved = vi.fn();
    const onContinued = vi.fn();
    render(<RecordForm def={def} record={null} initial={REQ} onClose={() => undefined} onSaved={onSaved} onContinued={onContinued} />);
    fillRaw('苹果');
    fireEvent.click(screen.getByRole('button', { name: '保存并继续新建' }));
    await confirmQuality();
    await screen.findByText(/可以继续新建/);
    expect(onContinued).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(draftRemove).toHaveBeenCalled();
    expect((screen.getAllByLabelText(/^商品名称/)[0] as HTMLInputElement).value).toBe('');
  });

  it('相似商品要确认才保存；选“取消”就不保存', async () => {
    similar.mockResolvedValue({ blocked: [], warnings: [{ text: '“苹果”：名称完全相同' }] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<RecordForm def={def} record={null} initial={REQ} onClose={() => undefined} onSaved={() => undefined} />);
    fillRaw('苹果');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(String(confirm.mock.calls[0][0])).toContain('名称完全相同');
    expect(create).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await confirmQuality();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    confirm.mockRestore();
  });

  it('运费、装卸费填 0 没写原因：先弹核算资料确认，原因写进零值说明再保存', async () => {
    const onSaved = vi.fn();
    render(<RecordForm def={def} record={null} initial={REQ} onClose={() => undefined} onSaved={onSaved} />);
    fill('商品名称', '苹果');
    fill('系统规格', '千克');
    fill('运费', '0');
    fill('装卸费', '1');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByRole('dialog', { name: '核算资料确认' });
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('运费零值原因'), { target: { value: '产地自提' } });
    fireEvent.click(screen.getByRole('button', { name: '确认该项为0' }));
    fireEvent.click(screen.getByRole('button', { name: '确认并保存' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect((create.mock.calls[0][1] as Record<string, unknown>).zeroValueReason).toContain('运费：产地自提');
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});

describe('新建关闭确认', () => {
  it('填了内容点“取消”先确认；没填直接关；确认取消则留在表单', () => {
    const onClose = vi.fn();
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'raw' }} onClose={onClose} onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1); // 没填内容，直接关
    expect(ask).not.toHaveBeenCalled();
    fill('商品名称', '苹果');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1); // 选了“取消”，没关
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    ask.mockRestore();
  });
});

describe('人力成本版本：自动存草稿', () => {
  it('填写后自动保存草稿，再打开自动恢复', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const laborDef = (await import('@kudesi/shared')).getResourceDef('finance-labor-versions')!;
    const first = render(<RecordForm def={laborDef} record={null} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(screen.getAllByLabelText(/^版本编号/)[0], { target: { value: 'V9' } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(draftSave).toHaveBeenCalledTimes(1);
    expect((draftSave.mock.calls[0][1] as { payload: Record<string, unknown> }).payload.versionCode).toBe('V9');
    first.unmount();
    draftGet.mockResolvedValue({ draft: { payload: { versionCode: 'V9' }, title: '', updatedAt: '' } });
    render(<RecordForm def={laborDef} record={null} onClose={() => undefined} onSaved={() => undefined} />);
    await screen.findByText(/已恢复上次保存的草稿/);
    vi.useRealTimers();
  });
});
