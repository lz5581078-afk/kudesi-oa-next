import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi, type ResourceDto } from './api';
import { ArchiveTypeDialog } from './ArchiveTypeDialog';
import { fieldOptions, resetUnitOptionsForTest } from './unitOptions';
import { getResourceDef } from '@kudesi/shared';

vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: vi.fn().mockResolvedValue({}) }));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), resourceApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), changeStatus: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const r = vi.mocked(resourceApi);
const dto = (id: number, status: string, data: Record<string, unknown>): ResourceDto => ({ id, type: 'finance-product-units', title: String(data.name), status, statusReason: null, data, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' });

describe('管理档案类型', () => {
  it('新增自定义类型：带 kind=archive_type，编码转大写；停用前确认并说明档案保留', async () => {
    r.list.mockResolvedValue({ items: [dto(1, 'active', { kind: 'archive_type', name: '食品添加剂', code: 'SPTJJ' })], total: 1, page: 1, pageSize: 100 } as never);
    r.create.mockResolvedValue({} as never);
    r.changeStatus.mockResolvedValue({} as never);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ArchiveTypeDialog counts={{ SPTJJ: 3 }} onClose={() => undefined} onChanged={() => undefined} />);
    await screen.findByText('食品添加剂');
    expect(r.list).toHaveBeenCalledWith('finance-product-units', expect.objectContaining({ fieldKey: 'kind', fieldValue: 'archive_type' }));
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增档案类型' }));
    fireEvent.change(screen.getByLabelText('类型名称'), { target: { value: '试用品' } });
    fireEvent.change(screen.getByLabelText('编码标识'), { target: { value: 'sy1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(r.create).toHaveBeenCalledWith('finance-product-units', expect.objectContaining({ kind: 'archive_type', name: '试用品', code: 'SY1' })));
    await screen.findByText('食品添加剂');
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    expect(confirm.mock.calls[0][0]).toMatch(/3 条档案保留/);
    await waitFor(() => expect(r.changeStatus).toHaveBeenCalledWith('finance-product-units', 1, 'inactive', expect.any(String)));
  });

  it('档案类型下拉：内置六种后面接自定义类型', () => {
    const f = getResourceDef('finance-products')!.fields.find((x) => x.key === 'archiveType')!;
    resetUnitOptionsForTest({ archive_type: [{ value: 'SPTJJ', label: '食品添加剂' }] });
    const o = fieldOptions(f, {}, { archive_type: [{ value: 'SPTJJ', label: '食品添加剂' }] });
    expect(o.map((x) => x.value)).toEqual(['raw', 'self_made', 'purchased', 'package', 'shipping_material', 'oem_package', 'SPTJJ']);
    resetUnitOptionsForTest({});
  });
});
