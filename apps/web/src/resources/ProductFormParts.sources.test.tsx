import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./RecordForm', () => ({ MoneyControl: () => null, RefSelect: () => null }));
vi.mock('./api', () => ({ resourceApi: { list: vi.fn(), update: vi.fn(), create: vi.fn(), remove: vi.fn() } }));
import { resourceApi } from './api';
import { latestSource, loadSourceRows, saveSourceRows, type SourceRow } from './ProductFormParts';
const row = (over: Partial<SourceRow>): SourceRow => ({ supplierId: 1, originArea: '测试', systemSpec: '斤', purchasePrice: 100, ...over });
afterEach(() => vi.clearAllMocks());
describe('供货来源的采购价时序', () => {
  it('最新预览按采购价时间，跳过停用来源；旧记录回退更新时间', () => {
    const a = row({ rowId: 1, priceUpdatedAt: '2020-01-01', updatedAt: '2026-01-01' });
    const b = row({ rowId: 2, updatedAt: '2021-01-01' });
    expect(latestSource([a, b, row({ stopped: true, priceUpdatedAt: '2027-01-01' })])).toBe(b);
  });
  it('一次保存多条报价时最后提交用户最近修改价格的行，不把行号当最新报价', async () => {
    const a = row({ priceUpdatedAt: '2022-01-01', purchasePrice: 300 });
    const b = row({ priceUpdatedAt: '2021-01-01', purchasePrice: 200 });
    vi.mocked(resourceApi.create).mockResolvedValue({} as never);
    expect(await saveSourceRows(7, [a, b], [], true)).toEqual([]);
    expect(vi.mocked(resourceApi.create).mock.calls.map(call => call[1].purchasePrice)).toEqual([200, 300]);
    expect(resourceApi.create).toHaveBeenLastCalledWith('finance-product-sources', expect.not.objectContaining({ priceUpdatedAt: expect.anything() }));
  });
  it('加载全部页，保留采购价时间、停用状态和供应商显示名', async () => {
    const item = (id: number) => ({ id, status: id === 2 ? 'inactive' : 'active', data: { supplierId: 4, purchasePrice: 100, priceUpdatedAt: '2020-01-01' }, refLabels: { supplierId: '测试供应商' }, updatedAt: '2026-01-01' });
    vi.mocked(resourceApi.list).mockResolvedValueOnce({ items: [item(1)], total: 2 } as never).mockResolvedValueOnce({ items: [item(2)], total: 2 } as never);
    expect(await loadSourceRows(7)).toMatchObject([{ rowId: 1, supplierLabel: '测试供应商', priceUpdatedAt: '2020-01-01', stopped: false }, { rowId: 2, stopped: true }]);
    expect(resourceApi.list).toHaveBeenLastCalledWith('finance-product-sources', expect.objectContaining({ page: 2, fieldValue: 7 }));
  });
});
