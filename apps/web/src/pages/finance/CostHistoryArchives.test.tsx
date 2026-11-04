import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CostHistoryArchives } from './CostHistoryArchives';
import { resourceApi, type ResourceDto } from '../../resources/api';
const identity = vi.hoisted(() => ({user:{companyId:1,id:1,permissions:{isCompanyAdmin:false,allow:['product.cost.view','product.price.view'],deny:[] as string[]}}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>identity}));
vi.mock('../../resources/api', () => ({ resourceApi: { list: vi.fn(), create: vi.fn(), update: vi.fn() } }));
afterEach(() => { identity.user={companyId:1,id:1,permissions:{isCompanyAdmin:false,allow:['product.cost.view','product.price.view'],deny:[] as string[]}}; cleanup(); vi.clearAllMocks(); });
const resource = (type: string, id: number, data: Record<string, unknown>): ResourceDto => ({ id, type, title: String(data.versionName || data.skuName || data.costName || ''), data, status: 'draft', statusReason: null, refLabels: {}, files: {}, secretConfigured: {}, createdAt: '', updatedAt: '2026-10-24T00:00:00Z' });
const version = resource('finance-cost-versions', 7, { versionName: '合成秋季版本', effectiveFrom: '2026-08-15' });
const list = (items: ResourceDto[], total = items.length) => ({ items, total, page: 1, pageSize: 200 });
describe('旧版成本档案只读入口', () => {
  it('按版本范围显示快照与辅助成本，只读不触发新增/修改，真实空值不被其他字段覆盖', async () => {
    vi.mocked(resourceApi.list).mockImplementation(async (type, query) => {
      if (type === 'finance-cost-versions') return list([version]);
      expect(query.fieldKey).toBe('versionId'); expect(query.fieldValue).toBe(7);
      if (type === 'finance-cost-auxiliary') return list([resource(type, 2, { versionId: 7, costName: '合成辅助成本', amount: 123.4567, unitName: '件', applyScope: '合成范围', note: '合成备注' })]);
      return list([resource(type, 1, { versionId: 7, skuName: '合成SKU', preShipCostCents: 99900, snapshot: { code: 'SYNTHETIC-001', name: '合成SKU', preShipCostCents: null, costIncludingFreightCents: 0, markupPercent: 25, minPriceCents: 123.4567 } })]);
    });
    render(<CostHistoryArchives />);
    await screen.findByText('合成秋季版本');
    fireEvent.click(screen.getByRole('button', { name: '查看档案' }));
    await screen.findByText('SYNTHETIC-001');
    fireEvent.click(screen.getByRole('button', { name: '查看档案' }));
    expect(screen.getByText('SYNTHETIC-001')).toBeTruthy();
    expect(screen.getByText('未设置')).toBeTruthy(); expect(screen.queryByText('¥999.000')).toBeNull();
    expect(screen.getByText('¥0.000')).toBeTruthy(); expect(screen.getByText('25%')).toBeTruthy(); expect(screen.getByText('¥1.234567')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '辅助成本' }));
    await screen.findByText('合成辅助成本'); expect(screen.getByText('合成备注')).toBeTruthy();
    expect(resourceApi.create).not.toHaveBeenCalled(); expect(resourceApi.update).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /新增|编辑|删除/ })).toBeNull();
  });
  it('详情读完所有分页；切换版本后旧响应不能混入', async () => {
    const second = resource('finance-cost-versions', 8, { versionName: '合成第二版本' });
    let finishFirst!: (result: ReturnType<typeof list>) => void;
    vi.mocked(resourceApi.list).mockImplementation(async (type, query) => {
      if (type === 'finance-cost-versions') return list([version, second]);
      if (query.pageSize === 1) return list([], 201);
      if (query.fieldValue === 7) return new Promise(resolve => { finishFirst = resolve; });
      return query.page === 1 ? list([resource(type, 201, { skuName: '第二版本第一页' })], 2) : list([resource(type, 202, { skuName: '第二版本第二页' })], 2);
    });
    render(<CostHistoryArchives />);
    await screen.findByText('合成第二版本');
    fireEvent.click(within(screen.getByText('合成秋季版本').closest('tr')!).getByRole('button', { name: '查看档案' }));
    await waitFor(() => expect(finishFirst).toBeTruthy());
    fireEvent.click(within(screen.getByText('合成第二版本').closest('tr')!).getByRole('button', { name: '查看档案' }));
    await screen.findByText('第二版本第二页');
    finishFirst(list([resource('finance-cost-skus', 1, { skuName: '旧版本过期结果' })]));
    await waitFor(() => expect(screen.queryByText('旧版本过期结果')).toBeNull());
  });
});
