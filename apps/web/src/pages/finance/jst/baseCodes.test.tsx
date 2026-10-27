import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { BaseCodesPage } from './BaseCodesPage';
import { jstApi } from './jstApi';

vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('../../../resources/RecordDetail', () => ({ RecordDetail: () => <div>商品档案抽屉</div>, useResourceCan: () => () => true }));
vi.mock('../../../resources/RecordForm', () => ({ RecordForm: ({ initial }: { initial?: Record<string, unknown> }) => <div role="dialog">表单 {JSON.stringify(initial ?? {})}</div> }));
vi.mock('../../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../../resources/api')>()), resourceApi: { list: vi.fn(), export: vi.fn() } }));
vi.mock('./jstApi', async (orig) => ({ ...(await orig<typeof import('./jstApi')>()), jstApi: { baseOverview: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const row: ResourceDto = { id: 1, type: 'finance-base-codes', title: '红富士', status: 'pending', statusReason: null, data: { code: 'SG-PG-HFS-1KG', styleCode: 'SG-PG', name: '红富士', categoryId: 5, weightG: 1000, jstStatus: 'synced' }, secretConfigured: {}, refLabels: { categoryId: '苹果' }, files: {}, createdAt: '', updatedAt: '' };

describe('商品基础编码页', () => {
  it('编码可一键复制；“复制新建”带出分类和重量但不带编码；没结果时可清除搜索', async () => {
    vi.mocked(resourceApi.list).mockImplementation(async (type) => (type === 'finance-base-codes' ? { items: [row], total: 1, page: 1, pageSize: 20 } : { items: [], total: 0, page: 1, pageSize: 200 }) as never);
    vi.mocked(jstApi.baseOverview).mockResolvedValue({ status: { pending: 1 }, byCategory: {} } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<BaseCodesPage />);
    await screen.findByText('SG-PG-HFS-1KG');
    fireEvent.click(screen.getAllByRole('button', { name: /^复制/ }).find((b) => b.getAttribute('aria-label') !== '复制款式编码')!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('SG-PG-HFS-1KG'));
    expect(screen.queryByText('商品档案抽屉')).toBeNull(); // 复制不触发打开详情
    fireEvent.click(screen.getByRole('button', { name: '复制新建' }));
    const dlg = await screen.findByRole('dialog');
    expect(dlg.textContent).toContain('"categoryId":5');
    expect(dlg.textContent).not.toContain('SG-PG-HFS-1KG');
    vi.mocked(resourceApi.list).mockImplementation(async () => ({ items: [], total: 0, page: 1, pageSize: 20 }) as never);
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '没有' } });
    fireEvent.click(await screen.findByRole('button', { name: '清除搜索和分类' }));
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('');
  });
});
