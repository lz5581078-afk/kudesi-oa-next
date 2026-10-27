import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { BomDraft, saveBomRows, validBomRows, type BomDraftRow } from './BomDraft';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: {} }) }));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), resourceApi: { create: vi.fn(), list: vi.fn().mockResolvedValue({ items: [], total: 0 }) } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('新建商品时直接加生产组成', () => {
  it('点“现在添加”出现一行；能加行、去掉行', () => {
    let rows: BomDraftRow[] = [];
    const { rerender } = render(<BomDraft rows={rows} onChange={(r) => { rows = r; }} />);
    fireEvent.click(screen.getByRole('button', { name: /现在添加/ }));
    expect(rows).toHaveLength(1);
    rerender(<BomDraft rows={rows} onChange={(r) => { rows = r; }} />);
    fireEvent.click(screen.getByRole('button', { name: '＋ 加一行' }));
    expect(rows).toHaveLength(2);
    rerender(<BomDraft rows={rows} onChange={(r) => { rows = r; }} />);
    fireEvent.click(screen.getAllByRole('button', { name: '去掉' })[0]);
    expect(rows).toHaveLength(1);
  });
  it('保存时只建选了组件且数量大于 0 的行；人工行带 laborId；失败的行返回说明', async () => {
    const rows: BomDraftRow[] = [
      { kind: 'component', id: 5, qty: 2, loss: 3 }, { kind: 'labor', id: 8, qty: 1, loss: '' }, { kind: 'component', id: null, qty: 1, loss: '' }, { kind: 'component', id: 6, qty: 0, loss: '' }, { kind: 'component', id: 9, qty: 1, loss: '' },
    ];
    expect(validBomRows(rows)).toHaveLength(3);
    vi.mocked(resourceApi.create).mockImplementation((async (_t: string, v: Record<string, unknown>) => { if (v.componentId === 9) throw new Error('组件已停用'); return {}; }) as never);
    const failed = await saveBomRows(77, rows);
    expect(resourceApi.create).toHaveBeenCalledWith('finance-product-boms', { productId: 77, componentId: 5, qty: 2, lossPercent: 3 });
    expect(resourceApi.create).toHaveBeenCalledWith('finance-product-boms', { productId: 77, laborId: 8, qty: 1 });
    expect(failed).toEqual(['第 3 行：组件已停用']);
  });
});
