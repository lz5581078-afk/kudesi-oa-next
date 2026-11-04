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
  it('组合构成可选公司的规格单位与发货单位，列表也显示原名称', () => {
    const unit = FINANCE_RESOURCE_DEFS.find(d => d.key === 'finance-bundle-lines')!.fields.find(f => f.key === 'unit')!;
    resetUnitOptionsForTest({ spec_unit: [{ value: 'TP', label: '托盘' }], shipping_unit: [{ value: 'BAG', label: '旧包材单位' }] });
    render(<FieldInput {...base} type="finance-bundle-lines" field={unit} value="BAG" values={{}} />);
    expect(screen.getByRole('option', { name: '托盘' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '旧包材单位' })).toBeTruthy();
    expect(displayValue(unit, { data: { unit: 'BAG' }, secretConfigured: {}, refLabels: {} } as never)).toBe('旧包材单位');
  });
  it('导入档案同码不同名严格按单位来源选择与显示，旧记录继续原规格单位',()=>{
    resetUnitOptionsForTest({archive_unit:[{value:'SAME',label:'档案专属名称'}],spec_unit:[{value:'SAME',label:'编码规格名称'}],shipping_unit:[{value:'SAME',label:'发货物料名称'}]});
    const onChange=vi.fn();
    const {rerender}=render(<FieldInput {...base} onChange={onChange} field={field('specUnit')} value="SAME" values={{archiveType:'raw',unitDictionaryKind:'archive_unit'}} />);
    expect(screen.getByRole('option',{name:'档案专属名称'})).toBeTruthy();expect(screen.queryByRole('option',{name:'编码规格名称'})).toBeNull();
    expect(displayValue(field('specUnit'),{data:{specUnit:'SAME',archiveType:'raw',unitDictionaryKind:'archive_unit'},refLabels:{},secretConfigured:{}} as never)).toBe('档案专属名称');
    rerender(<FieldInput {...base} field={field('specUnit')} value="SAME" values={{archiveType:'raw'}} />);
    expect(screen.getByRole('option',{name:'编码规格名称'})).toBeTruthy();expect(screen.queryByRole('option',{name:'档案专属名称'})).toBeNull();
    rerender(<FieldInput {...base} field={field('specUnit')} value="SAME" values={{archiveType:'shipping_material'}} />);
    expect(screen.getByRole('option',{name:'发货物料名称'})).toBeTruthy();
  });

});
