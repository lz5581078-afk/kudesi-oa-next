import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { BundlesPage } from './BundlesPage';
import { jstApi } from './jstApi';

vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('../../../resources/RecordDetail', () => ({ RecordDetail: () => <div>组合抽屉</div>, useResourceCan: () => () => true }));
vi.mock('../../../resources/CategoryTree', () => ({ CategoryTree: () => <div /> }));
vi.mock('../../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../../resources/api')>()), resourceApi: { list: vi.fn(), export: vi.fn() } }));
vi.mock('./jstApi', async (orig) => ({ ...(await orig<typeof import('./jstApi')>()), jstApi: { bundleOverview: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const mk = (id: number, type: string, data: Record<string, unknown>, refLabels: Record<string, string> = {}): ResourceDto => ({ id, type, title: String(data.code ?? data.label ?? id), status: 'pending', statusReason: null, data, secretConfigured: {}, refLabels, files: {}, createdAt: '', updatedAt: '' });

describe('商品组合编码页', () => {
  it('可展开构成行（不打开详情）；编码可复制；没结果时可清除搜索', async () => {
    const bundle = mk(7, 'finance-bundles', { code: 'ZH-APPLE-2' });
    const line = mk(70, 'finance-bundle-lines', { role: 'main', qty: 2, unit: '个' }, { baseCodeId: '红富士1KG' });
    vi.mocked(resourceApi.list).mockImplementation(async (type) => (type === 'finance-bundle-lines' ? { items: [line], total: 1, page: 1, pageSize: 100 } : { items: [bundle], total: 1, page: 1, pageSize: 20 }) as never);
    vi.mocked(jstApi.bundleOverview).mockResolvedValue({ status: { pending: 1 } } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<BundlesPage />);
    await screen.findByText('ZH-APPLE-2');
    fireEvent.click(screen.getByRole('button', { name: '复制组合编码' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ZH-APPLE-2'));
    fireEvent.click(screen.getByRole('button', { name: '展开构成' }));
    await screen.findByText(/红富士1KG × 2 个/);
    expect(screen.getByText('主品')).toBeTruthy();
    expect(vi.mocked(resourceApi.list)).toHaveBeenCalledWith('finance-bundle-lines', expect.objectContaining({ fieldKey: 'bundleId', fieldValue: 7 }));
    expect(screen.queryByText('组合抽屉')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起构成' }));
    expect(screen.queryByText(/红富士1KG × 2 个/)).toBeNull();
    vi.mocked(resourceApi.list).mockImplementation(async () => ({ items: [], total: 0, page: 1, pageSize: 20 }) as never);
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '没有' } });
    fireEvent.click(await screen.findByRole('button', { name: '清除搜索和分类' }));
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('');
  });
});
