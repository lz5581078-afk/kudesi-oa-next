import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS } from '@kudesi/shared';

const apiMock = vi.fn();
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: (...a: unknown[]) => apiMock(...a) }));
import { FieldInput } from './RecordForm';
import { displayValue } from './format';
import { resetUnitOptionsForTest } from './unitOptions';

const product = FINANCE_RESOURCE_DEFS.find((d) => d.key === 'finance-products')!;
const field = (k: string) => product.fields.find((f) => f.key === k)!;
const base = { type: 'finance-products', known: {}, onKnown: () => undefined, onChange: () => undefined };

afterEach(() => { cleanup(); apiMock.mockReset(); resetUnitOptionsForTest({}); });

describe('商品档案的单位下拉读公司维护的列表', () => {
  it('公司维护了就只列公司的；发货物料读“发货物料规格单位”', async () => {
    resetUnitOptionsForTest({ spec_unit: [{ value: 'TP', label: '托盘' }], shipping_unit: [{ value: 'ROLL', label: '卷' }] });
    apiMock.mockResolvedValue({ spec_unit: [{ value: 'TP', label: '托盘' }], shipping_unit: [{ value: 'ROLL', label: '卷' }] });
    const { rerender } = render(<FieldInput {...base} field={field('specUnit')} value="" values={{ archiveType: 'raw' }} />);
    await waitFor(() => expect(screen.getByRole('option', { name: '托盘' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: '千克' })).toBeNull();
    rerender(<FieldInput {...base} field={field('specUnit')} value="" values={{ archiveType: 'shipping_material' }} />);
    expect(screen.getByRole('option', { name: '卷' })).toBeTruthy();
  });

  it('没维护时退回内置选项；历史值不在列表里也保留显示', () => {
    apiMock.mockResolvedValue({});
    render(<FieldInput {...base} field={field('dimensionUnit')} value="in" values={{}} />);
    expect(screen.getByRole('option', { name: '毫米' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'in' })).toBeTruthy();
  });

  it('列表和详情把编码显示成名称', () => {
    resetUnitOptionsForTest({ spec_unit: [{ value: 'TP', label: '托盘' }] });
    const dto = { data: { specUnit: 'TP', archiveType: 'raw' }, secretConfigured: {}, refLabels: {} } as never;
    expect(displayValue(field('specUnit'), dto)).toBe('托盘');
  });
});
