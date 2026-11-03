import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { CodePreview } from './CodePreview';

vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('商品编码预览', () => {
  it('填了类型和名称后向服务端要预览；显示将生成的编码；没名称不请求', async () => {
    vi.mocked(api).mockResolvedValue({ code: 'YL-SG-PG', manual: false, notes: ['请选择品牌'], basicInfoFullName: '苹果' });
    const { rerender } = render(<CodePreview values={{ archiveType: 'raw' }} />);
    expect(api).not.toHaveBeenCalled();
    rerender(<CodePreview values={{ archiveType: 'raw', name: '苹果', categoryId: 3, specQty: '1', specUnit: 'KG' }} excludeId={5} />);
    await screen.findByText('YL-SG-PG');
    expect(api).toHaveBeenCalledWith('/finance/products/code-preview', { method: 'POST', body: expect.objectContaining({ archiveType: 'raw', name: '苹果', categoryId: 3, specQty: '1', excludeId: 5 }) });
    expect(screen.getByText('请选择品牌')).toBeTruthy();
  });
  it('文字规格及独立系统规格完整传给预览，系统规格变化触发重新预览', async () => {
    vi.mocked(api).mockResolvedValue({ code: 'WG-SYNTHETIC', manual: false, notes: [], basicInfoFullName: '合成' });
    const values = { archiveType: 'purchased', name: '合成采购', specQty: '净含量2.50g', specUnit: 'EA', purchaseSpec: '袋' };
    const { rerender } = render(<CodePreview values={values} />);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/finance/products/code-preview', { method: 'POST', body: expect.objectContaining({ specQty: '净含量2.50g', purchaseSpec: '袋' }) }));
    rerender(<CodePreview values={{ ...values, purchaseSpec: '盒' }} />);
    await waitFor(() => expect(api).toHaveBeenLastCalledWith('/finance/products/code-preview', { method: 'POST', body: expect.objectContaining({ specQty: '净含量2.50g', purchaseSpec: '盒' }) }));
  });
  it('服务端说编码不合法或被占用时，把原因显示出来', async () => {
    vi.mocked(api).mockRejectedValue(new Error('商品编码 X 已被“苹果”使用'));
    render(<CodePreview values={{ archiveType: 'raw', name: '苹果', code: 'x' }} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已被'));
  });
});
