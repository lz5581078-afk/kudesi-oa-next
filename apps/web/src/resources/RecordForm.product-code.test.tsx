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
describe('商品档案自动与人工编号', () => {
  it('包装编辑默认自动预览，保存明确请求重算，不把旧编号当人工编号', async () => {
    render(<RecordForm def={def} record={record()} onClose={vi.fn()} onSaved={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: /^(系统自动编号|产品包装编号|OEM包装编号)$/ }) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('AUTO-500G'));
    expect(input.readOnly).toBe(true);
    expect(input.maxLength).toBe(160);
    fireEvent.change(screen.getByLabelText('第1条容量'), { target: { value: '250' } });
    await waitFor(() => expect(input.value).toBe('AUTO-250G'));
    await save();
    expect(vi.mocked(resourceApi.saveForm).mock.calls[0][1].values).toMatchObject({ archiveType: 'package', categoryId: 1, capacities: '250G', code: '' });
  });
  it('点人工修正先保留当前预览，人工编号随实际请求保存', async () => {
    render(<RecordForm def={def} record={record()} onClose={vi.fn()} onSaved={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: /^(系统自动编号|产品包装编号|OEM包装编号)$/ }) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('AUTO-500G'));
    fireEvent.click(screen.getByRole('button', { name: '人工修正' }));
    expect(input.value).toBe('AUTO-500G'); expect(input.readOnly).toBe(false);
    fireEvent.change(input, { target: { value: 'MANUAL-PACKAGE' } });
    await save();
    expect(vi.mocked(resourceApi.saveForm).mock.calls[0][1].values.code).toBe('MANUAL-PACKAGE');
  });
  it('已有原料默认沿用人工编号，真原料入口不额外显示恢复自动操作', async () => {
    render(<RecordForm def={def} record={record('raw')} onClose={vi.fn()} onSaved={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: /^(系统自动编号|产品包装编号|OEM包装编号)$/ }) as HTMLInputElement;
    expect(input.readOnly).toBe(false); expect(input.value).toBe('EXISTING-CODE');
    expect(screen.queryByRole('button',{name:'恢复自动编号'})).toBeNull();
    fireEvent.change(screen.getByLabelText(/^原料名称/),{target:{value:'改名仍保人工编号'}});
    expect(input.readOnly).toBe(false);expect(input.value).toBe('EXISTING-CODE');
  });
  it('自产真实更多设置恢复自动后才重新预览',async()=>{
    render(<RecordForm def={def} record={record('self_made')} onClose={vi.fn()} onSaved={vi.fn()}/>);
    const input=screen.getByRole('textbox',{name:/^(系统自动编号|产品包装编号|OEM包装编号)$/}) as HTMLInputElement;
    expect(input.value).toBe('EXISTING-CODE');
    fireEvent.click(screen.getByText('更多设置',{selector:'summary'}));
    fireEvent.click(screen.getByRole('button',{name:'恢复自动编号'}));
    await waitFor(()=>expect(input.readOnly).toBe(true));await waitFor(()=>expect(input.value).toBe('AUTO-500G'));
  });
});
