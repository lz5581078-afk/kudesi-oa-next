import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  resourceApi: { list: vi.fn().mockResolvedValue({ items: [{ title: '产地自提' }, { title: '客户自备' }] }) },
}));
import { ProductQualityDialog, mergeZeroReasons, parseZeroReasons, zeroItemsMissingReason } from './ProductQualityDialog';

afterEach(cleanup);

describe('核算资料确认：零值说明', () => {
  it('只找填了 0 又没写原因的项目', () => {
    expect(zeroItemsMissingReason({ purchasePrice: 1000, freight: 0, handlingFee: 0 }).map((m) => m.label)).toEqual(['运费', '装卸费']);
    expect(zeroItemsMissingReason({ freight: 0, handlingFee: 0, zeroValueReason: '运费：自提\n装卸费：  ' }).map((m) => m.label)).toEqual(['装卸费']);
    expect(zeroItemsMissingReason({ freight: 0, zeroValueReason: '运费:自提' })).toEqual([]);
    expect(zeroItemsMissingReason({ freight: 100, handlingFee: '' })).toEqual([]);
  });

  it('原因写回“零值说明”：每项一行，别的行原样保留', () => {
    expect(mergeZeroReasons('运费：旧\n备注一句', { 运费: '自提', 装卸费: '无' })).toBe('运费：自提\n装卸费：无\n备注一句');
    expect(parseZeroReasons('运费：自提\n装卸费：无')).toEqual({ 运费: '自提', 装卸费: '无' });
  });

  it('每个 0 都要选或写原因才能确认；原因库里的原因可直接选', async () => {
    const onConfirm = vi.fn();
    render(<ProductQualityDialog body={{ name: '苹果', purchasePrice: 1000, freight: 0, handlingFee: 0 }} missing={[{ key: 'freight', label: '运费' }, { key: 'handlingFee', label: '装卸费' }]} onCancel={() => undefined} onConfirm={onConfirm} />);
    const confirm = screen.getByRole('button', { name: '确认并保存' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('运费零值原因'), { target: { value: '产地自提' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('装卸费零值原因'), { target: { value: ' 客户自备 ' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(document.querySelectorAll('datalist option')).toHaveLength(2));
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ 运费: '产地自提', 装卸费: '客户自备' });
  });
});
