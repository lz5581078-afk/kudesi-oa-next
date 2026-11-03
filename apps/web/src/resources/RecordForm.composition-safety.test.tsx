import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS } from '@kudesi/shared';
import { RecordForm } from './RecordForm';
import { resourceApi, type ResourceDto } from './api';
import { resetUnitOptionsForTest } from './unitOptions';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { companyId: 1, permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('./api', async original => {
  const module = await original<typeof import('./api')>();
  return { ...module, resourceApi: { ...module.resourceApi, list: vi.fn(), get: vi.fn(), saveForm: vi.fn(), similarCheck: vi.fn() }, draftApi: { ...module.draftApi, get: vi.fn().mockResolvedValue({ draft: null }) } };
});
const row = (id: number, type: string, data: Record<string, unknown>): ResourceDto => ({ id, type, title: String(data.name || '合成资料'), data, version: `version-${id}`, status: 'active', statusReason: null, refLabels: {}, files: {}, secretConfigured: {}, createdAt: '', updatedAt: '' });
const def = FINANCE_RESOURCE_DEFS.find(resource => resource.key === 'finance-products')!;
beforeEach(() => {
  vi.clearAllMocks(); resetUnitOptionsForTest({});
  vi.mocked(resourceApi.list).mockImplementation(async type => {
    const items = type === 'finance-product-boms' ? [row(71, type, { productId: 9, componentId: 5, qty: 2 })] : [];
    return { items, total: items.length, page: 1, pageSize: 200 };
  });
  vi.mocked(resourceApi.get).mockResolvedValue(row(5, 'finance-products', { archiveType: 'raw', name: '原有原料', weightG: 1000, totalCost: 100, purchasePrice: 100 }));
});
afterEach(cleanup);

describe('生产组成分区编辑保存安全', () => {
  it('已有行清空倍数时原行仍在，阻止保存而不是忽略该行后提交删除', async () => {
    render(<RecordForm def={def} record={row(9, 'finance-products', { archiveType: 'self_made', name: '合成成品' })} onlyGroup="生产资料与成本" onClose={vi.fn()} onSaved={vi.fn()}/>);
    await waitFor(() => expect((screen.getByRole('spinbutton', { name: '组成数量' }) as HTMLInputElement).value).toBe('2'));
    fireEvent.change(screen.getByRole('spinbutton', { name: '组成数量' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByText('原料、包装和人工明细必须选择档案，并填写大于 0 的倍数')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '搜索原料' })).toBeTruthy();
    expect(resourceApi.saveForm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '确认并保存' })).toBeNull();
  });
  it('新增的空组成行必须先选资料和倍数，不能和旧完整行一起被静默省略', async () => {
    render(<RecordForm def={def} record={row(9, 'finance-products', { archiveType: 'self_made', name: '合成成品' })} onlyGroup="生产资料与成本" onClose={vi.fn()} onSaved={vi.fn()}/>);
    await screen.findByRole('spinbutton', { name: '组成数量' });
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加原料组成' }));
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByText('原料、包装和人工明细必须选择档案，并填写大于 0 的倍数')).toBeTruthy();
    expect(screen.getAllByRole('spinbutton', { name: '组成数量' })).toHaveLength(2);
    expect(resourceApi.saveForm).not.toHaveBeenCalled();
  });
  it('单独编辑供货来源也保留完整性校验，不能省略未填完的来源后保存', async () => {
    render(<RecordForm def={def} record={row(9, 'finance-products', { archiveType: 'raw', name: '合成原料', purchaseSpec: '斤' })} onlyGroup="供货来源" onClose={vi.fn()} onSaved={vi.fn()}/>);
    await waitFor(() => expect(resourceApi.list).toHaveBeenCalledWith('finance-product-sources', expect.objectContaining({ fieldValue: 9 })));
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加供货来源' }));
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByText(/请至少维护一条完整供货来源/)).toBeTruthy();
    expect(resourceApi.saveForm).not.toHaveBeenCalled();
  });
});
