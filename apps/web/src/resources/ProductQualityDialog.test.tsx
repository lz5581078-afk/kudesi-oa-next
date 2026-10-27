import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  resourceApi: { list: vi.fn().mockResolvedValue({ items: [{ title: '产地自提' }, { title: '客户自备' }] }) },
}));
import { ProductQualityDialog } from './ProductQualityDialog';

afterEach(cleanup);
const raw = { archiveType: 'raw', name: '苹果', purchaseSpec: '千克', purchasePrice: 1000, freight: 0, handlingFee: 0 };

describe('核算资料确认：完整面板', () => {
  it('列出采购价、运费、装卸费，填 0 的要写原因才能确认；原因库里的原因可直接选；未完成项目在下方列出', async () => {
    const onConfirm = vi.fn();
    render(<ProductQualityDialog values={raw} options={{ canCost: true }} onCancel={() => undefined} onConfirm={onConfirm} />);
    expect(screen.getByText('采购价')).toBeTruthy();
    expect(screen.getByText('10 元')).toBeTruthy();
    expect(screen.getByText('尚未完成的项目')).toBeTruthy();
    expect(screen.getByText('运费为0，尚未明确确认')).toBeTruthy();
    const confirm = screen.getByRole('button', { name: '确认并保存' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('运费零值原因'), { target: { value: '产地自提' } });
    fireEvent.click(screen.getAllByRole('button', { name: '确认该项为0' })[0]);
    expect(screen.getByText('已确认：产地自提')).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('装卸费零值原因'), { target: { value: ' 客户自备 ' } });
    fireEvent.click(screen.getByRole('button', { name: '确认该项为0' }));
    await waitFor(() => expect(document.querySelectorAll('datalist option')).toHaveLength(2));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm.mock.calls[0][0].zeroValueReason).toMatch(/运费：产地自提/);
    expect(onConfirm.mock.calls[0][0].zeroValueReason).toMatch(/装卸费：客户自备/);
  });

  it('人工修正的重量为 0：确认不计重量；没填的项目要先返回修改', () => {
    render(<ProductQualityDialog values={{ ...raw, purchaseSpec: '', freight: 10, handlingFee: 10, weightManual: true, weightG: 0 }} options={{ canCost: true }} onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(screen.getByText('系统规格未填写')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('重量零值原因'), { target: { value: '赠品不计重' } });
    fireEvent.click(screen.getByRole('button', { name: '确认不计重量' }));
    expect(screen.getByText('已确认：赠品不计重')).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认并保存' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('自制品已有构成但没有包装组成：确认不需要', () => {
    const made = { archiveType: 'self_made', name: '礼盒', brandId: 1, productPackagingSpec: '500G袋', freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' };
    const onConfirm = vi.fn();
    render(<ProductQualityDialog values={made} options={{ canCost: true, composition: { packaging: 0, labor: 1 } }} onCancel={() => undefined} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByLabelText('包装组成零值原因'), { target: { value: '裸装发货' } });
    fireEvent.click(screen.getByRole('button', { name: '确认不需要' }));
    fireEvent.click(screen.getByRole('button', { name: '确认并保存' }));
    expect(onConfirm.mock.calls[0][0].zeroValueReason).toContain('包装组成：裸装发货');
  });
});
