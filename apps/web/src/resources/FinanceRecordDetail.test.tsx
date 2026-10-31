import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef, restrictedFieldKeys, createChecker } from '@kudesi/shared';
import { api } from '../api/client';
import { resourceApi, type ResourceDto } from './api';
import { RecordDetail } from './RecordDetail';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] } } };
const saved = vi.fn();
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../api/client', async orig => ({ ...await orig<typeof import('../api/client')>(), api: vi.fn() }));
vi.mock('./RecordForm', () => ({ RecordForm: ({ record, onClose }: { record: ResourceDto; onClose: () => void }) => <div role="dialog" aria-label="编辑资料"><span>{record.title}</span><button onClick={onClose}>取消编辑</button></div>, ReasonDialog: () => null, clearRefCache: () => undefined, loadRefOptions: async () => [] }));
vi.mock('../pages/finance/jst/BundleDialogs', () => ({ RevisionDialog: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="组成修订"><button onClick={onClose}>取消修订</button></div> }));
vi.mock('./api', async orig => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, get: vi.fn(), list: vi.fn(), logs: vi.fn(), relations: vi.fn(), update: vi.fn(), create: vi.fn(), fileUrl: vi.fn() } };
});
const dto = (type: string, id: number, data: Record<string, unknown> = {}): ResourceDto => ({ type, id, data, title: String(data.name || data.code || `资料${id}`), status: 'active', statusReason: null, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' });
const show = (record: ResourceDto, extra: Partial<Parameters<typeof RecordDetail>[0]> = {}) => {
  vi.mocked(resourceApi.get).mockResolvedValue(record);
  return render(<MemoryRouter><RecordDetail def={getResourceDef(record.type)!} id={record.id} onClose={() => {}} onChanged={saved} {...extra} /></MemoryRouter>);
};

beforeEach(() => {
  auth.user.permissions = { isCompanyAdmin: true, allow: [], deny: [] };
  vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
  vi.mocked(resourceApi.logs).mockResolvedValue([]);
  vi.mocked(resourceApi.relations).mockResolvedValue([]);
  vi.mocked(api).mockResolvedValue({ level: 'none', label: '未被引用', items: [] });
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('六类查看入口与源码查看态', () => {
  it.each([
    ['raw', undefined, '原料成品名'], ['self_made', undefined, '生产资料与成本'],
    ['purchased', 'original_purchase', '采购计价'], ['purchased', 'supplier_oem', '供应商OEM组成'],
    ['package', undefined, '容量组'], ['oem_package', undefined, '容量组'],
    ['shipping_material', undefined, '供货来源'], ['custom', undefined, '基础资料'],
  ])('%s/%s 使用独立只读查看分区', async (archiveType, supplyMode, section) => {
    show(dto('finance-products', 1, { archiveType, supplyMode, code: 'DEMO-001', name: '演示商品', specQty: 500, specUnit: 'G', rawFinishedNames: '成品甲\n成品乙', capacities: '500G\n1KG' }));
    await screen.findByRole('heading', { name: '演示商品' });
    expect(screen.getByRole('region', { name: section })).toBeTruthy();
    expect(screen.queryByLabelText('隐藏空字段')).toBeNull();
    expect(screen.queryByText('编辑本区')).toBeNull();
    expect([...document.querySelectorAll<HTMLInputElement>('input')].every(el => el.readOnly || el.disabled)).toBe(true);
    expect(resourceApi.update).not.toHaveBeenCalled();
    expect(resourceApi.create).not.toHaveBeenCalled();
  });

  it.each([['finance-customers', '客户'], ['finance-fee-items', '费用']])('%s 同屏显示分类、状态及操作记录', async (type, label) => {
    vi.mocked(resourceApi.logs).mockResolvedValue([{ id: '1', action: 'create', actor: '', createdAt: '2026-10-30T01:00:00Z', note: '导入旧档案' }]);
    const row = dto(type, 1, { name: '演示档案', code: 'DEMO-1' });
    row.refLabels = { categoryIds: '一级 / 二级 / 客户', categoryId: '费用 / 管理费用' };
    show(row);
    await screen.findByText(`${label}档案操作记录`);
    await screen.findByText('导入旧档案');
    expect(screen.getByText(/系统 ·/)).toBeTruthy();
    expect(screen.getByText(type === 'finance-customers' ? '一级 / 二级 / 客户' : '费用 / 管理费用')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '操作记录' })).toBeNull();
  });

  it('只读供应商仍可复制银行信息，无编辑入口和写请求', async () => {
    auth.user.permissions = { isCompanyAdmin: false, allow: ['resource.finance-suppliers.view'], deny: [] };
    show(dto('finance-suppliers', 1, { name: '演示供应商', bankAccountName: '演示公司', bank: '演示银行', bankAccountNo: 'DEMO-ACCOUNT' }));
    await screen.findByRole('heading', { name: '查看供应商' });
    fireEvent.click(screen.getByRole('button', { name: '复制全部银行信息' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('供应商名称：演示供应商\n账户名称：演示公司\n开户行：演示银行\n银行账号：DEMO-ACCOUNT');
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    expect(resourceApi.update).not.toHaveBeenCalled();
  });

  it('供应来源按更新时间判断最新，停用来源不能占用最新成本标记', async () => {
    const source = (id: number, status: string, time: string) => ({ ...dto('finance-product-sources', id, { originArea: `产区${id}` }), status, updatedAt: time });
    vi.mocked(resourceApi.list).mockImplementation(async type => ({ items: type === 'finance-product-sources' ? [source(1, 'active', '2026-10-01'), source(2, 'inactive', '2026-10-31'), source(3, 'active', '2026-10-20')] : [], total: type === 'finance-product-sources' ? 3 : 0, page: 1, pageSize: 200 }));
    show(dto('finance-products', 9, { archiveType: 'raw', name: '原料甲' }));
    const badge = await screen.findByText('当前最新成本');
    expect(badge.closest('section')?.textContent).toContain('产区3');
    expect(screen.getAllByText('当前最新成本')).toHaveLength(1);
  });
});

describe('编码查看组成与权限', () => {
  it('基础编码马甲读取真实编码的完整分页组成，缺失引用保留原行而非补零', async () => {
    const alias = dto('finance-base-codes', 1, { code: 'ALIAS', name: '别名', canonicalId: 10 });
    const canonical = dto('finance-base-codes', 10, { code: 'REAL', origin: 'composed' });
    const product = dto('finance-products', 20, { code: 'YL-20', name: '原料甲', archiveType: 'raw', totalCost: 120.1234, purchasePrice: 100, weightG: 500 });
    const first = dto('finance-base-code-lines', 30, { productId: 20, qty: 2.5 });
    const second = dto('finance-base-code-lines', 31, { productId: 21, qty: 1 }); second.refLabels.productId = '已失效档案';
    show(alias);
    vi.mocked(resourceApi.get).mockImplementation(async (type, id) => { if (id === 1) return alias; if (id === 10) return canonical; if (id === 20) return product; throw new Error(`不可读 ${type}`); });
    vi.mocked(resourceApi.list).mockImplementation(async (_type, p) => ({ items: p?.page === 1 ? [first] : [second], total: 2, page: p?.page ?? 1, pageSize: 200 }));
    await screen.findByText('共 2 项');
    expect(screen.getByText('已失效档案')).toBeTruthy();
    expect(screen.getByText('¥3.003085')).toBeTruthy();
    expect(resourceApi.list).toHaveBeenCalledWith('finance-base-code-lines', expect.objectContaining({ fieldValue: 10, page: 2 }));
    await screen.findByText('当前没有组合 BOM 或聚水潭普通商品镜像引用。');
  });

  it('组合按主品、包装、赠品、其他和人工分组，赠品售价为零且金额不丢精度', async () => {
    const bundle = dto('finance-bundles', 1, { name: '演示组合', styleCode: 'STYLE+ZP-GIFT*1' });
    const base = dto('finance-base-codes', 20, { name: '基础商品甲', code: 'BASE', cost: 120.1234, salePrice: 345.6789, weightG: 500 });
    const labor = dto('finance-labor-costs', 21, { name: '打包人工', unitPrice: 50, unitName: '次' });
    show(bundle);
    vi.mocked(resourceApi.get).mockImplementation(async (_t, id) => id === 1 ? bundle : id === 20 ? base : labor);
    vi.mocked(resourceApi.list).mockResolvedValue({ items: ['main', 'package', 'gift', 'label', 'labor'].map((role, i) => dto('finance-bundle-lines', 30 + i, { role, qty: 2, ...(role === 'labor' ? { laborId: 21 } : { baseCodeId: 20 }) })), total: 5, page: 1, pageSize: 200 });
    await screen.findByRole('region', { name: '人工' });
    expect(within(screen.getByRole('region', { name: '主商品' })).getByText('¥2.402468')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '赠品' })).getByText('¥0')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '其他组成' })).getByText('基础商品甲')).toBeTruthy();
    expect(screen.getByText('STYLE', { selector: '.finance-code-summary strong' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '修改组成' }));
    expect(screen.getByRole('dialog', { name: '组成修订' })).toBeTruthy();
  });

  it('只有售价查看权限时，展示销售列并隐藏全部成本列', async () => {
    auth.user.permissions = { isCompanyAdmin: false, allow: ['resource.finance-bundles.view', 'product.price.view'], deny: [] };
    const bundle = dto('finance-bundles', 1, { name: '组合甲' });
    show(bundle);
    vi.mocked(resourceApi.get).mockImplementation(async (_type, id) => id === 1 ? bundle : dto('finance-base-codes', 20, { cost: 87654, salePrice: 250 }));
    vi.mocked(resourceApi.list).mockResolvedValue({ items: [dto('finance-bundle-lines', 2, { role: 'main', baseCodeId: 20, qty: 2 })], total: 1, page: 1, pageSize: 200 });
    await screen.findByRole('columnheader', { name: '销售小计' });
    expect(screen.queryByRole('columnheader', { name: '成本小计' })).toBeNull();
    expect(screen.getByText('¥5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '修改组成' })).toBeNull();
    const denied = restrictedFieldKeys(getResourceDef('finance-base-codes')!, createChecker({ isCompanyAdmin: false, allow: ['resource.finance-base-codes.view'], deny: [] }));
    expect(denied).toContain('salePrice');
  });

  it('明细读取失败明确显示错误，不伪装成无组成', async () => {
    vi.mocked(resourceApi.list).mockRejectedValue(new Error('没有读取组成的权限'));
    show(dto('finance-bundles', 1));
    await screen.findByText(/明细读取失败：没有读取组成的权限/);
    expect(screen.queryByText('当前BOM未维护包装组成。')).toBeNull();
  });
});

describe('查看与编辑切换', () => {
  it('从查看进入编辑后取消，返回原查看态；Esc 能关闭查看', async () => {
    const close = vi.fn();
    show(dto('finance-suppliers', 1, { name: '供应商甲' }), { onClose: close });
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    expect(screen.getByRole('dialog', { name: '编辑资料' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
    expect(screen.queryByRole('dialog', { name: '编辑资料' })).toBeNull();
    expect(screen.getByRole('heading', { name: '查看供应商' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('切换记录时，后到的旧请求不会覆盖新记录', async () => {
    let oldResolve!: (r: ResourceDto) => void;
    const old = new Promise<ResourceDto>(r => { oldResolve = r; });
    vi.mocked(resourceApi.get).mockImplementation(async (_type, id) => id === 1 ? old : dto('finance-customers', 2, { name: '新客户' }));
    const props = { def: getResourceDef('finance-customers')!, onClose: () => {}, onChanged: () => {} };
    const view = render(<MemoryRouter><RecordDetail {...props} id={1} /></MemoryRouter>);
    view.rerender(<MemoryRouter><RecordDetail {...props} id={2} /></MemoryRouter>);
    await screen.findByRole('heading', { name: '新客户' });
    await act(async () => { oldResolve(dto('finance-customers', 1, { name: '旧客户' })); await old; });
    expect(screen.getByRole('heading', { name: '新客户' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '旧客户' })).toBeNull();
  });

  it('列表直达子记录页签的入口仍有效，不被初始加载重置成详情', async () => {
    show(dto('finance-products', 1, { name: '商品甲', archiveType: 'raw' }), { initialTab: 'child:finance-product-costs|productId' });
    await waitFor(() => expect(screen.getByRole('tab', { name: '档案成本记录' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByRole('region', { name: '供货来源' })).toBeNull();
  });
});
