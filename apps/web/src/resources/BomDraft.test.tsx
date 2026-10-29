import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { BomDraft, saveBomRows, validBomRows, type BomDraftRow } from './BomDraft';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: {} }) }));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), resourceApi: { create: vi.fn(), update: vi.fn(), remove: vi.fn(), get: vi.fn(), list: vi.fn().mockResolvedValue({ items: [], total: 0 }) } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('表单里的生产组成（新增和编辑同一个组件）', () => {
  it('按本类有的组分块；能加行、去掉行', () => {
    let rows: BomDraftRow[] = [];
    const { rerender } = render(<BomDraft rows={rows} groups={['raw', 'labor']} onChange={(r) => { rows = r; }} />);
    expect(screen.getByRole('group', { name: '原料组成' })).toBeTruthy();
    expect(screen.getByRole('group', { name: '人工组成' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'OEM 包装' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加原料组成' }));
    expect(rows).toEqual([{ kind: 'component', group: 'raw', id: null, qty: 1, loss: '' }]);
    rerender(<BomDraft rows={rows} groups={['raw', 'labor']} onChange={(r) => { rows = r; }} />);
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加人工组成' }));
    expect(rows[1]).toMatchObject({ kind: 'labor', group: 'labor' });
    rerender(<BomDraft rows={rows} groups={['raw', 'labor']} onChange={(r) => { rows = r; }} />);
    fireEvent.click(screen.getAllByRole('button', { name: '去掉' })[0]);
    expect(rows).toHaveLength(1);
  });
  it('保存时只建选了组件且数量大于 0 的行；人工行带 laborId；失败的行返回说明', async () => {
    const rows: BomDraftRow[] = [
      { kind: 'component', group: 'raw', id: 5, qty: 2, loss: 3 }, { kind: 'labor', group: 'labor', id: 8, qty: 1, loss: '' }, { kind: 'component', group: 'raw', id: null, qty: 1, loss: '' }, { kind: 'component', group: 'raw', id: 6, qty: 0, loss: '' }, { kind: 'component', group: 'package', id: 9, qty: 1, loss: '' },
    ];
    expect(validBomRows(rows)).toHaveLength(3);
    vi.mocked(resourceApi.create).mockImplementation((async (_t: string, v: Record<string, unknown>) => { if (v.componentId === 9) throw new Error('组件已停用'); return {}; }) as never);
    const failed = await saveBomRows(77, rows);
    expect(resourceApi.create).toHaveBeenCalledWith('finance-product-boms', { productId: 77, componentId: 5, qty: 2, lossPercent: 3 });
    expect(resourceApi.create).toHaveBeenCalledWith('finance-product-boms', { productId: 77, laborId: 8, qty: 1 });
    expect(failed).toEqual(['第 3 行：组件已停用']);
  });
  it('编辑：没动的行不重存，改过的更新，去掉的删除，新加的创建', async () => {
    const original: BomDraftRow[] = [
      { kind: 'component', group: 'raw', id: 5, qty: 2, loss: '', rowId: 100 }, { kind: 'component', group: 'raw', id: 6, qty: 1, loss: '', rowId: 101 }, { kind: 'labor', group: 'labor', id: 8, qty: 1, loss: '', rowId: 102 },
    ];
    const next: BomDraftRow[] = [{ ...original[0] }, { ...original[1], qty: 3 }, { kind: 'component', group: 'package', id: 9, qty: 1, loss: '' }];
    vi.mocked(resourceApi.create).mockResolvedValue({} as never);
    vi.mocked(resourceApi.update).mockResolvedValue({} as never);
    vi.mocked(resourceApi.remove).mockResolvedValue({} as never);
    expect(await saveBomRows(77, next, original)).toEqual([]);
    expect(resourceApi.remove).toHaveBeenCalledWith('finance-product-boms', 102, expect.any(String));
    expect(resourceApi.update).toHaveBeenCalledTimes(1);
    expect(resourceApi.update).toHaveBeenCalledWith('finance-product-boms', 101, { productId: 77, componentId: 6, qty: 3, lossPercent: 0 });
    expect(resourceApi.create).toHaveBeenCalledTimes(1);
  });
});
