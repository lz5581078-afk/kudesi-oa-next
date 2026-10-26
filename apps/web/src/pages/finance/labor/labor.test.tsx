import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { buildCategoryTree, findNode, subtreeIds } from './CategoryTree';
import { LaborCostPage } from './LaborCostPage';

vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('../../../resources/api', async (orig) => {
  const real = await orig<typeof import('../../../resources/api')>();
  return { ...real, resourceApi: { list: vi.fn(), changeStatus: vi.fn(), update: vi.fn(), remove: vi.fn() } };
});
const m = vi.mocked(resourceApi);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const dto = (id: number, type: string, title: string, data: Record<string, unknown>, status = 'active', refLabels: Record<string, string> = {}): ResourceDto =>
  ({ id, type, title, status, statusReason: null, data, secretConfigured: {}, refLabels, files: {}, createdAt: '', updatedAt: '' });

describe('归档分类树', () => {
  it('按上下级组织，数量含下级；选上级能拿到整棵子树', () => {
    const cats = [dto(1, 'c', '包装车间', {}), dto(2, 'c', '礼盒', { parentId: 1 }), dto(3, 'c', '大礼盒', { parentId: 2 }), dto(4, 'c', '仓库', {})];
    const tree = buildCategoryTree(cats, [3, 3, 4, null]);
    expect(tree.map((n) => [n.name, n.count])).toEqual([['包装车间', 2], ['仓库', 1]]);
    expect(subtreeIds(findNode(tree, 1)!)).toEqual([1, 2, 3]);
  });
});

describe('人力成本表页面', () => {
  it('默认打开默认版本；按归档分类筛项目；零值原因可见；草稿版本可以启用', async () => {
    const versions = [dto(1, 'v', '2026春', { versionCode: 'A', isDefault: true }, 'active'), dto(2, 'v', '2026秋', { versionCode: 'B' }, 'draft')];
    const cats = [dto(10, 'c', '包装', {}), dto(11, 'c', '分拣', {})];
    const items = [
      dto(100, 'i', '包装/装盒', { workCode: 'RL-A-BZ-BZ-ZH', workName: '装盒', unitPrice: 150, archiveCategoryId: 10 }, 'active', { archiveCategoryId: '包装', workTypeId: '包装', unitId: '元/个' }),
      dto(101, 'i', '分拣/挑果', { workCode: 'RL-A-FJ-FJ-TG', workName: '挑果', unitPrice: 0, zeroReason: '外包赠送', archiveCategoryId: 11 }, 'active', { archiveCategoryId: '分拣', workTypeId: '分拣', unitId: '元/个' }),
    ];
    m.list.mockImplementation(async (type) => {
      const pick = type === 'finance-labor-versions' ? versions : type === 'finance-labor-categories' ? cats : type === 'finance-labor-costs' ? items : [];
      return { items: pick, total: pick.length, page: 1, pageSize: 200 };
    });
    m.changeStatus.mockResolvedValue(versions[1]);
    render(<LaborCostPage />);
    await screen.findByText('RL-A-BZ-BZ-ZH');
    expect(screen.getByText('外包赠送')).toBeTruthy();
    expect(screen.getByText('¥1.50')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^分拣/ }));
    expect(screen.queryByText('RL-A-BZ-BZ-ZH')).toBeNull();
    expect(screen.getByText('RL-A-FJ-FJ-TG')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('成本版本'), { target: { value: '2' } });
    fireEvent.click(await screen.findByRole('button', { name: '启用版本' }));
    await waitFor(() => expect(m.changeStatus).toHaveBeenCalledWith('finance-labor-versions', 2, 'active'));
  });
});
