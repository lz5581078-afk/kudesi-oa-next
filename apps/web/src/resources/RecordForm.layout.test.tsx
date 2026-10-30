import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS, PRODUCT_LAYOUTS, productLayoutKey } from '@kudesi/shared';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const list = vi.fn();
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return {
    ...mod,
    resourceApi: { ...mod.resourceApi, create: (...a: unknown[]) => create(...a), update: (...a: unknown[]) => update(...a), remove: (...a: unknown[]) => remove(...a), similarCheck: vi.fn().mockResolvedValue({ blocked: [], warnings: [] }), list: (...a: unknown[]) => list(...a), get: vi.fn().mockResolvedValue({ id: 1, title: '组件', data: { archiveType: 'raw' } }) },
    draftApi: { ...mod.draftApi, get: vi.fn().mockResolvedValue({ draft: null }), save: vi.fn(), remove: vi.fn() },
  };
});
import { RecordForm } from './RecordForm';

const def = FINANCE_RESOURCE_DEFS.find((d) => d.key === 'finance-products')!;
const saved = { id: 9, type: 'finance-products', title: '苹果', status: 'active', statusReason: null, data: {}, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' };

beforeEach(() => {
  create.mockReset().mockResolvedValue(saved);
  update.mockReset().mockResolvedValue(saved);
  remove.mockReset().mockResolvedValue({});
  list.mockReset().mockImplementation(async (type: string) => (type === 'finance-suppliers' ? { items: [{ id: 3, title: '供应商甲', status: 'active', data: {} }], total: 1 } : { items: [], total: 0 }));
});
afterEach(cleanup);

const TYPES: Array<[string, Record<string, unknown>]> = [
  ['raw', { archiveType: 'raw' }], ['self_made', { archiveType: 'self_made' }], ['purchased_original', { archiveType: 'purchased', supplyMode: 'original_purchase' }], ['purchased_oem', { archiveType: 'purchased', supplyMode: 'supplier_oem' }],
  ['package', { archiveType: 'package' }], ['oem_package', { archiveType: 'oem_package' }], ['shipping_material', { archiveType: 'shipping_material' }], ['custom', { archiveType: 'zz_custom' }],
];

describe('商品档案表单：每种档案类型的分区顺序来自同一份布局', () => {
  it.each(TYPES)('%s：分区标题按布局顺序出现', (key, initial) => {
    expect(productLayoutKey(initial)).toBe(key);
    render(<RecordForm def={def} record={null} initial={initial} onClose={() => undefined} onSaved={() => undefined} />);
    const sections = [...document.querySelectorAll('[data-sec]')].map(el => el.getAttribute('data-sec'));
    const expected = PRODUCT_LAYOUTS[key as keyof typeof PRODUCT_LAYOUTS].sections.filter(s => s.id !== 'gift' && !(key === 'custom' && ['cost','total','photos'].includes(s.id))).map(s => s.id);
    // 分类改为上下文卡片，赠品设置折叠于主表单后，不占用主要编辑区域。
    expect(sections).toEqual(expected);
    expect(document.querySelector('.rf-anchors')).toBeNull();
  });

  it('原料用旧版叫法“原料名称 / 规格 / 名称单位”，必填标星；自产成品的名称规格选填', () => {
    const { unmount } = render(<RecordForm def={def} record={null} initial={{ archiveType: 'raw' }} onClose={() => undefined} onSaved={() => undefined} />);
    expect(screen.getByText('原料名称').parentElement?.textContent).toContain('必填');
    expect(screen.getByText('名称单位').parentElement?.textContent).toContain('必填');
    unmount();
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'self_made' }} onClose={() => undefined} onSaved={() => undefined} />);
    expect(screen.getByText('名称规格').parentElement?.textContent).not.toContain('必填');
    expect(screen.getByText('品牌').parentElement?.textContent).toContain('必填');
  });

  it('必填没填：点保存把每一项标出来，包括供货来源和重量，不发请求', async () => {
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'shipping_material' }} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('请选择最下级分类')).toBeTruthy();
    expect(screen.getByText(/请至少维护一条完整供货来源/)).toBeTruthy();
    expect(screen.getByText('请填写重量')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it('编辑原料：读出已有供货来源行，改了价格只更新这一行，去掉的行删除', async () => {
    list.mockImplementation(async (type: string) => {
      if (type === 'finance-product-sources') return { items: [{ id: 41, status: 'active', data: { supplierId: 3, originArea: '山东', purchasePrice: 125000 } }, { id: 42, status: 'active', data: { supplierId: 3, originArea: '甘肃', purchasePrice: 100000 } }], total: 2 };
      if (type === 'finance-suppliers') return { items: [{ id: 3, title: '供应商甲', status: 'active', data: {} }], total: 1 };
      return { items: [], total: 0 };
    });
    update.mockResolvedValue({ ...saved, id: 7 });
    const record = { ...saved, id: 7, title: '番茄种子', data: { archiveType: 'raw', categoryId: 1, name: '番茄种子', specQty: 500, specUnit: 'G', purchaseSpec: '斤', freight: 100, handlingFee: 50, weightG: 500 } };
    render(<RecordForm def={def} record={record} onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect(screen.getAllByLabelText('产区')).toHaveLength(2));
    fireEvent.change(screen.getAllByLabelText('来源采购价')[0], { target: { value: '13' } });
    fireEvent.click(screen.getAllByRole('button', { name: '去掉' })[1]);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认并保存' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('finance-product-sources', 41, expect.objectContaining({ productId: 7, supplierId: 3, purchasePrice: 1300 })));
    expect(remove).toHaveBeenCalledWith('finance-product-sources', 42, expect.any(String));
    // 档案本身不直接写采购价（由来源汇出）
    expect(update.mock.calls.find((c) => c[0] === 'finance-products')?.[2]).not.toHaveProperty('purchasePrice');
  });

  it('复制新增：带上被复制那条的供货来源（新行，不带行号）', async () => {
    list.mockImplementation(async (type: string) => (type === 'finance-product-sources'
      ? { items: [{ id: 41, status: 'active', data: { supplierId: 3, originArea: '山东', purchasePrice: 125000 } }], total: 1 }
      : type === 'finance-suppliers' ? { items: [{ id: 3, title: '供应商甲', status: 'active', data: {} }], total: 1 } : { items: [], total: 0 }));
    render(<RecordForm def={def} record={null} initial={{ archiveType: 'raw', __copyOf: 7, name: '番茄种子' }} onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect((screen.getByLabelText('产区') as HTMLInputElement).value).toBe('山东'));
  });
});
