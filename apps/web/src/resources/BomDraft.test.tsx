import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { BomDraft, bomCollection, validBomRows, type BomDraftRow } from './BomDraft';

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
  it('新组成只包含选择有效的商品/人工，空占位不提交；切换引用种类清除另一种引用', () => {
    const rows: BomDraftRow[] = [{ kind: 'component', group: 'raw', id: 5, qty: 2, loss: 3 }, { kind: 'labor', group: 'labor', id: 8, qty: 1, loss: '' }, { kind: 'component', group: 'raw', id: null, qty: 1, loss: '' }];
    expect(validBomRows(rows)).toHaveLength(2);
    const collection = bomCollection(rows, []);
    expect(collection.rows).toMatchObject([{ values: { componentId: 5, laborId: null } }, { values: { laborId: 8, componentId: null } }]);
    expect(resourceApi.create).not.toHaveBeenCalled();
  });
});
