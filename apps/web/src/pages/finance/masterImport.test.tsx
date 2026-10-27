import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from '../../resources/api';
import { MasterImportPage } from './MasterImportPage';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../../resources/ImportDialog', () => ({ ImportDialog: () => <div /> }));
vi.mock('../../resources/api', async (orig) => ({ ...(await orig<typeof import('../../resources/api')>()), resourceApi: { list: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('商品数据导入页', () => {
  it('已有数据的步骤标“已导入”，第一个没做完的步骤标“下一步”', async () => {
    vi.mocked(resourceApi.list).mockImplementation(async (type) => ({ items: [], total: type === 'finance-categories' ? 12 : 0, page: 1, pageSize: 1 }) as never);
    render(<MemoryRouter><MasterImportPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('已导入')).toBeTruthy());
    const next = screen.getByText('下一步').closest('li')!;
    expect(next.textContent).toContain('2. 品牌');
    expect(next.getAttribute('aria-current')).toBe('step');
  });
});
