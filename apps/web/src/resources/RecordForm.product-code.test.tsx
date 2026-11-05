import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from './api';
import { RecordForm } from './RecordForm';
import { resetUnitOptionsForTest } from './unitOptions';
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('./api', async orig => ({ ...await orig<typeof import('./api')>(), resourceApi: { list: vi.fn(async () => ({ items: [], total: 0 })), saveForm: vi.fn(), similarCheck: vi.fn(async () => ({ blocked: [], warnings: [] })) }, draftApi: { key: vi.fn(() => 'synthetic'), get: vi.fn(async () => ({ draft: null })), remove: vi.fn(async () => ({})) } }));
vi.mock('./CodePreview', async () => {
  const { useEffect } = await import('react');
  return { CodePreview: ({ values, onPreview }: { values: Record<string, unknown>; onPreview: (code: string) => void }) => {
    const key = JSON.stringify(values);
    useEffect(() => { onPreview(String(values.code || `AUTO-${values.capacities || 'RAW'}`)); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
    return null;
  } };

});
const def = getResourceDef('finance-products')!;
const record = (archiveType = 'package'): ResourceDto => ({ id: 7, type: def.key, title: '合成包装', status: 'active', statusReason: null, data: { archiveType, categoryId: 1, name: '合成包装', code: 'EXISTING-CODE', brandId: 2, packagingCategory: 'bag', capacities: '500G', purchaseSpec: '千克', specQty: 1, specUnit: 'KG', weightG: 10, purchasePrice: 100, freight: 1, handlingFee: 1 }, version: 'synthetic-version', refLabels: {}, files: {}, secretConfigured: {}, createdAt: '', updatedAt: '' });
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); resetUnitOptionsForTest({}); vi.mocked(resourceApi.saveForm).mockResolvedValue(record()); });
async function save() { fireEvent.click(screen.getByRole('button', { name: '保存修改' })); fireEvent.click(await screen.findByRole('button', { name: '确认并保存' })); await waitFor(() => expect(resourceApi.saveForm).toHaveBeenCalled()); }
describe('新建生成编码，已保存商品编码固定', () => {
  it('包装编辑保留原编号；改容量也不传空要求重编', async () => {
    render(<RecordForm def={def} record={record()} onClose={vi.fn()} onSaved={vi.fn()} />);
    const input=screen.getByRole('textbox',{name:/^(系统自动编号|产品包装编号|OEM包装编号)$/}) as HTMLInputElement;
    expect(input.value).toBe('EXISTING-CODE');expect(input.readOnly).toBe(true);expect((screen.getByRole('button',{name:'人工修正'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('第1条容量'),{target:{value:'250'}});expect(input.value).toBe('EXISTING-CODE');await save();
    expect(vi.mocked(resourceApi.saveForm).mock.calls[0][1].values).toMatchObject({capacities:'250G',code:'EXISTING-CODE'});
  });
  it.each(['raw','self_made','purchased','shipping_material','package','oem_package'])('已有%s保持原编号且不可人工重编',async family=>{
    render(<RecordForm def={def} record={record(family)} onClose={vi.fn()} onSaved={vi.fn()}/>);
    const input=screen.getByRole('textbox',{name:/^(系统自动编号|产品包装编号|OEM包装编号)$/}) as HTMLInputElement;
    expect(input.value).toBe('EXISTING-CODE');expect(input.readOnly).toBe(true);expect((screen.getByRole('button',{name:'人工修正'}) as HTMLButtonElement).disabled).toBe(true);
    const reset=screen.queryByRole('button',{name:'恢复自动编号'});if(reset)expect((reset as HTMLButtonElement).disabled).toBe(true);
  });
  it('新建与复制新增仍可预览并填写首次编码',async()=>{
    render(<RecordForm def={def} record={null} initial={{...record().data,code:'',__copyOf:7,__copyVersion:'synthetic-version'}} onClose={vi.fn()} onSaved={vi.fn()}/>);
    const input=screen.getByRole('textbox',{name:/^(系统自动编号|产品包装编号|OEM包装编号)$/}) as HTMLInputElement;
    await waitFor(()=>expect(input.value).toBe('AUTO-500G'));expect((screen.getByRole('button',{name:'人工修正'}) as HTMLButtonElement).disabled).toBe(false);fireEvent.click(screen.getByRole('button',{name:'人工修正'}));expect(input.readOnly).toBe(false);fireEvent.change(input,{target:{value:'NEW-PRODUCT-CODE'}});expect(input.value).toBe('NEW-PRODUCT-CODE');
  });
});
